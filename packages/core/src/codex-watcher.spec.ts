import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { CodexWatcher, type CodexWatcherDeps } from './codex-watcher.js'
import { upsertBinding } from './bindings.js'
import { saveRequirement } from './store/requirement-store.js'
import { listIterations } from './store/iteration-store.js'
import { aipRoot } from './store/paths.js'

interface TokenTotals {
  input: number
  cached?: number
  output: number
}

function sessionMetaLine(opts: {
  sessionId: string
  cwd: string
  gitBranch: string
  timestamp?: string
}): string {
  return (
    JSON.stringify({
      timestamp: opts.timestamp ?? '2026-06-16T11:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: opts.sessionId,
        cwd: opts.cwd,
        git: { branch: opts.gitBranch }
      }
    }) + '\n'
  )
}

function taskStartedLine(timestamp: string, turnId = 't-1'): string {
  return (
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnId }
    }) + '\n'
  )
}

function turnContextLine(model: string, timestamp: string, turnId = 't-1'): string {
  return (
    JSON.stringify({ timestamp, type: 'turn_context', payload: { turn_id: turnId, model } }) + '\n'
  )
}

function userMessageLine(timestamp: string): string {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'user_message' } }) + '\n'
}

function tokenCountLine(total: TokenTotals, timestamp: string): string {
  return (
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: total.input,
            cached_input_tokens: total.cached ?? 0,
            output_tokens: total.output,
            total_tokens: total.input + total.output
          }
        }
      }
    }) + '\n'
  )
}

function taskCompleteLine(timestamp: string, turnId = 't-1'): string {
  return (
    JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turnId }
    }) + '\n'
  )
}

function makeGitRepoAt(repoRoot: string, branch: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: repoRoot }
  )
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repoRoot })
}

