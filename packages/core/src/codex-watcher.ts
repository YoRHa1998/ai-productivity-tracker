import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  watch as fsWatch,
  writeFileSync
} from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { readJsonlIncremental } from './jsonl-incremental.js'
import { decideIncrementalRead } from './watcher-state.js'
import {
  effectiveCodexTokens,
  parseCodexSessionMeta,
  parseCodexTokenCount,
  parseCodexTurnBoundary,
  parseCodexTurnContext,
  type CodexTokenUsage
} from './codex-message.js'
import { extractIssueKey, findGitRoot, getCurrentBranch } from './git.js'
import { appendTokenUsage } from './bindings.js'
import { buildIterationExtras } from './iteration-extras.js'
import { appendIteration } from './store/iteration-store.js'
import { loadRequirement } from './store/requirement-store.js'
import { isUsageCaptureActive, recordUsage } from './store/ai-usage-store.js'
import { truncateTitle } from './store/session-usage-store.js'
import { readProjectNameFromPackageJson } from './project-meta.js'

const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
/**
 * Codex watcher 用**独立**的状态文件,不复用 Claude 的 transcript-state.json:
 * 两个 watcher 并存时若写同一文件会产生 tmp+rename 竞争;且 codex 需要额外持久化
 * per-session 累计 token 基线(见 sessions 字段),schema 不同。
 */
const DEFAULT_STATE_PATH = join(homedir(), '.ai-productivity-tracker', 'data', 'codex-state.json')
const DEBOUNCE_MS = 800
const SCAN_INTERVAL_MS = 30_000
/**
 * 与 Claude watcher 同口径:30min 无活动的 pending turn 兜底 flush,防 codex 异常退出
 * (task_complete 永远写不出)时内存里的 buffer 永久泄漏。
 */
const STALE_TURN_FLUSH_MS = 30 * 60_000
/** 读取 session_meta(首行)时的最大字节数;首行含 base_instructions 通常几 KB,16MB 足够兜底 */
const FIRST_LINE_MAX_BYTES = 16 * 1024 * 1024

interface CodexFileState {
  offset: number
  mtimeMs: number
  /** 上次观察到的文件大小;旧 state 缺失为 undefined,首扫自动补齐 */
  size?: number
  /** 文件 inode;旧 state 缺失为 undefined。Windows 上可能为 0/不稳定,作兜底处理 */
  ino?: number
}

interface CodexSessionState {
  /** 该 session 已 flush 的累计有效 token,跨重启保持,避免把整段累计算成单轮增量 */
  flushedTotal: number
  /**
   * AI 整体用量旁路:该 session 已记入整体用量的累计 token 细分基线(跨重启保持)。
   * flush 时按 `current - flushedUsage` 得本轮 token 细分增量;旧 state 缺失为 undefined(视为 0)。
   */
  flushedUsage?: CodexTokenUsage
}

interface CodexWatcherState {
  version: number
  files: Record<string, CodexFileState>
  sessions: Record<string, CodexSessionState>
}

/**
 * 一轮 Codex 对话的内存聚合 buffer。
 *
 * 与 Claude 的差异:Codex token 是**累计单调递增**值,本轮增量在 flush 时由
 * `currentTotalEffective − state.sessions[sessionId].flushedTotal` 得出,不需要像
 * Claude 那样在轮内逐条累加 + message.id 去重。
 */
interface CodexPendingTurn {
  sessionId: string
  issueKey: string
  gitRoot: string
  branch: string
  /** 本轮真实起点:user_message timestamp;缺省退化到 task_started / 首个信号 timestamp */
  userPromptTs: string
  /**
   * 会话标题素材(best-effort):会话首个 user_message 文本片段;仅作会话维度 title,
   * store 侧只首次写入不覆盖。
   */
  title: string
  /** 最近一次该 session 的任意事件 timestamp,用于 stale 判定 */
  lastEventTs: string
  model: string
  /** 截至目前观察到的累计有效 token(取最新 token_count;初值为 flushedTotal 基线) */
  currentTotalEffective: number
  /**
   * AI 整体用量旁路:截至目前观察到的累计 token 细分(取最新 token_count;初值为 flushedUsage 基线)。
   * flush 时与 session 基线作差得本轮 token 细分。
   */
  currentTotalUsage: CodexTokenUsage
}

