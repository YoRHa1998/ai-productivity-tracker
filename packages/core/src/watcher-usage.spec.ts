import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { TranscriptWatcher } from './transcript-watcher.js'
import { CodexWatcher } from './codex-watcher.js'
import {
  readAiUsage,
  setAiUsageEnabled,
  __resetAiUsageCacheForTest
} from './store/ai-usage-store.js'
import { listIterations } from './store/iteration-store.js'
import { saveRequirement } from './store/requirement-store.js'
import { upsertBinding } from './bindings.js'

/**
 * Section 3 验收:Claude / Codex watcher 的「AI 整体用量」旁路。
 * - 非 Jira 分支(main)会话仍计入整体用量
 * - 关闭开关不写
 * - 需求维度采集行为不受影响(Jira 分支既写 iteration 又计整体用量)
 * - token 细分正确
 */

function gitInit(repoRoot: string, branch: string): void {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: repoRoot })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: repoRoot }
  )
}

function claudeAssistantLine(opts: {
  cwd: string
  gitBranch: string
  input: number
  output: number
  cacheCreation?: number
  cacheRead?: number
  sessionId?: string
  timestamp?: string
}): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: 'u-' + Math.random().toString(16).slice(2, 8),
      sessionId: opts.sessionId ?? 's-1',
      cwd: opts.cwd,
      gitBranch: opts.gitBranch,
      timestamp: opts.timestamp ?? '2026-06-23T03:26:38.071Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        stop_reason: 'end_turn',
        id: 'msg_' + Math.random().toString(16).slice(2, 14),
        usage: {
          input_tokens: opts.input,
          output_tokens: opts.output,
          cache_creation_input_tokens: opts.cacheCreation ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0
        }
      }
    }) + '\n'
  )
}

describe('TranscriptWatcher AI 用量旁路', () => {
  let claudeRoot: string
  let stateDir: string
  let repoRoot: string
  let aipRootDir: string
  let originalAipRoot: string | undefined

  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), 'aip-cu-claude-'))
    stateDir = mkdtempSync(join(tmpdir(), 'aip-cu-state-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'aip-cu-repo-'))
    aipRootDir = mkdtempSync(join(tmpdir(), 'aip-cu-data-'))
    originalAipRoot = process.env.AIPT_DATA_ROOT
    process.env.AIPT_DATA_ROOT = aipRootDir
    __resetAiUsageCacheForTest()
  })

  afterEach(() => {
    rmSync(claudeRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(aipRootDir, { recursive: true, force: true })
    if (originalAipRoot !== undefined) process.env.AIPT_DATA_ROOT = originalAipRoot
    else delete process.env.AIPT_DATA_ROOT
    __resetAiUsageCacheForTest()
  })

  function makeWatcher(): TranscriptWatcher {
    return new TranscriptWatcher({
      claudeProjectsDir: claudeRoot,
      statePath: join(stateDir, 'state.json')
    })
  }

  it('非 Jira 分支(main)仍计入整体用量,token 细分正确', async () => {
    gitInit(repoRoot, 'main')
    setAiUsageEnabled(true, aipRootDir)
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(
      f,
      claudeAssistantLine({
        cwd: repoRoot,
        gitBranch: 'main',
        input: 100,
        output: 20,
        cacheCreation: 30,
        cacheRead: 500
      })
    )
    await makeWatcher().processFileForTest(f)

    const usage = readAiUsage(aipRootDir)
    const day = Object.keys(usage.daily['claude-code'] ?? {})[0]
    const bucket = usage.daily['claude-code'][day]
    expect(bucket.input).toBe(100)
    expect(bucket.output).toBe(20)
    expect(bucket.cacheCreation).toBe(30)
    expect(bucket.cacheRead).toBe(500)
    // 有效 total = input + output + cacheCreation(剔除 cacheRead)
    expect(bucket.total).toBe(150)
    expect(bucket.turns).toBe(1)
    expect(bucket.models['claude-opus-4-8'].turns).toBe(1)
  })

  it('关闭开关不写整体用量', async () => {
    gitInit(repoRoot, 'main')
    setAiUsageEnabled(false, aipRootDir)
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(
      f,
      claudeAssistantLine({ cwd: repoRoot, gitBranch: 'main', input: 100, output: 20 })
    )
    await makeWatcher().processFileForTest(f)
    expect(readAiUsage(aipRootDir).daily['claude-code']).toBeUndefined()
  })

  it('Jira 分支:既写 iteration 又计整体用量', async () => {
    gitInit(repoRoot, 'feature/ABC-9-x')
    saveRequirement({ jiraKey: 'ABC-9', title: 'demo' }, { repoPath: repoRoot })
    upsertBinding(repoRoot, 'ABC-9', {
      branch: 'feature/ABC-9-x',
      startedAt: '2026-06-23T00:00:00.000Z',
      requirementStartedAt: '2026-06-23T00:00:00.000Z'
    })
    setAiUsageEnabled(true, aipRootDir)
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(
      f,
      claudeAssistantLine({ cwd: repoRoot, gitBranch: 'feature/ABC-9-x', input: 40, output: 10 })
    )
    await makeWatcher().processFileForTest(f)

    expect(listIterations('ABC-9').length).toBe(1)
    const usage = readAiUsage(aipRootDir)
    const day = Object.keys(usage.daily['claude-code'] ?? {})[0]
    expect(usage.daily['claude-code'][day].total).toBe(50)
  })
})