describe('CodexWatcher.processFileForTest', () => {
  let codexRoot: string
  let stateDir: string
  let repoRoot: string
  let originalAipRoot: string | undefined
  let aipRootDir: string

  const BRANCH = 'feature/ABC-1-codex'

  beforeEach(() => {
    codexRoot = mkdtempSync(join(tmpdir(), 'aip-codex-'))
    stateDir = mkdtempSync(join(tmpdir(), 'aip-codex-state-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'aip-codex-repo-'))
    aipRootDir = mkdtempSync(join(tmpdir(), 'aip-codex-data-'))
    originalAipRoot = process.env.AIPT_DATA_ROOT
    process.env.AIPT_DATA_ROOT = aipRootDir
    makeGitRepoAt(repoRoot, BRANCH)
  })

  afterEach(() => {
    rmSync(codexRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(aipRootDir, { recursive: true, force: true })
    if (originalAipRoot !== undefined) process.env.AIPT_DATA_ROOT = originalAipRoot
    else delete process.env.AIPT_DATA_ROOT
  })

  function makeWatcher(): CodexWatcher {
    const deps: CodexWatcherDeps = {
      codexSessionsDir: codexRoot,
      statePath: join(stateDir, 'codex-state.json')
    }
    return new CodexWatcher(deps)
  }

  function setupBound(): void {
    saveRequirement({ jiraKey: 'ABC-1', title: 'Codex demo' }, { repoPath: repoRoot })
    upsertBinding(repoRoot, 'ABC-1', {
      branch: BRANCH,
      startedAt: '2026-06-16T00:00:00.000Z',
      requirementStartedAt: '2026-06-16T00:00:00.000Z'
    })
  }

  function sessionFile(name = 's1.jsonl'): string {
    const dir = join(codexRoot, '2026', '06', '16')
    mkdirSync(dir, { recursive: true })
    return join(dir, name)
  }

  it('单轮 task_complete → 1 行 iteration,token=有效累计、model、source=codex', async () => {
    setupBound()
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-A', cwd: repoRoot, gitBranch: BRANCH }) +
        taskStartedLine('2026-06-16T11:00:01.000Z') +
        turnContextLine('gpt-5.5', '2026-06-16T11:00:02.000Z') +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 100, cached: 0, output: 20 }, '2026-06-16T11:00:30.000Z') +
        taskCompleteLine('2026-06-16T11:00:33.000Z')
    )

    const w = makeWatcher()
    await w.processFileForTest(f)

    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(1)
    expect(iters[0].source).toBe('codex')
    expect(iters[0].modelName).toBe('gpt-5.5')
    // effective = 100 - 0 + 20 = 120
    expect(iters[0].cumulativeToken).toBe(120)
    expect(iters[0].reportedAt).toBe('2026-06-16T11:00:33.000Z')
    // thinkSeconds = task_complete - user_message = 30s
    expect(iters[0].thinkSeconds).toBe(30)
  })

  it('多轮累计 token:轮增量 = 当前累计 − 上一轮累计', async () => {
    setupBound()
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-B', cwd: repoRoot, gitBranch: BRANCH }) +
        // 第 1 轮:累计 effective = 80 - 0 + 40 = 120
        taskStartedLine('2026-06-16T11:00:01.000Z', 't-1') +
        turnContextLine('gpt-5.5', '2026-06-16T11:00:02.000Z', 't-1') +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 80, cached: 0, output: 40 }, '2026-06-16T11:00:10.000Z') +
        taskCompleteLine('2026-06-16T11:00:11.000Z', 't-1') +
        // 第 2 轮:累计 effective = 250 - 0 + 50 = 300 → 本轮增量 = 300 - 120 = 180
        taskStartedLine('2026-06-16T11:05:01.000Z', 't-2') +
        turnContextLine('gpt-5.5', '2026-06-16T11:05:02.000Z', 't-2') +
        userMessageLine('2026-06-16T11:05:03.000Z') +
        tokenCountLine({ input: 250, cached: 0, output: 50 }, '2026-06-16T11:05:20.000Z') +
        taskCompleteLine('2026-06-16T11:05:21.000Z', 't-2')
    )

    const w = makeWatcher()
    await w.processFileForTest(f)

    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(2)
    expect(iters[0].cumulativeToken).toBe(120)
    expect(iters[1].cumulativeToken).toBe(300)
  })

  it('cached_input_tokens 排除在有效 token 之外', async () => {
    setupBound()
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-cache', cwd: repoRoot, gitBranch: BRANCH }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 1000, cached: 900, output: 50 }, '2026-06-16T11:00:30.000Z') +
        taskCompleteLine('2026-06-16T11:00:33.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(1)
    // effective = 1000 - 900 + 50 = 150
    expect(iters[0].cumulativeToken).toBe(150)
  })

  it('非 Jira 分支(main)→ 不落 iteration', async () => {
    setupBound()
    const f = sessionFile()
    // git 仓库当前在 BRANCH,但 session_meta 声明 main(无 Jira key)→ extractIssueKey 失败
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-main', cwd: repoRoot, gitBranch: 'main' }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 100, output: 20 }, '2026-06-16T11:00:30.000Z') +
        taskCompleteLine('2026-06-16T11:00:33.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(listIterations('ABC-1').length).toBe(0)
  })

  it('cwd 不在 git 仓库 → 静默跳过', async () => {
    setupBound()
    const f = sessionFile()
    const nonGit = mkdtempSync(join(tmpdir(), 'aip-codex-nongit-'))
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-nogit', cwd: nonGit, gitBranch: BRANCH }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 100, output: 20 }, '2026-06-16T11:00:30.000Z') +
        taskCompleteLine('2026-06-16T11:00:33.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(listIterations('ABC-1').length).toBe(0)
    rmSync(nonGit, { recursive: true, force: true })
  })

  it('已绑定但需求未 init → 不落 iteration', async () => {
    upsertBinding(repoRoot, 'ABC-1', { branch: BRANCH, startedAt: '2026-06-16T00:00:00.000Z' })
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-noinit', cwd: repoRoot, gitBranch: BRANCH }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 100, output: 20 }, '2026-06-16T11:00:30.000Z') +
        taskCompleteLine('2026-06-16T11:00:33.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(existsSync(join(aipRoot(), 'ABC-1', 'iterations.jsonl'))).toBe(false)
  })

  it('task_complete 缺失 + flushStaleBuffers(>30min)→ 兜底 flush 1 行', async () => {
    setupBound()
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-stale', cwd: repoRoot, gitBranch: BRANCH }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 33, output: 0 }, '2026-06-16T11:00:30.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(listIterations('ABC-1').length).toBe(0)

    // 5min 不 flush
    w.flushStaleBuffers(Date.parse('2026-06-16T11:05:30.000Z'))
    expect(listIterations('ABC-1').length).toBe(0)

    // 31min 触发兜底 flush
    w.flushStaleBuffers(Date.parse('2026-06-16T11:31:30.000Z'))
    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(1)
    expect(iters[0].cumulativeToken).toBe(33)
  })

  it('跨 processFile 调用:第二次才出现 task_complete → 仍 1 行,token 不双算', async () => {
    setupBound()
    const f = sessionFile()
    writeFileSync(
      f,
      sessionMetaLine({ sessionId: 'sess-split', cwd: repoRoot, gitBranch: BRANCH }) +
        userMessageLine('2026-06-16T11:00:03.000Z') +
        tokenCountLine({ input: 60, output: 10 }, '2026-06-16T11:00:10.000Z')
    )
    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(listIterations('ABC-1').length).toBe(0)

    appendFileSync(
      f,
      tokenCountLine({ input: 120, output: 30 }, '2026-06-16T11:00:20.000Z') +
        taskCompleteLine('2026-06-16T11:00:25.000Z')
    )
    await w.processFileForTest(f)
    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(1)
    // 取最新累计 effective = 120 - 0 + 30 = 150
    expect(iters[0].cumulativeToken).toBe(150)
  })
})