export interface CodexWatcherDeps {
  log?: (msg: string) => void
  codexSessionsDir?: string
  statePath?: string
}

export interface CodexWatcherStatus {
  running: boolean
  codexSessionsDir: string
  trackedFiles: number
  startedAt: string | null
}

const ZERO_CODEX_USAGE: CodexTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0
}

/** 归一化(可能缺失的)累计 token 细分基线,缺字段补 0。 */
function normalizeCodexUsage(u: CodexTokenUsage | undefined): CodexTokenUsage {
  if (!u || typeof u !== 'object') return { ...ZERO_CODEX_USAGE }
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    inputTokens: n(u.inputTokens),
    cachedInputTokens: n(u.cachedInputTokens),
    outputTokens: n(u.outputTokens),
    totalTokens: n(u.totalTokens)
  }
}

/** 逐字段取较大者(token_count 单调递增,基线推进时防回退)。 */
function maxCodexUsage(a: CodexTokenUsage, b: CodexTokenUsage): CodexTokenUsage {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    totalTokens: Math.max(a.totalTokens, b.totalTokens)
  }
}

function loadState(statePath: string): CodexWatcherState {
  if (!existsSync(statePath)) return { version: 1, files: {}, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<CodexWatcherState>
    return {
      version: parsed.version ?? 1,
      files: parsed.files ?? {},
      sessions: parsed.sessions ?? {}
    }
  } catch {
    return { version: 1, files: {}, sessions: {} }
  }
}

function saveState(statePath: string, state: CodexWatcherState): void {
  const dir = dirname(statePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, statePath)
}

/** 读取文件首行(session_meta 永远是第一行),不把整文件读进内存 */
function readFirstLine(filePath: string): string | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const chunkSize = 64 * 1024
    const buf = Buffer.alloc(chunkSize)
    let acc = ''
    let total = 0
    while (total < FIRST_LINE_MAX_BYTES) {
      const bytes = readSync(fd, buf, 0, chunkSize, total)
      if (bytes <= 0) break
      total += bytes
      acc += buf.toString('utf-8', 0, bytes)
      const idx = acc.indexOf('\n')
      if (idx >= 0) return acc.slice(0, idx)
    }
    return acc || null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Codex 会话监听器。
 *
 * 监听 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(日期三层嵌套),按 turn 聚合,
 * `task_complete` 触发 flush,落 `source: 'codex'` 的 iteration。与 Claude 的 TranscriptWatcher
 * 独立实现以隔离回归风险;复用 `readJsonlIncremental` 增量读 + 通用 store/bindings 落盘出口。
 */
export class CodexWatcher {
  private readonly codexSessionsDir: string
  private readonly statePath: string
  private state: CodexWatcherState
  private rootWatcher: FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private scanTimer: NodeJS.Timeout | null = null
  private startedAt: Date | null = null
  /** sessionId → { cwd, gitBranch },来自 session_meta(cwd/branch 仅首行出现) */
  private sessionMeta = new Map<string, { cwd: string; gitBranch: string | null }>()
  /** filePath → sessionId,读首行 session_meta 后缓存;避免重复读首行 + 给行归属用 */
  private fileToSession = new Map<string, string>()
  /** filePath → 是否已尝试读取首行 session_meta */
  private fileMetaLoaded = new Set<string>()
  /** sessionId → 进行中的 turn buffer */
  private turnBuffer = new Map<string, CodexPendingTurn>()

  constructor(private readonly deps: CodexWatcherDeps) {
    this.codexSessionsDir = deps.codexSessionsDir ?? DEFAULT_CODEX_SESSIONS_DIR
    this.statePath = deps.statePath ?? DEFAULT_STATE_PATH
    this.state = loadState(this.statePath)
  }

  start(): void {
    if (this.rootWatcher || this.startedAt) return
    if (!existsSync(this.codexSessionsDir)) {
      this.log(`Codex sessions 目录不存在,跳过 watcher: ${this.codexSessionsDir}`)
      return
    }
    this.startedAt = new Date()

    // macOS 支持 recursive watch;不支持的平台(部分 Linux)抛错,降级为纯 30s 周期扫描。
    try {
      this.rootWatcher = fsWatch(
        this.codexSessionsDir,
        { persistent: false, recursive: true },
        (_event, filename) => {
          if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
            this.scheduleProcess(join(this.codexSessionsDir, filename))
          } else {
            this.scanAndScheduleAll()
          }
        }
      )
    } catch (err) {
      this.log(`recursive watch 不可用,降级为周期扫描: ${(err as Error).message}`)
    }