describe('CodexWatcher AI 用量旁路', () => {
  let codexRoot: string
  let stateDir: string
  let repoRoot: string
  let aipRootDir: string
  let originalAipRoot: string | undefined

  beforeEach(() => {
    codexRoot = mkdtempSync(join(tmpdir(), 'aip-cxu-'))
    stateDir = mkdtempSync(join(tmpdir(), 'aip-cxu-state-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'aip-cxu-repo-'))
    aipRootDir = mkdtempSync(join(tmpdir(), 'aip-cxu-data-'))
    originalAipRoot = process.env.AIPT_DATA_ROOT
    process.env.AIPT_DATA_ROOT = aipRootDir
    __resetAiUsageCacheForTest()
  })

  afterEach(() => {
    rmSync(codexRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(aipRootDir, { recursive: true, force: true })
    if (originalAipRoot !== undefined) process.env.AIPT_DATA_ROOT = originalAipRoot
    else delete process.env.AIPT_DATA_ROOT
    __resetAiUsageCacheForTest()
  })

  function makeWatcher(): CodexWatcher {
    return new CodexWatcher({
      codexSessionsDir: codexRoot,
      statePath: join(stateDir, 'codex-state.json')
    })
  }

  function writeSession(lines: string[]): string {
    const dir = join(codexRoot, '2026', '06', '23')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'rollout-x.jsonl')
    writeFileSync(f, lines.join(''))
    return f
  }

  function meta(cwd: string, branch: string): string {
    return (
      JSON.stringify({
        timestamp: '2026-06-23T11:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sess-x', cwd, git: { branch } }
      }) + '\n'
    )
  }
  function tokenCount(input: number, cached: number, output: number, ts: string): string {
    return (
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              total_tokens: input + output
            }
          }
        }
      }) + '\n'
    )
  }
  function boundary(kind: string, ts: string): string {
    return JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: kind } }) + '\n'
  }

  it('非 Jira 分支(main)仍计入整体用量,token 细分(非缓存 input/cacheRead)正确', async () => {
    gitInit(repoRoot, 'main')
    setAiUsageEnabled(true, aipRootDir)
    const f = writeSession([
      meta(repoRoot, 'main'),
      boundary('task_started', '2026-06-23T11:00:01.000Z'),
      boundary('user_message', '2026-06-23T11:00:02.000Z'),
      tokenCount(1000, 800, 200, '2026-06-23T11:00:03.000Z'),
      boundary('task_complete', '2026-06-23T11:00:04.000Z')
    ])
    await makeWatcher().processFileForTest(f)

    const usage = readAiUsage(aipRootDir)
    const bucket = usage.daily['codex']['2026-06-23']
    // 有效 = input - cached + output = 1000 - 800 + 200 = 400
    expect(bucket.total).toBe(400)
    expect(bucket.input).toBe(200) // 非缓存 input = 1000 - 800
    expect(bucket.cacheRead).toBe(800)
    expect(bucket.output).toBe(200)
    expect(bucket.cacheCreation).toBe(0)
    expect(bucket.turns).toBe(1)
  })

  it('关闭开关不写整体用量', async () => {
    gitInit(repoRoot, 'main')
    setAiUsageEnabled(false, aipRootDir)
    const f = writeSession([
      meta(repoRoot, 'main'),
      boundary('task_started', '2026-06-23T11:00:01.000Z'),
      tokenCount(1000, 0, 200, '2026-06-23T11:00:03.000Z'),
      boundary('task_complete', '2026-06-23T11:00:04.000Z')
    ])
    await makeWatcher().processFileForTest(f)
    expect(readAiUsage(aipRootDir).daily['codex']).toBeUndefined()
  })
})
