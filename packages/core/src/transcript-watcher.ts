import { existsSync, readdirSync, statSync, watch as fsWatch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readJsonlIncremental } from './jsonl-incremental.js'
import {
  parseClaudeJsonlLine,
  parseClaudeStopHookSummary,
  parseClaudeUserMessage,
  effectiveTokens,
  TERMINAL_STOP_REASONS,
  type ParsedAssistantMessage,
  type ParsedStopHookSummary,
  type ParsedUserMessage,
  type ParsedTokens
} from './claude-message.js'
import { loadWatcherState, saveWatcherState, type WatcherState } from './watcher-state.js'
import { extractIssueKey, findGitRoot, getCurrentBranch } from './git.js'
import { appendTokenUsage } from './bindings.js'
import { buildIterationExtras } from './iteration-extras.js'
import { appendIteration } from './store/iteration-store.js'
import { loadRequirement } from './store/requirement-store.js'

const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const DEFAULT_STATE_PATH = join(
  homedir(),
  '.ai-productivity-tracker',
  'data',
  'transcript-state.json'
)
const DEBOUNCE_MS = 800
const SCAN_INTERVAL_MS = 30_000
/**
 * v2.9.4 seenApiMessageIds 上限。
 *
 * 单个 Claude Code 会话 jsonl 文件里 message.id 数量级在几十到几百;watcher 进程跨多需求、
 * 多会话累加,5000 足以覆盖绝大多数实际场景;超出后按 insertion order 删最旧的避免内存泄漏。
 */
const SEEN_API_MESSAGE_IDS_LIMIT = 5000
/**
 * v2.11.1 buffer 兜底超时阈值。
 *
 * 当一个 sessionId 的 turnBuffer 在内存中累加但距上一次 assistant 消息超过此时间窗仍未
 * flush,scanAndScheduleAll 触发的兜底循环会主动强制 flush。配合主路径(Claude Code
 * `type=system subtype=stop_hook_summary` 系统行触发的 stop_hook_summary flush),
 * 用于覆盖「Claude Code 没及时写 stop_hook_summary」的极端场景。
 */
const STALE_TURN_FLUSH_MS = 60_000

/**
 * v2.11.1 flushTurn 的触发来源联合类型。
 *
 * - `assistant_terminal`:既有路径,assistant message 的 stop_reason 命中 TERMINAL_STOP_REASONS。
 *   保留 v2.10.1 fingerprint 兜底、保留 rawPayload.triggerStopReason 写真实 stop_reason 的语义。
 * - `stop_hook_summary`:Claude Code Stop Hook 跑完后在 jsonl 注入的 `system` 行触发,
 *   不带 usage,rawPayload.triggerStopReason 写 `'stop_hook_summary'`、flushTokens=null。
 * - `stale_timeout`:turnBuffer 闲置 > STALE_TURN_FLUSH_MS 的兜底 flush,
 *   rawPayload.triggerStopReason 写 `'stale_timeout'`、flushTokens=null。
 *
 * stop_hook_summary / stale_timeout 路径**不更新** `lastFlushedFingerprint`(它们不带本次
 * usage 指纹),不影响后续 v2.10.1 message.id 缺失场景的指纹比对兜底。
 */
type FlushTrigger =
  | { kind: 'assistant_terminal'; msg: ParsedAssistantMessage }
  | { kind: 'stop_hook_summary'; uuid: string; timestamp: string }
  | { kind: 'stale_timeout'; timestamp: string }

export interface TranscriptWatcherDeps {
  log?: (msg: string) => void
  claudeProjectsDir?: string
  statePath?: string
}

export interface TranscriptWatcherStatus {
  running: boolean
  claudeProjectsDir: string
  trackedFiles: number
  startedAt: string | null
}

/**
 * v2.6.0 一轮对话的内存聚合 buffer.
 * 同一 sessionId 内,中间 tool_use / null stop_reason 的 assistant 消息只累加 tokenSum,
 * 直到出现 end_turn / pause_turn / max_tokens / stop_sequence 之一时一次性 flush 为 1 行 iteration.
 *
 * 跨进程语义:buffer 仅在内存,进程退出丢弃无害 — transcript-state.json 记录 jsonl offset,
 * 重启后从同一 offset 继续读到 terminal stop_reason,buffer 自然重建,最终落盘语义幂等.
 */