    this.scanAndScheduleAll()
    this.scanTimer = setInterval(() => this.scanAndScheduleAll(), SCAN_INTERVAL_MS)
    this.log('CodexWatcher started')
  }

  stop(): void {
    this.rootWatcher?.close()
    this.rootWatcher = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    this.startedAt = null
    this.turnBuffer.clear()
    this.sessionMeta.clear()
    this.fileToSession.clear()
    this.fileMetaLoaded.clear()
    this.log('CodexWatcher stopped')
  }

  getStatus(): CodexWatcherStatus {
    return {
      running: this.startedAt !== null,
      codexSessionsDir: this.codexSessionsDir,
      trackedFiles: Object.keys(this.state.files).length,
      startedAt: this.startedAt?.toISOString() ?? null
    }
  }

  /** 仅供测试调用:跳过 fs.watch,直接处理指定文件 */
  async processFileForTest(filePath: string): Promise<void> {
    await this.processFile(filePath)
  }

  private log(msg: string): void {
    if (this.deps.log) this.deps.log(`[codex-watcher] ${msg}`)
    else console.log(`[codex-watcher] ${msg}`)
  }

  /** 递归列出 sessions 目录下全部 *.jsonl 绝对路径 */
  private listSessionFiles(): string[] {
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const full = join(dir, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) walk(full, depth + 1)
        else if (name.endsWith('.jsonl')) out.push(full)
      }
    }
    walk(this.codexSessionsDir, 0)
    return out
  }

  private scanAndScheduleAll(): void {
    for (const f of this.listSessionFiles()) this.scheduleProcess(f)
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

  /**
   * 确保拿到该文件的 session_meta(cwd / gitBranch)。
   *
   * session_meta 永远是文件首行;即使 watcher 从一个已 past 首行的 offset 恢复(daemon 重启
   * 后续读新行),也能通过读首行补齐 sessionMeta 缓存,保证 cwd/branch 可解析。
   */
  private ensureFileMeta(filePath: string): void {
    if (this.fileMetaLoaded.has(filePath)) return
    this.fileMetaLoaded.add(filePath)
    const firstLine = readFirstLine(filePath)
    if (!firstLine) return
    const meta = parseCodexSessionMeta(firstLine)
    if (!meta) return
    this.sessionMeta.set(meta.sessionId, { cwd: meta.cwd, gitBranch: meta.gitBranch })
    this.fileToSession.set(filePath, meta.sessionId)
  }

  private async processFile(filePath: string): Promise<void> {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(filePath)
    } catch {
      return
    }

    // 先确保 session_meta 已缓存(读首行),再做增量读
    this.ensureFileMeta(filePath)
    const fileSessionId = this.fileToSession.get(filePath) ?? null

    const prev = this.state.files[filePath]
    const decision = decideIncrementalRead(prev, stats)
    if (decision.skip) return

    const { lines, newOffset } = await readJsonlIncremental(filePath, decision.startOffset)

    for (const raw of lines) {
      try {
        this.routeLine(raw, fileSessionId)
      } catch (err) {
        this.log(`routeLine 失败: ${(err as Error).message}`)
      }
    }

    this.state.files[filePath] = {
      offset: newOffset,
      size: stats.size,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs
    }
    saveState(this.statePath, this.state)
  }

  /**
   * 路由一行。`fileSessionId` 是该行所属文件的 session(由 ensureFileMeta 读首行解析),
   * turn_context / token_count / 轮边界都按它归属 —— 它们行内不带 sessionId,只能靠所属
   * 文件区分,避免多 codex 实例并发时跨 session 串扰。
   */
  private routeLine(raw: string, fileSessionId: string | null): void {
    // 1) session_meta:缓存 cwd / branch(首批增量读会包含首行)
    const meta = parseCodexSessionMeta(raw)
    if (meta) {
      this.sessionMeta.set(meta.sessionId, { cwd: meta.cwd, gitBranch: meta.gitBranch })
      return
    }

    if (!fileSessionId) return

    // 2) turn_context:记录本轮 model
    const turnCtx = parseCodexTurnContext(raw)
    if (turnCtx) {
      const buf = this.ensurePendingTurn(fileSessionId, turnCtx.timestamp)
      if (buf && turnCtx.model) buf.model = turnCtx.model
      return
    }

    // 3) token_count:更新累计有效 token
    const tokenCount = parseCodexTokenCount(raw)
    if (tokenCount) {
      const buf = this.ensurePendingTurn(fileSessionId, tokenCount.timestamp)
      if (buf) {
        const nextEffective = effectiveCodexTokens(tokenCount.total)
        // token_count 单调递增,取较大者;同步更新整体用量细分基线(currentTotalUsage)
        if (nextEffective >= buf.currentTotalEffective) {
          buf.currentTotalEffective = nextEffective
          buf.currentTotalUsage = tokenCount.total
        }
        buf.lastEventTs = tokenCount.timestamp
      }
      return
    }

    // 4) 轮边界:task_started / user_message / task_complete
    const boundary = parseCodexTurnBoundary(raw)
    if (!boundary) return

    if (boundary.kind === 'task_started') {
      this.ensurePendingTurn(fileSessionId, boundary.timestamp)
      return
    }
    if (boundary.kind === 'user_message') {
      // user_message 是本轮真实起点;若 pending turn 尚未建立(task_started 缺失),补建
      const buf = this.ensurePendingTurn(fileSessionId, boundary.timestamp)
      if (buf) {
        buf.userPromptTs = boundary.timestamp
        buf.lastEventTs = boundary.timestamp
        // 取首个 user_message 文本作会话标题素材(本轮未捕获过时才写)。
        if (!buf.title) buf.title = truncateTitle(boundary.text)
      }
      return
    }
    if (boundary.kind === 'task_complete') {
      const buf = this.turnBuffer.get(fileSessionId)
      if (buf) this.flushTurn(fileSessionId, buf, boundary.timestamp)
    }
  }

  /**
   * 确保指定 session 有一个 pending turn。
   *
   * 已有 → 复用并刷新 lastEventTs;否则从 sessionMeta 解析 git 仓库新建。
   * 无 git 仓库 / 分支(detached HEAD)的 session 返回 null(不追踪)。
   *
   * AI 整体用量旁路(D2):issueKey 闸门**之前**不再 early-return —— 非 Jira 分支(main 等)
   * 也建 buffer 并在 flush 记录整体用量;issueKey 为空串时 flush 只记用量、不写需求 iteration。
   */
  private ensurePendingTurn(sessionId: string, timestamp: string): CodexPendingTurn | null {
    const existing = this.turnBuffer.get(sessionId)
    if (existing) {
      existing.lastEventTs = timestamp
      return existing
    }

    const info = this.sessionMeta.get(sessionId)
    if (!info) return null
    const gitRoot = findGitRoot(info.cwd)
    if (!gitRoot) return null
    const branch = info.gitBranch ?? getCurrentBranch(gitRoot)
    if (!branch) return null
    const issueKey = extractIssueKey(branch) ?? ''

    const sessionState = this.state.sessions[sessionId]
    const baseline = sessionState?.flushedTotal ?? 0
    const baselineUsage = normalizeCodexUsage(sessionState?.flushedUsage)
    const buf: CodexPendingTurn = {
      sessionId,
      issueKey,
      gitRoot,
      branch,
      userPromptTs: timestamp,
      title: '',
      lastEventTs: timestamp,
      model: 'unknown',
      currentTotalEffective: baseline,
      currentTotalUsage: baselineUsage
    }
    this.turnBuffer.set(sessionId, buf)
    return buf
  }

  /**
   * 30min 无活动的 pending turn 兜底 flush(codex 异常退出 / task_complete 丢失)。
   * 暴露 now 参数供单测注入。
   */
  flushStaleBuffers(now: number = Date.now()): void {
    for (const [sessionId, buf] of [...this.turnBuffer]) {
      const refMs = Date.parse(buf.lastEventTs)
      if (!Number.isFinite(refMs)) continue
      if (now - refMs > STALE_TURN_FLUSH_MS) {
        this.flushTurn(sessionId, buf, buf.lastEventTs)
      }
    }
  }

  private flushTurn(sessionId: string, buf: CodexPendingTurn, reportedAt: string): void {
    this.turnBuffer.delete(sessionId)

    const prevState = this.state.sessions[sessionId]
    const baseline = prevState?.flushedTotal ?? 0
    const baselineUsage = normalizeCodexUsage(prevState?.flushedUsage)
    const delta = Math.max(0, buf.currentTotalEffective - baseline)

    // 推进 flushedTotal / flushedUsage 基线(即使 delta=0 也推进,保证幂等),持久化跨重启
    this.state.sessions[sessionId] = {
      flushedTotal: Math.max(baseline, buf.currentTotalEffective),
      flushedUsage: maxCodexUsage(baselineUsage, buf.currentTotalUsage)
    }
    saveState(this.statePath, this.state)

    // 本轮无新增 token(纯无效轮 / 重复 task_complete)→ 不落 iteration / 不记用量
    if (delta <= 0) return

    // AI 整体用量 + 用量测算旁路(D2/D3):在 issueKey 闸门之前记录,覆盖非 Jira 分支。
    // 闸门 isUsageCaptureActive = 整体用量开启 或 有进行中测算会话;都不活跃时零盘 I/O 短路。
    // 容错静默,绝不影响需求维度采集。
    if (isUsageCaptureActive()) {
      try {
        const dInput = Math.max(0, buf.currentTotalUsage.inputTokens - baselineUsage.inputTokens)
        const dCached = Math.max(
          0,
          buf.currentTotalUsage.cachedInputTokens - baselineUsage.cachedInputTokens
        )
        const dOutput = Math.max(0, buf.currentTotalUsage.outputTokens - baselineUsage.outputTokens)
        recordUsage({
          source: 'codex',
          sessionId: buf.sessionId,
          model: buf.model && buf.model !== 'unknown' ? buf.model : undefined,
          tokens: {
            // 与 claude 同口径:input 取「非缓存有效输入」,cacheRead 单列,codex 无 cacheCreation
            input: Math.max(0, dInput - dCached),
            output: dOutput,
            cacheRead: dCached,
            cacheCreation: 0,
            total: delta
          },
          // 会话维度富化(D3):会话首个 user_message 截断作 title;命中 Jira 分支时附 jiraKey。
          title: truncateTitle(buf.title) || undefined,
          jiraKey: buf.issueKey || undefined,
          // 会话所属项目 / 分支(best-effort,buffer 已持有 gitRoot / branch)。
          projectName: readProjectNameFromPackageJson(buf.gitRoot) || undefined,
          branch: buf.branch || undefined,
          at: reportedAt
        })
      } catch {
        /* 整体用量采集失败绝不影响需求维度采集 */
      }
    }

    // issueKey 为空(非 Jira 分支)→ 仅记整体用量,不写需求 binding / iteration。
    if (!buf.issueKey) return

    const result = appendTokenUsage(
      buf.gitRoot,
      buf.branch,
      buf.issueKey,
      delta,
      reportedAt,
      'codex'
    )

    // 未 upsertBinding → pending 已累加,iteration 不写(等 init 时 carry over)
    if (!result.bound || !result.binding) return

    const requirement = loadRequirement(buf.issueKey)
    if (!requirement) return

    const extras = buildIterationExtras({
      gitRoot: buf.gitRoot,
      binding: result.binding,
      now: new Date(reportedAt),
      previousReportedAt: result.previousReportedAt,
      turnStartedAt: buf.userPromptTs,
      source: 'codex',
      modelName: buf.model,
      initBaseCommit: requirement.initBaseCommit ?? '',
      jiraKey: buf.issueKey
    })

    appendIteration(buf.issueKey, {
      kind: 'coding',
      branch: buf.branch,
      source: 'codex',
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
      reportedAt,
      rawPayload: {
        source: 'codex-watcher',
        model: buf.model,
        sessionId: buf.sessionId,
        userPromptTs: buf.userPromptTs,
        lastEventTs: buf.lastEventTs,
        turnEffectiveTokens: delta,
        cumulativeEffectiveTokens: buf.currentTotalEffective
      }
    })
  }
}
