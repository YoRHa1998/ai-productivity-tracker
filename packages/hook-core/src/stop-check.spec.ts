import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FOLLOWUP_REASON, runStopCheck } from './stop-check.js'
import {
  RECENT_ATTACH_WINDOW_MS,
  recentAttachSentinelPath,
  writeRecentAttachSentinel
} from './lib/sentinel.js'

interface Env {
  workspace: string
  agentRoot: string
}

function setupGitRepo(branchName: string): Env {
  const workspace = mkdtempSync(join(tmpdir(), 'aip-stop-ws-'))
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: workspace })
  writeFileSync(join(workspace, 'a.txt'), 'x')
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspace })
  execFileSync('git', ['checkout', '-q', '-b', branchName], { cwd: workspace })
  return { workspace, agentRoot: mkdtempSync(join(tmpdir(), 'aip-stop-agent-')) }
}

function seedRequirement(agentRoot: string, jiraKey: string) {
  // v1.0 改造:新根 ~/.ai-productivity-tracker/data/<jiraKey>/(原 ai-productivity 子目录改名 data)
  const dir = join(agentRoot, 'data', jiraKey)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'requirement.json'), '{}')
}

function cursorPayload(env: Env, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'completed',
    loop_count: 0,
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    cursor_version: '1.7.2',
    workspace_roots: [env.workspace],
    hook_event_name: 'Stop',
    ...overrides
  })
}

function claudePayload(env: Env, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-9',
    transcript_path: '/tmp/fake.jsonl',
    stop_hook_active: false,
    hook_event_name: 'Stop',
    workspace_roots: [env.workspace],
    ...overrides
  })
}

describe('runStopCheck — Cursor 方言(v2.13.0 jiraKey-recent-attach, 90s 窗)', () => {
  let env: Env
  beforeEach(() => {
    env = setupGitRepo('feature/INSTANT-200-foo')
    seedRequirement(env.agentRoot, 'INSTANT-200')
  })
  afterEach(() => {
    rmSync(env.workspace, { recursive: true, force: true })
    rmSync(env.agentRoot, { recursive: true, force: true })
  })

  it('sentinel 不存在 → 注入 followup_message', async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('inject_followup')
    expect(outcome.dialect).toBe('cursor')
    const parsed = JSON.parse(outcome.output!) as { followup_message: string }
    expect(parsed.followup_message).toBe(FOLLOWUP_REASON)
  })

  it('sentinel 存在且在 90s 窗内 → 放行(allowed_recent_attach)', async () => {
    const at = new Date('2026-05-21T03:00:00.000Z')
    writeRecentAttachSentinel('INSTANT-200', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('allowed_recent_attach')
    expect(outcome.output).toBeNull()
  })

  it('v2.13.0 回归:attach_summary 调用 21s 后才 end_turn(老 10s 窗会误 block) → 仍放行', async () => {
    // INSTANT-5321 实测 calledAt=06:27:31.991 → end_turn=06:27:53.401,diff=21.41s。
    // v2.12.0 之前的 10s 窗在此 case 下注入 followup,LLM 被强制重答 → #4 重复 iteration。
    const at = new Date('2026-05-21T06:27:31.991Z')
    writeRecentAttachSentinel('INSTANT-200', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      now: () => at.getTime() + 21_410
    })
    expect(outcome.kind).toBe('allowed_recent_attach')
  })

  it('sentinel 存在但已超 90s 窗 → 注入 followup', async () => {
    const at = new Date('2026-05-21T03:00:00.000Z')
    writeRecentAttachSentinel('INSTANT-200', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      now: () => at.getTime() + RECENT_ATTACH_WINDOW_MS + 1
    })
    expect(outcome.kind).toBe('inject_followup')
  })

  it('sentinel calledAt 字段非法 ISO → 注入 followup(防 corrupt)', async () => {
    // 先用合法 write 把 hook-state 目录创出来,再覆盖文件成非法 calledAt
    writeRecentAttachSentinel('INSTANT-200', new Date(), env.agentRoot)
    writeFileSync(
      recentAttachSentinelPath('INSTANT-200', env.agentRoot),
      JSON.stringify({ jiraKey: 'INSTANT-200', calledAt: 'not-a-date' }),
      'utf-8'
    )
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('inject_followup')
  })

  it('loop_count >= 1 → 放行,避免死循环', async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env, { loop_count: 1 }),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_loop_guard')
  })

  it('分支不含 issueKey → 放行(普通项目零打扰)', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'plain-branch'], { cwd: env.workspace })
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_no_issue_key')
  })

  it('需求未 init → 放行', async () => {
    rmSync(join(env.agentRoot, 'data', 'INSTANT-200'), { recursive: true, force: true })
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_requirement_missing')
  })

  it('agent 不可达 → 放行', async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      agentEndpoint: null
    })
    expect(outcome.kind).toBe('skipped_agent_unreachable')
  })

  it('agent ping 5xx → 放行', async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      agentEndpoint: { baseUrl: 'http://x', token: 't' },
      fetchImpl: (async () => new Response('err', { status: 500 })) as unknown as typeof fetch
    })
    expect(outcome.kind).toBe('skipped_agent_unreachable')
  })

  it('agent ping 200 + sentinel 不存在 → 注入 followup', async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      agentEndpoint: { baseUrl: 'http://x', token: 't' },
      fetchImpl: (async () =>
        new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    })
    expect(outcome.kind).toBe('inject_followup')
  })
})

describe('runStopCheck — Claude Code 方言(v2.13.0 jiraKey-recent-attach, 90s 窗)', () => {
  let env: Env
  beforeEach(() => {
    env = setupGitRepo('feature/INSTANT-201-bar')
    seedRequirement(env.agentRoot, 'INSTANT-201')
  })
  afterEach(() => {
    rmSync(env.workspace, { recursive: true, force: true })
    rmSync(env.agentRoot, { recursive: true, force: true })
  })

  it('sentinel 不存在 + 首次 → 输出 decision:block', async () => {
    const outcome = await runStopCheck({
      stdin: claudePayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('inject_followup')
    expect(outcome.dialect).toBe('claude-code')
    const parsed = JSON.parse(outcome.output!) as { decision: string; reason: string }
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toBe(FOLLOWUP_REASON)
  })

  it('stop_hook_active=true → 放行', async () => {
    const outcome = await runStopCheck({
      stdin: claudePayload(env, { stop_hook_active: true }),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_loop_guard')
  })

  it('对应 jiraKey sentinel 存在 → 放行(跨方言共用 jiraKey 维度)', async () => {
    const at = new Date('2026-05-21T04:00:00.000Z')
    writeRecentAttachSentinel('INSTANT-201', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: claudePayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      now: () => at.getTime() + 1_000
    })
    expect(outcome.kind).toBe('allowed_recent_attach')
  })
})

describe('runStopCheck — 异常输入', () => {
  it('空 stdin → 静默放行', async () => {
    const outcome = await runStopCheck({ stdin: '', skipAgentReachability: true })
    expect(outcome.kind).toBe('skipped_no_stdin')
  })
  it('非法 JSON → 静默放行', async () => {
    const outcome = await runStopCheck({ stdin: 'not-json', skipAgentReachability: true })
    expect(outcome.kind).toBe('skipped_parse_failed')
  })
})