interface PendingTurn {
  sessionId: string
  issueKey: string
  gitRoot: string
  branch: string
  /**
   * v2.12.0 本轮起点:对应 transcript 里最近一条 `type=user` 行的 timestamp。
   * 缺省(user 行尚未观察到)时退化为本轮第一条 assistant 消息时间戳。
   * iteration-extras 据此把 thinkSeconds 计算成真实 turn 时长,不再用近似口径。
   */
  userPromptTs: string
  firstMessageTs: string
  lastMessageTs: string
  /** v2.6.0 算法:仅累加 input + output + cache_creation,排除 cache_read */
  tokenSum: number
  modelName: string
  messageUuids: string[]
}

/**
 * v2.9.4 usage 四元组指纹,作为 message.id 缺失场景的兜底去重 key。
 *
 * 把 (input, output, cacheCreation, cacheRead) 序列化成一个字符串,完全相同视为
 * "Claude Code 把同一次 API 响应拆出的另一行",整条丢弃避免双算。
 */
function fingerprintTokens(t: {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}): string {
  return `${t.input}|${t.output}|${t.cacheCreation}|${t.cacheRead}`
}

export class TranscriptWatcher {
  private readonly claudeProjectsDir: string
  private readonly statePath: string
  private state: WatcherState
  private rootWatcher: FSWatcher | null = null
  private childWatchers = new Map<string, FSWatcher>()
  private timers = new Map<string, NodeJS.Timeout>()
  private scanTimer: NodeJS.Timeout | null = null
  private startedAt: Date | null = null
  /** v2.6.0 按 sessionId 聚合的进行中对话 buffer */
  private turnBuffer = new Map<string, PendingTurn>()
  /**
   * v2.9.4 主去重键:Claude API 响应的 message.id 集合。
   *
   * Claude Code 2.x 起会把同一次 API 响应的 thinking / text 块拆成多条 jsonl 行,
   * 每条都带完整 usage 与 stop_reason=end_turn,共享同一 message.id。此 Set 在 watcher
   * 实例生命周期内维护"已处理过的 message.id",命中即整条丢弃,避免一次 API 调用被算成
   * 多个 iteration + token 双倍累加。
   *
   * Set 维持插入顺序,达到上限按 FIFO 淘汰最旧的条目,避免长跑泄漏。
   */
  private seenApiMessageIds = new Set<string>()
  /**
   * v2.9.4 兜底去重:仅在 message.id 缺失时启用的 usage 四元组指纹。
   *
   * key = turnKey(sessionId);value = `${input}|${output}|${cacheCreation}|${cacheRead}`。
   * 仅在 flush 时记录最近一次的指纹;下一条 assistant message 若 message.id 缺失且指纹与
   * 此值完全相同,视为 Claude Code 后续版本进一步剥离 message.id 的 stale 复制,整条丢弃。
   */
  private lastFlushedFingerprint = new Map<string, string>()
  /**
   * v2.12.0 按 sessionId 缓存「最近一次观察到的 user 行 timestamp」。
   *
   * 一旦同 sessionId 出现 assistant 消息且 turnBuffer 里还没建立条目(新一轮 turn 开启),
   * 从此 map 读出 user prompt timestamp 作为 PendingTurn.userPromptTs;新建后立即清掉,
   * 避免下一轮误用上一轮的 user timestamp。
   *
   * 仅进程内存,跨重启会丢;丢失时退化为「本轮第一条 assistant 消息 timestamp」(偏小 5~30s
   * 但远比老口径准),不影响幂等性。
   */
  private pendingUserPromptTs = new Map<string, string>()

  constructor(private readonly deps: TranscriptWatcherDeps) {
    this.claudeProjectsDir = deps.claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR
    this.statePath = deps.statePath ?? DEFAULT_STATE_PATH
    this.state = loadWatcherState(this.statePath)
  }

