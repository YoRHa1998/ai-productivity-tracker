import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FOLLOWUP_REASON, LESSON_HINT_REASON, runStopCheck } from './stop-check.js'
import {
  RECENT_ATTACH_WINDOW_MS,
  recentAttachSentinelPath,
  writeRecentAttachSentinel,
  readLessonHandledSentinel,
  writeLessonHandledSentinel
} from './lib/sentinel.js'

interface Env {
  workspace: string
  agentRoot: string
}

interface CandidateShape {
  seq: number | null
  strongCandidate: boolean
  reasons?: string[]
}

/**
 * 构造一个按 URL 路由的 fetch:
 *   - `/latest-candidate` → 返回注入的候选(默认无候选)
 *   - 其余(`/status` ping)→ 200
 * 让 recent-attach 命中后的 per-turn 兜底路径在测试里完全可控,不触真实 daemon。
 */
function makeFetch(candidate?: CandidateShape): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url)
    if (u.includes('/latest-candidate')) {
      const data: CandidateShape = candidate ?? { seq: null, strongCandidate: false, reasons: [] }
      return new Response(JSON.stringify({ code: 'OK', message: 'ok', data }), { status: 200 })
    }
    return new Response('{"ok":true}', { status: 200 })
  }) as unknown as typeof fetch
}

