import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { TranscriptWatcher, type TranscriptWatcherDeps } from './transcript-watcher.js'
import { upsertBinding } from './bindings.js'
import { saveRequirement } from './store/requirement-store.js'
import { listIterations, loadRawPayload } from './store/iteration-store.js'
import { aipRoot } from './store/paths.js'

interface AssistantLineOptions {
  cwd: string
  gitBranch: string
  totalInput?: number
  totalOutput?: number
  cacheCreation?: number
  cacheRead?: number
  stopReason?: string | null
  sessionId?: string
  timestamp?: string
  uuid?: string
  /**
   * v2.9.4 新增:Claude API message.id。
   * - 不传:每次生成一个随机 msg_<rand>(老用例语义保持)
   * - 显式传字符串:用例可让多条 line 共享同一 message.id 模拟 thinking + text 拆行
   * - 传空字符串 '':模拟 Claude Code 缺失 message.id 场景(走 fingerprint 兜底)
   */
  messageId?: string
}

function buildAssistantLine(
  opts: AssistantLineOptions | string,
  gitBranchPositional?: string,
  totalInput = 10,
  totalOutput = 20
): string {
  // 兼容旧位置参数签名:(cwd, gitBranch, totalInput, totalOutput)
  const o: AssistantLineOptions =
    typeof opts === 'string'
      ? { cwd: opts, gitBranch: gitBranchPositional ?? '', totalInput, totalOutput }
      : opts
  const messagePayload: Record<string, unknown> = {
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: o.totalInput ?? 10,
      output_tokens: o.totalOutput ?? 20,
      cache_creation_input_tokens: o.cacheCreation ?? 0,
      cache_read_input_tokens: o.cacheRead ?? 0
    }
  }
  // 默认 stop_reason='end_turn',方便老用例一行触发 flush;显式传 null 表示中间 tool_use 之类
  if (o.stopReason !== null) messagePayload.stop_reason = o.stopReason ?? 'end_turn'

  // v2.9.4:message.id 缺省随机,显式传 '' 模拟 Claude Code 缺失场景
  if (o.messageId !== '') {
    messagePayload.id = o.messageId ?? 'msg_' + Math.random().toString(16).slice(2, 14)
  }

  return (
    JSON.stringify({
      type: 'assistant',
      uuid: o.uuid ?? 'u-' + Math.random().toString(16).slice(2, 8),
      sessionId: o.sessionId ?? 's-1',
      cwd: o.cwd,
      gitBranch: o.gitBranch,
      timestamp: o.timestamp ?? '2026-05-14T03:26:38.071Z',
      message: messagePayload
    }) + '\n'
  )
}

/**
 * v2.11.1 构造 Claude Code Stop Hook 跑完后注入到 jsonl 的 system 行。
 *
 * 字段集合参考真实 jsonl(`subtype=stop_hook_summary`)实测内容,保留与 assistant 行
 * 同源的 cwd / gitBranch / sessionId / uuid / timestamp,让 watcher 能据此找到同
 * sessionId 的 turnBuffer。
 */
interface StopHookLineOptions {
  cwd: string
  gitBranch: string
  sessionId?: string
  uuid?: string
  timestamp?: string
}

/**
 * v2.12.0 构造 Claude Code transcript 的 user 行(用户 prompt 提交信号)。
 *
 * watcher 据此把「最近一条 user 行 timestamp」作为本轮起点,iteration thinkSeconds
 * 反映「用户提交 prompt → AI 完成响应」的真实 turn 时长,不再被上一轮上报时间污染。
 */
interface UserLineOptions {
  cwd: string
  gitBranch: string
  sessionId?: string
  uuid?: string
  timestamp?: string
  content?: string
}

function buildUserLine(opts: UserLineOptions): string {
  return (
    JSON.stringify({
      parentUuid: 'p-' + Math.random().toString(16).slice(2, 8),
      isSidechain: false,
      type: 'user',
      uuid: opts.uuid ?? 'uu-' + Math.random().toString(16).slice(2, 8),
      sessionId: opts.sessionId ?? 's-1',
      cwd: opts.cwd,
      gitBranch: opts.gitBranch,
      timestamp: opts.timestamp ?? '2026-05-21T06:00:00.000Z',
      message: {
        role: 'user',
        content: opts.content ?? 'hi claude'
      }
    }) + '\n'
  )
}