  start(): void {
    if (this.rootWatcher || this.startedAt) return
    if (!existsSync(this.claudeProjectsDir)) {
      this.log(`Claude projects 目录不存在,跳过 watcher: ${this.claudeProjectsDir}`)
      return
    }
    this.startedAt = new Date()

    try {
      this.rootWatcher = fsWatch(this.claudeProjectsDir, { persistent: false }, () => {
        this.scanAndScheduleAll()
      })
    } catch (err) {
      this.log(`无法监听 ${this.claudeProjectsDir}: ${(err as Error).message}`)
    }

    for (const dir of this.listProjectDirs()) this.watchProjectDir(dir)
    this.scanAndScheduleAll()
    this.scanTimer = setInterval(() => this.scanAndScheduleAll(), SCAN_INTERVAL_MS)
    this.log('TranscriptWatcher started')
  }

  stop(): void {
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const w of this.childWatchers.values()) w.close()
    this.childWatchers.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    this.startedAt = null
    this.turnBuffer.clear()
    this.seenApiMessageIds.clear()
    this.lastFlushedFingerprint.clear()
    this.pendingUserPromptTs.clear()
    this.log('TranscriptWatcher stopped')
  }

  getStatus(): TranscriptWatcherStatus {
    return {
      running: this.startedAt !== null,
      claudeProjectsDir: this.claudeProjectsDir,
      trackedFiles: Object.keys(this.state.files).length,
      startedAt: this.startedAt?.toISOString() ?? null
    }
  }

  /** 仅供测试调用:跳过 fs.watch,直接处理指定文件 */
  async processFileForTest(filePath: string): Promise<void> {
    await this.processFile(filePath)
  }

  private log(msg: string): void {
    if (this.deps.log) this.deps.log(`[transcript-watcher] ${msg}`)
    else console.log(`[transcript-watcher] ${msg}`)
  }

  private listProjectDirs(): string[] {
    try {
      return readdirSync(this.claudeProjectsDir)
        .map((name) => join(this.claudeProjectsDir, name))
        .filter((p) => {
          try {
            return statSync(p).isDirectory()
          } catch {
            return false
          }
        })
    } catch {
      return []
    }
  }

  private watchProjectDir(dir: string): void {
    if (this.childWatchers.has(dir)) return
    try {
      const w = fsWatch(dir, { persistent: false }, (_event, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          this.scheduleProcess(join(dir, filename))
        }
      })
      this.childWatchers.set(dir, w)
    } catch (err) {
      this.log(`无法监听 ${dir}: ${(err as Error).message}`)
    }
  }

  private scanAndScheduleAll(): void {
    for (const dir of this.listProjectDirs()) {
      this.watchProjectDir(dir)
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.jsonl')) this.scheduleProcess(join(dir, f))
        }
      } catch {
        /* ignore */
      }
    }
    this.flushStaleBuffers()
  }

  private scheduleProcess(filePath: string): void {
    const existing = this.timers.get(filePath)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      this.timers.delete(filePath)
      this.processFile(filePath).catch((err) => {
        this.log(`processFile ${filePath} 失败: ${(err as Error).message}`)
      })
    }, DEBOUNCE_MS)
    this.timers.set(filePath, t)
  }

  private async processFile(filePath: string): Promise<void> {
    const prev = this.state.files[filePath]
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(filePath)
    } catch {
      return
    }

    if (prev && prev.offset === stats.size && prev.mtimeMs === stats.mtimeMs) {
      return
    }

    const { lines, newOffset } = await readJsonlIncremental(filePath, prev?.offset ?? 0)

    for (const raw of lines) {
      // v2.12.0 优先识别 user 行,把本轮起点 timestamp 缓存进 pendingUserPromptTs,
      // 供下一条 assistant 行新建 PendingTurn 时消费。
      const userMsg = parseClaudeUserMessage(raw)
      if (userMsg) {
        try {
          this.routeUserMessage(userMsg)
        } catch (err) {
          this.log(`routeUserMessage 失败: ${(err as Error).message}`)
        }
        continue
      }
      // v2.11.1 识别 system stop_hook_summary 行(Claude Code 一轮真结束信号),
      // 让同 sessionId 的 turnBuffer 主动 flush;识别失败再走 assistant 解析。
      const stopHook = parseClaudeStopHookSummary(raw)
      if (stopHook) {
        try {
          this.routeStopHookSummary(stopHook)
        } catch (err) {
          this.log(`routeStopHookSummary 失败: ${(err as Error).message}`)
        }
        continue
      }
      const msg = parseClaudeJsonlLine(raw)
      if (!msg) continue
      try {
        this.routeMessage(msg)
      } catch (err) {
        this.log(`routeMessage 失败: ${(err as Error).message}`)
      }
    }

    this.state.files[filePath] = { offset: newOffset, mtimeMs: stats.mtimeMs }
    saveWatcherState(this.statePath, this.state)
  }

  /**
   * v2.6.0 路由消息:任何 stop_reason 都累加进 buffer,terminal stop_reason 触发 flush.
   *
   * 一次完整对话的 JSONL 抽样:543 行里 193 条 assistant,99.5% stop_reason='tool_use'、仅 0.5%
   * 'end_turn'.每条都有独立 message.usage,旧逻辑(每条都 appendIteration)导致单轮被算 N 行,
   * cumulativeToken 在同一轮被 cache_read 重复累加严重虚高.改为按轮聚合后,1 轮 = 1 行 iteration.
   *
   * v2.9.4 在 v2.6.0 sessionId 聚合之上叠加两层去重前置闸门:
   * - 主键(message.id):Claude Code 2.x 起把同一次 API 响应的 thinking / text 块拆 2 行
   *   写入 jsonl,共享同 message.id 但各自带完整 usage + stop_reason=end_turn,导致一次
   *   API 调用被切成 N 个 iteration、token 双算。命中即整条丢弃。
   * - 兜底(usage 指纹):message.id 缺失时(防御未来 Claude 进一步剥离字段),比对同 sessionId
   *   上一次 flush 的 (input,output,cacheCreation,cacheRead) 四元组,完全相同视为 stale 复制。
   */
  private routeMessage(msg: ParsedAssistantMessage): void {
    const gitRoot = findGitRoot(msg.cwd)
    if (!gitRoot) return

    const branch = msg.gitBranch ?? getCurrentBranch(gitRoot)
    if (!branch) return

    const issueKey = extractIssueKey(branch)
    if (!issueKey) return

    // requirement 是否 init 留到 flushTurn 里判断 — 即使没 init,也要让 binding/pending
    // 维持旧行为(累加到 pending,等待 init 时 mergePendingTokens 回填)。

    const turnKey = this.turnKey(msg)

    // v2.9.4 第一层(主):按 Claude API message.id 去重。命中即整条丢弃,不累加、不 flush。
    if (msg.apiMessageId) {
      if (this.seenApiMessageIds.has(msg.apiMessageId)) return
      this.rememberApiMessageId(msg.apiMessageId)
    } else {
      // v2.9.4 第二层(兜底):message.id 缺失时,比对同 sessionId 上一次 flush 的 usage 指纹。
      // 命中视为 Claude Code 进一步剥离 message.id 后的 stale 复制,整条丢弃。
      const fingerprint = fingerprintTokens(msg.tokens)
      if (this.lastFlushedFingerprint.get(turnKey) === fingerprint) return
    }

    const existing = this.turnBuffer.get(turnKey)
    const delta = effectiveTokens(msg.tokens)
    let buf: PendingTurn
    if (existing) {
      buf = {
        ...existing,
        // gitRoot / issueKey / branch 沿用首个消息的值,中途切换属于异常但我们不做拦截
        lastMessageTs: msg.timestamp,
        tokenSum: existing.tokenSum + delta,
        modelName: msg.model || existing.modelName,
        messageUuids: [...existing.messageUuids, msg.uuid]
      }
    } else {
      // v2.12.0 新一轮 turn 起点优先取最近一次 user 行 timestamp,缺省退化到本条 assistant 时间
      const cachedUserTs = this.pendingUserPromptTs.get(msg.sessionId)
      const userPromptTs = cachedUserTs || msg.timestamp
      // 消费后清掉,防止下一轮新 turn 误读上一轮的 user timestamp
      if (cachedUserTs) this.pendingUserPromptTs.delete(msg.sessionId)
      buf = {
        sessionId: msg.sessionId,
        issueKey,
        gitRoot,
        branch,
        userPromptTs,
        firstMessageTs: msg.timestamp,
        lastMessageTs: msg.timestamp,
        tokenSum: delta,
        modelName: msg.model,
        messageUuids: [msg.uuid]
      }
    }

    this.turnBuffer.set(turnKey, buf)

    if (msg.stopReason && (TERMINAL_STOP_REASONS as readonly string[]).includes(msg.stopReason)) {
      this.flushTurn(turnKey, buf, { kind: 'assistant_terminal', msg })
    }
  }

  /**
   * v2.12.0 user 行路由:把 timestamp 缓存到 pendingUserPromptTs,等下一条 assistant 行
   * 新建 PendingTurn 时消费。同 sessionId 后到的 user 行会覆盖前一次(典型场景:用户在
   * 同一会话连续提问,只有最近一次未被消费的 user timestamp 才是当前 turn 的真实起点)。
   *
   * 不在这里直接创建 turnBuffer,因为 turnBuffer 由 assistant 行驱动(无 token 不落盘),
   * 单纯一条 user 行不应产生 iteration。
   */
  private routeUserMessage(msg: ParsedUserMessage): void {
    if (!msg.sessionId) return
    this.pendingUserPromptTs.set(msg.sessionId, msg.timestamp)
  }

  /** sessionId 缺失时退化到 cwd|uuid 兜底,几乎不发生但避免 collisions */
  private turnKey(msg: ParsedAssistantMessage): string {
    return msg.sessionId ? `${msg.sessionId}` : `${msg.cwd}|${msg.uuid}`
  }

  /** v2.9.4 LRU 维护:超出上限按 insertion order 删最旧的,避免长跑进程内存泄漏 */
  private rememberApiMessageId(apiMessageId: string): void {
    this.seenApiMessageIds.add(apiMessageId)
    if (this.seenApiMessageIds.size > SEEN_API_MESSAGE_IDS_LIMIT) {
      const oldest = this.seenApiMessageIds.values().next().value
      if (oldest !== undefined) this.seenApiMessageIds.delete(oldest)
    }
  }

  /**
   * v2.11.1 系统行 stop_hook_summary 触发主动 flush。
   *
   * Claude Code 在每轮 Stop Hook 跑完后会注入一条 `type=system subtype=stop_hook_summary`
   * 行,这是 LLM 这一轮真正结束的信号(不依赖 assistant.stop_reason)。若同 sessionId 有
   * 进行中的 turnBuffer(典型:LLM 以 tool_use 收尾),立即强制 flush 一行 iteration。
   *
   * 没积压 buffer(已被 assistant_terminal 路径 flush 过)→ 直接返回,语义幂等。
   */
  private routeStopHookSummary(s: ParsedStopHookSummary): void {
    const turnKey = s.sessionId ? s.sessionId : `${s.cwd}|${s.uuid}`
    const buf = this.turnBuffer.get(turnKey)
    if (!buf) return
    this.flushTurn(turnKey, buf, {
      kind: 'stop_hook_summary',
      uuid: s.uuid,
      timestamp: s.timestamp
    })
  }

  /**
   * v2.11.1 兜底 flush:遍历所有 turnBuffer,把距上一次 assistant 消息超过
   * STALE_TURN_FLUSH_MS 的 turn 强制 flush。
   *
   * 触发场景:Claude Code 异常退出 / 用户直接关掉窗口 / 系统行没及时写入,
   * 都会让 `stop_hook_summary` 路径错过这一轮。此函数由 scanAndScheduleAll 每 30s
   * 触发一次,确保最坏情况 ≤ 90s 内一定 flush。
   *
   * 暴露为 public 供测试注入显式 `now` 时间戳(默认走 Date.now)。
   */
  flushStaleBuffers(now: number = Date.now()): void {
    for (const [turnKey, buf] of this.turnBuffer) {
      const refTs = buf.lastMessageTs || buf.firstMessageTs
      const refMs = Date.parse(refTs)
      if (!Number.isFinite(refMs)) continue
      if (now - refMs > STALE_TURN_FLUSH_MS) {
        this.flushTurn(turnKey, buf, {
          kind: 'stale_timeout',
          timestamp: refTs
        })
      }
    }
  }

  private flushTurn(turnKey: string, buf: PendingTurn, trigger: FlushTrigger): void {
    this.turnBuffer.delete(turnKey)
    // v2.9.4 兜底层指纹记录:只在 assistant_terminal 路径写入(stop_hook_summary / stale_timeout
    // 不携带 usage,无指纹可记)。下一条同 sessionId 且 message.id 缺失的 assistant 若指纹
    // 完全相同将被丢弃。
    if (trigger.kind === 'assistant_terminal') {
      this.lastFlushedFingerprint.set(turnKey, fingerprintTokens(trigger.msg.tokens))
    }

    const result = appendTokenUsage(
      buf.gitRoot,
      buf.branch,
      buf.issueKey,
      buf.tokenSum,
      buf.lastMessageTs,
      'claude-code'
    )

    // 未 upsertBinding → pending 已累加,iteration 不写
    if (!result.bound || !result.binding) return

    // 已绑定但未 init requirement → binding.cumulativeToken 已累加,iteration 不写
    const requirement = loadRequirement(buf.issueKey)
    if (!requirement) return

    const extras = buildIterationExtras({
      gitRoot: buf.gitRoot,
      binding: result.binding,
      now: new Date(buf.lastMessageTs),
      previousReportedAt: result.previousReportedAt,
      // v2.12.0 用 user prompt timestamp 作为本轮起点,thinkSeconds 反映真实 turn 时长
      turnStartedAt: buf.userPromptTs,
      source: 'claude-code',
      modelName: buf.modelName,
      initBaseCommit: requirement.initBaseCommit ?? '',
      jiraKey: buf.issueKey
    })

    const meta = describeFlushTrigger(trigger)

    appendIteration(buf.issueKey, {
      kind: 'coding',
      branch: buf.branch,
      source: 'claude-code',
      cumulativeToken: result.binding.cumulativeToken,
      elapsedMinutes: extras.elapsedMinutes,
      thinkSeconds: extras.thinkSeconds,
      diffFiles: extras.diffFiles,
      diffInsertions: extras.diffInsertions,
      diffDeletions: extras.diffDeletions,
      changedFiles: extras.changedFiles,
      cumulativeDiffFiles: extras.cumulativeDiffFiles,
      cumulativeDiffInsertions: extras.cumulativeDiffInsertions,
      cumulativeDiffDeletions: extras.cumulativeDiffDeletions,
      cumulativeChangedFiles: extras.cumulativeChangedFiles,
      modelName: extras.modelName,
      reportedAt: buf.lastMessageTs,
      rawPayload: {
        source: 'transcript-watcher',
        model: buf.modelName,
        sessionId: buf.sessionId,
        firstMessageTs: buf.firstMessageTs,
        lastMessageTs: buf.lastMessageTs,
        triggerStopReason: meta.triggerStopReason,
        triggerMessageUuid: meta.triggerMessageUuid,
        messageUuids: buf.messageUuids,
        tokenSum: buf.tokenSum,
        flushTokens: meta.flushTokens
      }
    })
  }
}

/**
 * v2.11.1 抽取 FlushTrigger 的 rawPayload 元信息。
 *
 * - assistant_terminal:复刻 v2.10.1 既有行为(stop_reason / uuid / 完整 usage 写入 rawPayload)
 * - stop_hook_summary:triggerStopReason='stop_hook_summary'、uuid 取系统行 uuid、flushTokens=null
 * - stale_timeout:triggerStopReason='stale_timeout'、uuid 空串、flushTokens=null
 */
function describeFlushTrigger(trigger: FlushTrigger): {
  triggerStopReason: string | null
  triggerMessageUuid: string
  flushTokens: ParsedTokens | null
} {
  if (trigger.kind === 'assistant_terminal') {
    return {
      triggerStopReason: trigger.msg.stopReason,
      triggerMessageUuid: trigger.msg.uuid,
      flushTokens: trigger.msg.tokens
    }
  }
  if (trigger.kind === 'stop_hook_summary') {
    return {
      triggerStopReason: 'stop_hook_summary',
      triggerMessageUuid: trigger.uuid,
      flushTokens: null
    }
  }
  return {
    triggerStopReason: 'stale_timeout',
    triggerMessageUuid: '',
    flushTokens: null
  }
}