const STUB_ENDPOINT = { baseUrl: 'http://x', token: 't' }

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

  it('sentinel 存在且在 90s 窗内 + 无强候选 → 放行(allowed_no_candidate)', async () => {
    const at = new Date('2026-05-21T03:00:00.000Z')
    writeRecentAttachSentinel('INSTANT-200', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch(),
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('allowed_no_candidate')
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
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch(),
      now: () => at.getTime() + 21_410
    })
    // attach 正常(不再 inject_followup);无强候选 → allowed_no_candidate
    expect(outcome.kind).toBe('allowed_no_candidate')
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

  // v1.0.0-rc.11: Cursor stop hook 在用户手动中断时也会触发,payload `status` 字段值为
  // 'aborted' / 'error'.我们必须静默放行,不能 inject followup_message,否则 Cursor 会
  // 把它当作下一轮 user prompt 自动 submit,LLM 被强制重答,违背用户中断意图.
  it("status='aborted' → 静默放行(skipped_aborted),不输出 followup", async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env, { status: 'aborted' }),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_aborted')
    expect(outcome.dialect).toBe('cursor')
    expect(outcome.output).toBeNull()
  })

  it("status='error' → 静默放行(skipped_aborted)", async () => {
    const outcome = await runStopCheck({
      stdin: cursorPayload(env, { status: 'error' }),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_aborted')
    expect(outcome.output).toBeNull()
  })

  it("status='aborted' 优先级高于 sentinel 缺失 → 不 inject followup", async () => {
    // 即使 sentinel 缺失(原本会 inject_followup),只要 status=aborted 就立即放行
    const outcome = await runStopCheck({
      stdin: cursorPayload(env, { status: 'aborted', loop_count: 0 }),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    expect(outcome.kind).toBe('skipped_aborted')
  })

  it('老 Cursor 兼容:payload 缺 status 字段时 → 仍走原逻辑(回归保护)', async () => {
    const payload = JSON.parse(cursorPayload(env)) as Record<string, unknown>
    delete payload.status
    const outcome = await runStopCheck({
      stdin: JSON.stringify(payload),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true
    })
    // sentinel 缺失 → 仍 inject_followup,功能不退化
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

  it('对应 jiraKey sentinel 存在 + 无强候选 → 放行(跨方言共用 jiraKey 维度)', async () => {
    const at = new Date('2026-05-21T04:00:00.000Z')
    writeRecentAttachSentinel('INSTANT-201', at, env.agentRoot)
    const outcome = await runStopCheck({
      stdin: claudePayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch(),
      now: () => at.getTime() + 1_000
    })
    expect(outcome.kind).toBe('allowed_no_candidate')
  })
})

describe('runStopCheck — per-turn 经验沉淀兜底(v2.15.0 inject_lesson_hint)', () => {
  let env: Env
  beforeEach(() => {
    env = setupGitRepo('feature/INSTANT-300-lesson')
    seedRequirement(env.agentRoot, 'INSTANT-300')
  })
  afterEach(() => {
    rmSync(env.workspace, { recursive: true, force: true })
    rmSync(env.agentRoot, { recursive: true, force: true })
  })

  function recentAttach(at = new Date('2026-05-21T03:00:00.000Z')) {
    writeRecentAttachSentinel('INSTANT-300', at, env.agentRoot)
    return at
  }

  it('attach 正常 + 上一轮强候选 + 未 handled → inject_lesson_hint(Cursor)', async () => {
    const at = recentAttach()
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch({
        seq: 7,
        strongCandidate: true,
        reasons: ['本轮异常中断: max_tokens']
      }),
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('inject_lesson_hint')
    expect(outcome.dialect).toBe('cursor')
    const parsed = JSON.parse(outcome.output!) as { followup_message: string }
    expect(parsed.followup_message).toContain(LESSON_HINT_REASON)
    expect(parsed.followup_message).toContain('max_tokens')
    // 命中后写下 handled sentinel,保证同一 seq 只打扰一次
    expect(readLessonHandledSentinel('INSTANT-300', 7, env.agentRoot)).not.toBeNull()
  })

  it('attach 正常 + 强候选 + 未 handled → inject_lesson_hint(Claude decision:block)', async () => {
    const at = recentAttach()
    const outcome = await runStopCheck({
      stdin: claudePayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch({ seq: 7, strongCandidate: true, reasons: [] }),
      now: () => at.getTime() + 5_000
    })
    expect(outcome.dialect).toBe('claude-code')
    expect(outcome.kind).toBe('inject_lesson_hint')
    const parsed = JSON.parse(outcome.output!) as { decision: string; reason: string }
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toContain(LESSON_HINT_REASON)
  })

  it('同候选已 handled → allowed_no_candidate(只打扰一次)', async () => {
    const at = recentAttach()
    writeLessonHandledSentinel('INSTANT-300', 7, new Date(), env.agentRoot)
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch({ seq: 7, strongCandidate: true, reasons: ['x'] }),
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('allowed_no_candidate')
    expect(outcome.output).toBeNull()
  })

  it('attach 漏调时优先 inject_followup,绝不叠加 lesson hint', async () => {
    // 不写 recent-attach sentinel → attach 漏调;即便 latest-candidate 是强候选也只走 followup
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch({ seq: 7, strongCandidate: true, reasons: ['x'] })
    })
    expect(outcome.kind).toBe('inject_followup')
    const parsed = JSON.parse(outcome.output!) as { followup_message: string }
    expect(parsed.followup_message).toBe(FOLLOWUP_REASON)
    // 漏调路径不应写 lesson-handled sentinel
    expect(readLessonHandledSentinel('INSTANT-300', 7, env.agentRoot)).toBeNull()
  })

  it('非强候选 → allowed_no_candidate', async () => {
    const at = recentAttach()
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: makeFetch({ seq: 7, strongCandidate: false, reasons: [] }),
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('allowed_no_candidate')
  })

  it('latest-candidate 查询失败(网络错误)→ fail-open allowed_no_candidate', async () => {
    const at = recentAttach()
    const failFetch = (async (url: unknown) => {
      if (String(url).includes('/latest-candidate')) throw new Error('boom')
      return new Response('{"ok":true}', { status: 200 })
    }) as unknown as typeof fetch
    const outcome = await runStopCheck({
      stdin: cursorPayload(env),
      agentRootOverride: env.agentRoot,
      skipAgentReachability: true,
      agentEndpoint: STUB_ENDPOINT,
      fetchImpl: failFetch,
      now: () => at.getTime() + 5_000
    })
    expect(outcome.kind).toBe('allowed_no_candidate')
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