function buildStopHookSummaryLine(opts: StopHookLineOptions): string {
  return (
    JSON.stringify({
      parentUuid: 'p-' + Math.random().toString(16).slice(2, 8),
      isSidechain: false,
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: 3,
      hookInfos: [],
      sessionId: opts.sessionId ?? 's-1',
      uuid: opts.uuid ?? 'sh-' + Math.random().toString(16).slice(2, 8),
      cwd: opts.cwd,
      gitBranch: opts.gitBranch,
      timestamp: opts.timestamp ?? '2026-05-21T03:50:18.690Z'
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

describe('TranscriptWatcher.processFileForTest', () => {
  let claudeRoot: string
  let stateDir: string
  let repoRoot: string
  let originalAipRoot: string | undefined
  let aipRootDir: string

  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), 'aip-claude-'))
    stateDir = mkdtempSync(join(tmpdir(), 'aip-state-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'aip-repo-'))
    aipRootDir = mkdtempSync(join(tmpdir(), 'aip-root-'))
    originalAipRoot = process.env.TRUESIGHT_AIP_ROOT
    process.env.TRUESIGHT_AIP_ROOT = aipRootDir
    makeGitRepoAt(repoRoot, 'feature/ABC-1-watcher')
  })

  afterEach(() => {
    rmSync(claudeRoot, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(aipRootDir, { recursive: true, force: true })
    if (originalAipRoot !== undefined) process.env.TRUESIGHT_AIP_ROOT = originalAipRoot
    else delete process.env.TRUESIGHT_AIP_ROOT
  })

  function makeWatcher(): TranscriptWatcher {
    const deps: TranscriptWatcherDeps = {
      claudeProjectsDir: claudeRoot,
      statePath: join(stateDir, 'state.json')
    }
    return new TranscriptWatcher(deps)
  }

  it('未绑定时:仅累加 pending 不落 iteration', async () => {
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(f, buildAssistantLine(repoRoot, 'feature/ABC-1-watcher', 10, 20))

    const w = makeWatcher()
    await w.processFileForTest(f)

    expect(existsSync(join(repoRoot, '.ai-productivity', 'bindings.json'))).toBe(true)
    // 没 requirement,不应有 iterations 文件
    expect(existsSync(join(aipRoot(), 'ABC-1', 'iterations.jsonl'))).toBe(false)
  })

  it('已绑定且需求存在时:累加 binding.cumulativeToken 并写入本地 iteration', async () => {
    saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
    upsertBinding(repoRoot, 'ABC-1', {
      branch: 'feature/ABC-1-watcher',
      startedAt: '2026-05-14T00:00:00.000Z',
      requirementStartedAt: '2026-05-14T00:00:00.000Z'
    })
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(f, buildAssistantLine(repoRoot, 'feature/ABC-1-watcher', 10, 20))

    const w = makeWatcher()
    await w.processFileForTest(f)

    const iters = listIterations('ABC-1')
    expect(iters.length).toBe(1)
    expect(iters[0].kind).toBe('coding')
    expect(iters[0].cumulativeToken).toBe(30)
    expect(iters[0].modelName).toBe('claude-sonnet-4-6')
    expect(iters[0].elapsedMinutes).toBe(207)
  })

  it('cwd 不在 git 仓库内:静默跳过', async () => {
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    const nonGitDir = mkdtempSync(join(tmpdir(), 'aip-nongit-'))
    writeFileSync(f, buildAssistantLine(nonGitDir, 'main', 10, 20))

    const w = makeWatcher()
    await w.processFileForTest(f)

    expect(existsSync(join(aipRoot(), 'ABC-1'))).toBe(false)
    rmSync(nonGitDir, { recursive: true, force: true })
  })

  it('增量读取:第二次只处理新增行', async () => {
    saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
    upsertBinding(repoRoot, 'ABC-1', {
      branch: 'feature/ABC-1-watcher',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(f, buildAssistantLine(repoRoot, 'feature/ABC-1-watcher', 10, 20))

    const w = makeWatcher()
    await w.processFileForTest(f)
    expect(listIterations('ABC-1').length).toBe(1)

    appendFileSync(f, buildAssistantLine(repoRoot, 'feature/ABC-1-watcher', 5, 5))
    await w.processFileForTest(f)
    const all = listIterations('ABC-1')
    expect(all.length).toBe(2)
    expect(all[1].cumulativeToken).toBe(40)
  })

  it('已绑定但需求未 init:不落 iteration,仅累加 binding cumulativeToken', async () => {
    upsertBinding(repoRoot, 'ABC-1', {
      branch: 'feature/ABC-1-watcher',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    const projectDir = join(claudeRoot, '-x-fake')
    mkdirSync(projectDir, { recursive: true })
    const f = join(projectDir, 's1.jsonl')
    writeFileSync(f, buildAssistantLine(repoRoot, 'feature/ABC-1-watcher', 10, 20))

    const w = makeWatcher()
    await w.processFileForTest(f)

    expect(existsSync(join(aipRoot(), 'ABC-1', 'iterations.jsonl'))).toBe(false)
  })

  describe('v2.6.0 turnBuffer 聚合', () => {
    function setupBound(): void {
      saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
      upsertBinding(repoRoot, 'ABC-1', {
        branch: 'feature/ABC-1-watcher',
        startedAt: '2026-05-14T00:00:00.000Z',
        requirementStartedAt: '2026-05-14T00:00:00.000Z'
      })
    }

    it('单轮 3 tool_use + 1 end_turn → iterations.jsonl 仅 1 行,cumulativeToken=effectiveTokens 之和', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-A',
          stopReason: 'tool_use',
          totalInput: 10,
          totalOutput: 5,
          cacheRead: 1000,
          uuid: 'u-1',
          timestamp: '2026-05-14T03:26:38.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-A',
            stopReason: 'tool_use',
            totalInput: 8,
            totalOutput: 4,
            cacheRead: 2000,
            uuid: 'u-2',
            timestamp: '2026-05-14T03:26:39.000Z'
          }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-A',
            stopReason: 'tool_use',
            totalInput: 6,
            totalOutput: 3,
            cacheRead: 3000,
            uuid: 'u-3',
            timestamp: '2026-05-14T03:26:40.000Z'
          }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-A',
            stopReason: 'end_turn',
            totalInput: 4,
            totalOutput: 30,
            cacheRead: 4000,
            uuid: 'u-4',
            timestamp: '2026-05-14T03:26:41.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      // effectiveTokens 之和 = (10+5) + (8+4) + (6+3) + (4+30) = 70(cacheRead 1000+2000+3000+4000 全部排除)
      expect(iters[0].cumulativeToken).toBe(70)
      // reportedAt 应该是 end_turn 的时间戳
      expect(iters[0].reportedAt).toBe('2026-05-14T03:26:41.000Z')
    })

    it('多轮 2 个 end_turn → 2 行 iteration,seq 单调递增', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-B',
          stopReason: 'tool_use',
          totalInput: 5,
          totalOutput: 5,
          uuid: 'r1-1',
          timestamp: '2026-05-14T03:26:38.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-B',
            stopReason: 'end_turn',
            totalInput: 5,
            totalOutput: 5,
            uuid: 'r1-2',
            timestamp: '2026-05-14T03:26:39.000Z'
          }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-B',
            stopReason: 'tool_use',
            totalInput: 10,
            totalOutput: 10,
            uuid: 'r2-1',
            timestamp: '2026-05-14T03:26:50.000Z'
          }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-B',
            stopReason: 'end_turn',
            totalInput: 10,
            totalOutput: 10,
            uuid: 'r2-2',
            timestamp: '2026-05-14T03:26:51.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(2)
      expect(iters[0].seq).toBeLessThan(iters[1].seq)
      // 第一轮:5+5+5+5=20;第二轮:10+10+10+10=40;binding 累计=20+40=60
      expect(iters[0].cumulativeToken).toBe(20)
      expect(iters[1].cumulativeToken).toBe(60)
    })

    it('只有 tool_use 无 end_turn → 0 行 iteration,bindings.json 不被写入 binding 字段', async () => {
      setupBound()
      // saveRequirement + upsertBinding 已经写入 binding 了,先看 cumulativeToken 初始为 0
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-C',
          stopReason: 'tool_use',
          totalInput: 100,
          totalOutput: 200,
          uuid: 'p-1'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-C',
            stopReason: 'tool_use',
            totalInput: 100,
            totalOutput: 200,
            uuid: 'p-2'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      expect(listIterations('ABC-1').length).toBe(0)
      // binding 仍然在(setupBound 已经 upsertBinding),但 cumulativeToken 没被加(buffer 内累加未 flush)
      const bindingsRaw = JSON.parse(
        readFileSync(join(repoRoot, '.ai-productivity', 'bindings.json'), 'utf-8')
      ) as { bindings: Record<string, { cumulativeToken: number }> }
      expect(bindingsRaw.bindings['ABC-1'].cumulativeToken).toBe(0)
    })

    it.each([['pause_turn'], ['max_tokens'], ['stop_sequence']])(
      'terminal stop_reason=%s 同样触发 flush',
      async (stopReason) => {
        setupBound()
        const projectDir = join(claudeRoot, '-x-fake')
        mkdirSync(projectDir, { recursive: true })
        const f = join(projectDir, 's1.jsonl')
        writeFileSync(
          f,
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: `sess-${stopReason}`,
            stopReason: 'tool_use',
            totalInput: 5,
            totalOutput: 5,
            uuid: 'pre'
          }) +
            buildAssistantLine({
              cwd: repoRoot,
              gitBranch: 'feature/ABC-1-watcher',
              sessionId: `sess-${stopReason}`,
              stopReason,
              totalInput: 5,
              totalOutput: 5,
              uuid: 'terminal'
            })
        )

        const w = makeWatcher()
        await w.processFileForTest(f)

        const iters = listIterations('ABC-1')
        expect(iters.length).toBe(1)
        expect(iters[0].cumulativeToken).toBe(20)
      }
    )

    it('buffer 跨 processFileForTest 调用累积:第一次 tool_use,第二次 end_turn → 1 行 iteration', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-D',
          stopReason: 'tool_use',
          totalInput: 7,
          totalOutput: 3,
          uuid: 'h-1'
        })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)
      expect(listIterations('ABC-1').length).toBe(0)

      // 同一个 watcher 实例(同进程 buffer)再投 end_turn
      appendFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-D',
          stopReason: 'end_turn',
          totalInput: 13,
          totalOutput: 17,
          uuid: 'h-2'
        })
      )
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      // 累加:(7+3) + (13+17) = 40
      expect(iters[0].cumulativeToken).toBe(40)
    })
  })

  /**
   * v2.9.4 修复:Claude Code 2.x 起会把同一次 API 响应的 thinking / text 块拆 2 行写入 jsonl,
   * 每条都带完整 usage + stop_reason=end_turn,但共享同一 message.id。原有 v2.6.0 sessionId
   * 聚合算法把它当成两个独立 turn,落 2 行 iteration、token 双算。
   */
  describe('v2.9.4 按 message.id 去重 + usage 指纹兜底', () => {
    function setupBound(): void {
      saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
      upsertBinding(repoRoot, 'ABC-1', {
        branch: 'feature/ABC-1-watcher',
        startedAt: '2026-05-14T00:00:00.000Z',
        requirementStartedAt: '2026-05-14T00:00:00.000Z'
      })
    }

    it('同 message.id thinking + text 拆 2 行 → 仅 1 行 iteration、token 不被双算', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      // 模拟真实 INSTANT-5321 数据:同 message.id 两条 line,各自带完整 usage,stopReason=end_turn
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-msgid',
          messageId: 'msg_01SbiUFey9vLGi5zKGBTfZE2',
          stopReason: 'end_turn',
          totalInput: 6,
          totalOutput: 460,
          cacheCreation: 664,
          cacheRead: 85322,
          uuid: 'd409cce0-thinking',
          timestamp: '2026-05-21T02:23:11.517Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-msgid',
            messageId: 'msg_01SbiUFey9vLGi5zKGBTfZE2',
            stopReason: 'end_turn',
            totalInput: 6,
            totalOutput: 460,
            cacheCreation: 664,
            cacheRead: 85322,
            uuid: 'ed585799-text',
            timestamp: '2026-05-21T02:23:13.652Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      // effectiveTokens = input + output + cacheCreation = 6 + 460 + 664 = 1130(不双算)
      expect(iters[0].cumulativeToken).toBe(1130)
    })

    it('不同 message.id 同 sessionId 连续 2 个 end_turn → 仍 2 行 iteration(保留 v2.6.0 多轮语义)', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-multiturn',
          messageId: 'msg_turn_a',
          stopReason: 'end_turn',
          totalInput: 5,
          totalOutput: 5,
          uuid: 'a-1',
          timestamp: '2026-05-21T03:00:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-multiturn',
            messageId: 'msg_turn_b',
            stopReason: 'end_turn',
            totalInput: 10,
            totalOutput: 10,
            uuid: 'b-1',
            timestamp: '2026-05-21T03:01:00.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(2)
      expect(iters[0].cumulativeToken).toBe(10)
      expect(iters[1].cumulativeToken).toBe(30)
    })

    it('message.id 缺失 + 连续两条 usage 四元组完全一致 → 仅 1 行 iteration(fingerprint 兜底命中)', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-fp',
          messageId: '',
          stopReason: 'end_turn',
          totalInput: 6,
          totalOutput: 460,
          cacheCreation: 664,
          cacheRead: 85322,
          uuid: 'fp-a',
          timestamp: '2026-05-21T04:00:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-fp',
            messageId: '',
            stopReason: 'end_turn',
            totalInput: 6,
            totalOutput: 460,
            cacheCreation: 664,
            cacheRead: 85322,
            uuid: 'fp-b',
            timestamp: '2026-05-21T04:00:01.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      expect(iters[0].cumulativeToken).toBe(1130)
    })

    it('message.id 缺失 + 连续两条 usage 不同 → 2 行 iteration(fingerprint 不命中,按 v2.6.0 行为)', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-fp-mismatch',
          messageId: '',
          stopReason: 'end_turn',
          totalInput: 5,
          totalOutput: 5,
          uuid: 'fp-m-a',
          timestamp: '2026-05-21T05:00:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-fp-mismatch',
            messageId: '',
            // 任一字段不同 → fingerprint 不命中,正常落 iteration
            stopReason: 'end_turn',
            totalInput: 5,
            totalOutput: 6,
            uuid: 'fp-m-b',
            timestamp: '2026-05-21T05:00:01.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(2)
      expect(iters[0].cumulativeToken).toBe(10)
      expect(iters[1].cumulativeToken).toBe(21)
    })
  })

  /**
   * v2.11.1 修复:Claude Code 新版本下,LLM 经常以 MCP tool 调用收尾,最后一条 assistant
   * 的 stop_reason 始终是 `tool_use`,v2.6.0 watcher 按 terminal stop_reason 判定的 flush
   * 时机永远不触发 → 看板看不到任何 Claude Code iteration。
   *
   * 本期补两条 flush 通道:
   * - 主路径:Claude Code Stop Hook 跑完后注入的 `type=system subtype=stop_hook_summary`
   *   行,watcher 据此找到同 sessionId 的 turnBuffer 主动 flush。
   * - 兜底路径:scanAndScheduleAll 末尾跑 flushStaleBuffers,把闲置 > 60s 的 buffer 强制 flush。
   */
  describe('v2.11.1 tool_use 收尾 + stop_hook_summary / 60s 超时 flush 兜底', () => {
    function setupBound(): void {
      saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
      upsertBinding(repoRoot, 'ABC-1', {
        branch: 'feature/ABC-1-watcher',
        startedAt: '2026-05-14T00:00:00.000Z',
        requirementStartedAt: '2026-05-14T00:00:00.000Z'
      })
    }

    it('tool_use 收尾 + 同 sessionId stop_hook_summary → 1 行 iteration、triggerStopReason=stop_hook_summary', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-tool-end',
          stopReason: 'tool_use',
          totalInput: 10,
          totalOutput: 20,
          uuid: 'u-1',
          timestamp: '2026-05-21T03:50:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-tool-end',
            stopReason: 'tool_use',
            totalInput: 5,
            totalOutput: 8,
            uuid: 'u-2',
            timestamp: '2026-05-21T03:50:10.000Z'
          }) +
          buildStopHookSummaryLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-tool-end',
            uuid: 'sh-end',
            timestamp: '2026-05-21T03:50:18.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      // effectiveTokens = (10+20) + (5+8) = 43
      expect(iters[0].cumulativeToken).toBe(43)
      expect(iters[0].source).toBe('claude-code')

      // 校验 rawPayload 的 trigger 元信息
      const raw = iters[0].rawPayloadFile ? loadRawPayload('ABC-1', iters[0].rawPayloadFile) : null
      expect(raw).not.toBeNull()
      expect(raw?.triggerStopReason).toBe('stop_hook_summary')
      expect(raw?.triggerMessageUuid).toBe('sh-end')
      expect(raw?.flushTokens).toBeNull()
    })

    it('stop_hook_summary 不同 sessionId → buffer 不动、0 行 iteration', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-buf',
          stopReason: 'tool_use',
          totalInput: 10,
          totalOutput: 20,
          uuid: 'u-buf'
        }) +
          buildStopHookSummaryLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-other',
            uuid: 'sh-other'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      expect(listIterations('ABC-1').length).toBe(0)
    })

    it('已被 assistant_terminal flush 过 → stop_hook_summary 静默幂等(再触发不重复落 iteration)', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-idem',
          stopReason: 'end_turn',
          totalInput: 7,
          totalOutput: 3,
          uuid: 'u-et',
          timestamp: '2026-05-21T03:50:00.000Z'
        }) +
          buildStopHookSummaryLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-idem',
            uuid: 'sh-after',
            timestamp: '2026-05-21T03:50:18.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      expect(iters[0].cumulativeToken).toBe(10)

      // 既有 end_turn 路径保留 triggerStopReason='end_turn',rawPayload.flushTokens 完整
      const raw = iters[0].rawPayloadFile ? loadRawPayload('ABC-1', iters[0].rawPayloadFile) : null
      expect(raw?.triggerStopReason).toBe('end_turn')
      expect(raw?.flushTokens).toMatchObject({ input: 7, output: 3 })
    })

    it('flushStaleBuffers:buffer 闲置 > 60s 强制 flush、triggerStopReason=stale_timeout', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-stale',
          stopReason: 'tool_use',
          totalInput: 11,
          totalOutput: 22,
          uuid: 'u-st',
          timestamp: '2026-05-21T03:00:00.000Z'
        })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)
      expect(listIterations('ABC-1').length).toBe(0)

      // buffer 刚累加 5 秒,不应被 flush
      w.flushStaleBuffers(Date.parse('2026-05-21T03:00:05.000Z'))
      expect(listIterations('ABC-1').length).toBe(0)

      // buffer 已闲置 70 秒,触发 stale flush
      w.flushStaleBuffers(Date.parse('2026-05-21T03:01:10.000Z'))
      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      expect(iters[0].cumulativeToken).toBe(33)
      expect(iters[0].reportedAt).toBe('2026-05-21T03:00:00.000Z')

      const raw = iters[0].rawPayloadFile ? loadRawPayload('ABC-1', iters[0].rawPayloadFile) : null
      expect(raw?.triggerStopReason).toBe('stale_timeout')
      expect(raw?.triggerMessageUuid).toBe('')
      expect(raw?.flushTokens).toBeNull()
    })

    it('既有 end_turn 路径不回归:terminal stop_reason 仍直接 flush,无需 stop_hook_summary', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-classic',
          stopReason: 'tool_use',
          totalInput: 3,
          totalOutput: 3,
          uuid: 'c-1',
          timestamp: '2026-05-21T05:00:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-classic',
            stopReason: 'end_turn',
            totalInput: 4,
            totalOutput: 5,
            uuid: 'c-2',
            timestamp: '2026-05-21T05:00:01.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      expect(iters[0].cumulativeToken).toBe(15)

      const raw = iters[0].rawPayloadFile ? loadRawPayload('ABC-1', iters[0].rawPayloadFile) : null
      expect(raw?.triggerStopReason).toBe('end_turn')
      expect(raw?.triggerMessageUuid).toBe('c-2')
    })
  })

  /**
   * v2.12.0 修复:thinkSeconds 改为反映「用户 prompt → AI 完成响应」的真实 turn 时长。
   *
   * 老口径用 `binding.lastReportedAt → now`,简单问题被算成 5m(包含用户阅读 + 输入 + AI 处理),
   * 跨工具切换(Cursor → Claude Code)还会再次污染。本期改为优先用 transcript 里
   * `type=user` 行的 timestamp 作为本轮起点,数字直接反映 AI 真实处理时长。
   */
  describe('v2.12.0 user prompt 作为真实 turn 起点', () => {
    function setupBound(): void {
      saveRequirement({ jiraKey: 'ABC-1', title: 'Watcher demo' }, { repoPath: repoRoot })
      upsertBinding(repoRoot, 'ABC-1', {
        branch: 'feature/ABC-1-watcher',
        startedAt: '2026-05-14T00:00:00.000Z',
        requirementStartedAt: '2026-05-14T00:00:00.000Z'
      })
    }

    it('user 行先于 assistant 行 → thinkSeconds = lastAssistantTs - userPromptTs', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildUserLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-12-a',
          uuid: 'uu-a-1',
          timestamp: '2026-05-21T07:00:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-12-a',
            stopReason: 'end_turn',
            totalInput: 5,
            totalOutput: 5,
            uuid: 'a-1',
            timestamp: '2026-05-21T07:00:35.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      expect(iters[0].thinkSeconds).toBe(35)
    })

    it('无 user 行 → 退化到「本轮第一条 assistant ts」作为起点,数字仍合理', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        buildAssistantLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-12-b',
          stopReason: 'tool_use',
          totalInput: 5,
          totalOutput: 5,
          uuid: 'b-1',
          timestamp: '2026-05-21T07:10:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-12-b',
            stopReason: 'end_turn',
            totalInput: 5,
            totalOutput: 5,
            uuid: 'b-2',
            timestamp: '2026-05-21T07:10:18.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(1)
      // turnStartedAt 退化到首条 assistant 时间 b-1 (07:10:00),lastMessageTs=b-2 (07:10:18)
      // thinkSeconds = 18s
      expect(iters[0].thinkSeconds).toBe(18)
    })

    it('多轮:每轮 user 行各自驱动本轮起点,后一轮不会用前一轮的 user 行 timestamp', async () => {
      setupBound()
      const projectDir = join(claudeRoot, '-x-fake')
      mkdirSync(projectDir, { recursive: true })
      const f = join(projectDir, 's1.jsonl')
      writeFileSync(
        f,
        // 第 1 轮:用户 07:20:00 提问 → AI 07:20:10 答完
        buildUserLine({
          cwd: repoRoot,
          gitBranch: 'feature/ABC-1-watcher',
          sessionId: 'sess-12-c',
          uuid: 'uu-c-1',
          timestamp: '2026-05-21T07:20:00.000Z'
        }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-12-c',
            stopReason: 'end_turn',
            totalInput: 4,
            totalOutput: 4,
            uuid: 'c-1',
            timestamp: '2026-05-21T07:20:10.000Z'
          }) +
          // 第 2 轮:用户阅读 + 思考用了 3 分钟,07:23:10 才提下一条 → AI 07:23:30 答完
          buildUserLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-12-c',
            uuid: 'uu-c-2',
            timestamp: '2026-05-21T07:23:10.000Z'
          }) +
          buildAssistantLine({
            cwd: repoRoot,
            gitBranch: 'feature/ABC-1-watcher',
            sessionId: 'sess-12-c',
            stopReason: 'end_turn',
            totalInput: 6,
            totalOutput: 6,
            uuid: 'c-2',
            timestamp: '2026-05-21T07:23:30.000Z'
          })
      )

      const w = makeWatcher()
      await w.processFileForTest(f)

      const iters = listIterations('ABC-1')
      expect(iters.length).toBe(2)
      // 第 1 轮 thinkSeconds = 10s
      expect(iters[0].thinkSeconds).toBe(10)
      // 第 2 轮关键断言:thinkSeconds = 20s (新 user 行驱动),不被 3min 间隔污染、不被 cap
      expect(iters[1].thinkSeconds).toBe(20)
    })
  })
})
