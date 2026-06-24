import type { ServerResponse } from 'node:http'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  cursorHooksPath as defaultCursorHooksPath,
  inspectCursorHook,
  installCursorHookFile,
  type CursorHookInspectResult,
  type InstallCursorHookResult
} from '@ai-productivity-tracker/hook-core'

import type { ServerConfig as ServiceConfig } from '../config.js'
import {
  parseJiraReference,
  extractIssueKey,
  findGitRoot,
  getCurrentBranch,
  appendTokenUsage,
  readBindings,
  resetBindingForNewInit,
  resolveActiveBindingByCwd,
  upsertBinding,
  appendDedupeKey,
  DEFAULT_DEDUPE_PATH,
  hasDedupeKey,
  loadDedupeState,
  saveDedupeState,
  buildIterationExtras,
  collectNumstat,
  getHeadSha,
  readProjectNameFromPackageJson,
  buildOverallSummary,
  buildSummaryView,
  ensureBoundedJql,
  fetchJiraBugTotal,
  fetchJiraIssueSummary,
  inspectJiraIssueSummary,
  renderJqlTemplate,
  JiraBugFetchError,
  type TranscriptWatcherStatus,
  type DedupeState,
  type GitDiffSummary,
  type NumstatMap,
  type JiraIssueSummaryReason
} from '@ai-productivity-tracker/core'
import {
  aipRoot,
  isValidLessonId,
  numstatMapToRecord,
  writeNumstatSnapshot,
  listRequirementsFromStore,
  loadRequirement,
  saveRequirement,
  updateRequirement,
  appendIteration,
  listIterations,
  mergeAutoSplitIterations,
  appendSubtaskEvent,
  DEFAULT_FORMULA,
  readFormula,
  writeFormula,
  isJiraConfigured,
  readJiraConfig,
  writeJiraConfig,
  buildLessonsBundle,
  isStrongCandidateIteration,
  writeLessonHandledSentinel,
  LESSON_TYPES,
  listLessons,
  loadLesson,
  removeLesson,
  writeLessons,
  buildRetrospectiveBundle,
  loadRetrospective,
  listHarnessSuggestions,
  removeRetrospective,
  writeRetrospective,
  recordUsage,
  isUsageCaptureActive,
  setAiUsageEnabled,
  getAiUsageView,
  querySessions,
  truncateTitle,
  startBenchmark,
  stopBenchmark,
  cancelBenchmark,
  deleteBenchmark,
  readBenchmark,
  type AiUsageEvent,
  type AiUsageView,
  type AiUsageSource,
  type SessionUsageView,
  type SessionUsageSortKey,
  type SessionUsageSortDir,
  type UsageBenchmarkActive,
  type UsageBenchmarkSession,
  type UsageBenchmarkFile,
  type StoredRequirement,
  type StoredSubtask,
  type UpdateRequirementPatch,
  type IterationSource,
  type FormulaSettings,
  type JiraStoredConfig,
  type LessonExtractedBy,
  type LessonType,
  type WriteLessonInput,
  type WriteRetrospectiveInput,
  type RetrospectiveSource,
  type RetrospectiveNarrative,
  type RetrospectiveHarnessSummary
} from '@ai-productivity-tracker/core/store'

// ────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────

interface OkEnvelope<T> {
  code: 'OK'
  message: string
  data: T
}
interface ErrEnvelope {
  code: 'ERROR'
  message: string
  data: null
}

function ok<T>(res: ServerResponse, data: T): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 'OK', message: '', data } satisfies OkEnvelope<T>))
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 'ERROR', message, data: null } satisfies ErrEnvelope))
}

// ────────────────────────────────────────────────────────────────────
// Init / Status / Hook (IDE → agent,token 鉴权链路)
// ────────────────────────────────────────────────────────────────────

export interface InitRequestBody {
  jiraInput: string
  title?: string
  projectRoot?: string
  summary?: string
  manualEstimateMinutes?: number
  complexity?: 'low' | 'medium' | 'high'
  affectedPaths?: string[]
  subtasks?: Array<{ id: string; title: string; weight: number; done?: boolean }>
  /** clarify-requirement 报告路径,前端 init 时可选透传,审计用 */
  clarifyReportPath?: string
  clarifyReviewerScore?: number | null
  clarifyConflicts?: StoredRequirement['clarifyConflicts']
}

export async function handleAiProductivityInit(
  res: ServerResponse,
  _config: ServiceConfig,
  body: InitRequestBody
): Promise<void> {
  if (!body?.jiraInput) {
    fail(res, 400, '缺少 jiraInput')
    return
  }

  const ref = parseJiraReference(body.jiraInput)
  if (!ref) {
    fail(res, 400, '无法从 jiraInput 中解析出 Jira Key,请检查 URL 或直接传 ABC-123 形式的 key')
    return
  }

  const cwd = body.projectRoot && body.projectRoot.trim() ? body.projectRoot : process.cwd()

  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    fail(res, 409, `${cwd} 不是 git 仓库,请在业务项目根目录调用`)
    return
  }

  const branch = getCurrentBranch(gitRoot)
  if (!branch) {
    fail(res, 409, '当前处于 detached HEAD 状态,请先 checkout 到分支')
    return
  }

  const branchIssueKey = extractIssueKey(branch)
  if (!branchIssueKey) {
    fail(
      res,
      409,
      `当前分支 ${branch} 不包含 Jira Issue Key,请切到形如 feature/${ref.jiraKey}-xxx 的分支`
    )
    return
  }
  if (branchIssueKey !== ref.jiraKey) {
    fail(
      res,
      409,
      `当前分支 ${branch} 的 issueKey (${branchIssueKey}) 与传入的 ${ref.jiraKey} 不一致`
    )
    return
  }

  const normalizedSubtasks: StoredSubtask[] = (body.subtasks ?? []).map((item, idx) => ({
    id: item.id || `st-${idx + 1}`,
    title: item.title,
    weight: Math.max(1, Math.min(5, Number(item.weight) || 1)),
    done: Boolean(item.done)
  }))

  try {
    const now = new Date().toISOString()

    // 1. 优先用 Jira REST 实际标题; 失败 / 未配置 -> 退回 body.title -> jiraKey
    const fallbackTitle = (body.title ?? '').trim()
    const jiraConfigForInit = readJiraConfig()
    const fetchedTitle = await fetchJiraIssueSummary(jiraConfigForInit, ref.jiraKey)
    const resolvedTitle = (fetchedTitle ?? '').trim() || fallbackTitle || ref.jiraKey

    // 2. 项目名取 <gitRoot>/package.json 的 name 字段, 失败回退到 basename(gitRoot)
    const projectSlug = readProjectNameFromPackageJson(gitRoot)

    // 3. 记录 init 时的 HEAD sha, 后续 iteration 用作 diff baseRef
    const initBaseCommit = getHeadSha(gitRoot)

    // 4. snapshot-on-init:把当下全局 formula.wThink 整体快照到 requirement,
    //    之后调全局不再影响这条需求 boost,只能在需求详情卡片里单独编辑。
    const initFormulaWThinkOverride = readFormula().wThink

    const requirement = saveRequirement(
      {
        jiraKey: ref.jiraKey,
        jiraUrl: ref.jiraUrl ?? '',
        title: resolvedTitle,
        summary: body.summary ?? '',
        complexity: body.complexity ?? 'medium',
        manualEstimateMinutes: body.manualEstimateMinutes ?? 0,
        affectedPaths: body.affectedPaths ?? [],
        subtasks: normalizedSubtasks,
        projectSlug,
        initBaseCommit,
        formulaWThinkOverride: initFormulaWThinkOverride,
        clarifyReportPath: body.clarifyReportPath ?? '',
        clarifyReviewerScore: body.clarifyReviewerScore ?? null,
        clarifyConflicts: body.clarifyConflicts ?? [],
        startedAt: now
      },
      { root: undefined, repoPath: gitRoot }
    )

    // 落一条 init iteration,供时间线起点
    appendIteration(ref.jiraKey, { kind: 'init', branch }, undefined)

    // v2.7.0: init 之后立即采集一次基线 numstat-snapshot, 让后续 iteration 的
    // 「本次对话变更」以 init 时刻工作区为零基线,避免把工作区里早就存在的脏文件
    // (与本需求无关的未提交修改) 算到首条 coding iteration 上。
    try {
      const baseRef = initBaseCommit || 'HEAD'
      const baselineNumstat = collectNumstat(gitRoot, baseRef)
      writeNumstatSnapshot(ref.jiraKey, {
        version: 1,
        baseRef,
        perFile: numstatMapToRecord(baselineNumstat),
        updatedAt: now
      })
    } catch {
      // 基线写盘失败不阻塞 init
    }

    // v2.7.2: init 等价于「该需求从 0 开始新一轮追踪」 — 同 jiraKey 已有 binding 时
    // 必须 reset cumulativeToken / startedAt / requirementStartedAt / lastIterationSeq /
    // lastReportedAt / lastHookFiredAt + 删除 pending[jiraKey],避免历史包袱被后续
    // upsertBinding 的「existing 保留」分支继承,导致首条新 iteration 累计虚高。
    // hook 累加路径不受影响,保持「分支后续上报继续累加」语义。
    resetBindingForNewInit(gitRoot, ref.jiraKey, branch, now)

    const binding = upsertBinding(gitRoot, ref.jiraKey, {
      branch,
      startedAt: now,
      requirementStartedAt: requirement.startedAt
    })

    const panelUrl = `http://127.0.0.1:17280/ai-productivity/requirements/${ref.jiraKey}`

    ok(res, {
      jiraKey: requirement.jiraKey,
      branch: binding.branch,
      gitRoot,
      panelUrl,
      requirement
    })
  } catch (err) {
    fail(res, 500, err instanceof Error ? err.message : '未知错误')
  }
}

export interface StatusRequestQuery {
  projectRoot?: string
}

export function handleAiProductivityStatus(
  res: ServerResponse,
  _config: ServiceConfig,
  query: StatusRequestQuery
): void {
  const cwd = query.projectRoot?.trim() || process.cwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    ok(res, { bound: false, branch: null, issueKey: null, gitRoot: null })
    return
  }

  const branch = getCurrentBranch(gitRoot)
  const issueKey = branch ? extractIssueKey(branch) : null

  if (!issueKey) {
    ok(res, { bound: false, branch, issueKey: null, gitRoot })
    return
  }

  const bindings = readBindings(gitRoot)
  const entry = bindings.bindings[issueKey] ?? null

  ok(res, {
    bound: Boolean(entry),
    branch,
    issueKey,
    jiraKey: entry?.jiraKey ?? issueKey,
    cumulativeToken: entry?.cumulativeToken ?? 0,
    startedAt: entry?.startedAt ?? null,
    gitRoot
  })
}

export function handleAiProductivityWatcherStatus(
  res: ServerResponse,
  _config: ServiceConfig,
  getStatus: () => TranscriptWatcherStatus | null
): void {
  const snap: TranscriptWatcherStatus = getStatus() ?? {
    running: false,
    claudeProjectsDir: '',
    trackedFiles: 0,
    startedAt: null
  }
  ok(res, snap)
}

// ────────────────────────────────────────────────────────────────────
// v1.0.0-rc.18 Cursor turn-start / turn-thought 内存 Map
//
// Cursor `afterAgentResponse` 单点不知道本轮真实起点,旧版只能用「上一次 hook → 本次 hook」
// 近似 thinkSeconds + 60s cap,thinking 模型下大量被截。新链路引入两个独立 hook 事件:
//   - `beforeSubmitPrompt` → POST /ai-productivity/turn-start (本函数)
//   - `afterAgentThought`  → POST /ai-productivity/turn-thought (本函数)
// 用 `${conversation_id}|${generation_id}` 作 key 暂存到本 Map,等 afterAgentResponse 触发
// 的 /ai-productivity/hook 主路径消费(buildIterationExtras 接 turnStartedAt + pureThinkSeconds)。
//
// 设计点:
//   - 仅内存:daemon 重启时丢失 → 退化到现有 60s fallback,行为兼容。
//   - FIFO 上限 200(实测一次活跃会话 < 50 turn),超出按插入顺序剔除最旧。
//   - 软过期:每次写/读时顺手清理 expireAt < now 的条目,无后台定时器。
//   - 单元测试通过导出的 reset/get 函数注入,避免污染。
// ────────────────────────────────────────────────────────────────────

interface CursorTurnStartEntry {
  startedAt: string
  thoughtDurationMs: number
  expireAt: number
}

const CURSOR_TURN_STARTS_LIMIT = 200
const CURSOR_TURN_STARTS_TTL_MS = 30 * 60_000

const cursorTurnStarts = new Map<string, CursorTurnStartEntry>()

/**
 * A2 观测:turn-start / turn-thought / consume 三个事件的到达时序 + thoughtDurationMs 状态。
 *
 * 由 `AI_PRODUCTIVITY_DEBUG_HOOK=1` 控制(与 hook 端同款开关,用户排查时一并设到 daemon 环境)。
 * 输出写 daemon stdout(被 daemon-out.log 收集),用于量化 afterAgentResponse(consume) 与尾随
 * afterAgentThought(accumulate) 的到达先后,坐实跨进程竞态导致 thinking 被丢弃。
 */
function turnDebugLog(event: string, fields: Record<string, unknown>): void {
  if (process.env.AI_PRODUCTIVITY_DEBUG_HOOK !== '1') return
  try {
    console.info(
      `[turn-debug] ${event} ${JSON.stringify({ at: new Date().toISOString(), ...fields })}`
    )
  } catch {
    /* 观测失败不影响主流程 */
  }
}

function buildTurnKey(conversationId: string, generationId: string): string {
  return `${conversationId}|${generationId}`
}

function evictExpiredTurnStarts(now: number): void {
  for (const [key, entry] of cursorTurnStarts) {
    if (entry.expireAt <= now) cursorTurnStarts.delete(key)
  }
}

function evictOldestIfFull(): void {
  while (cursorTurnStarts.size > CURSOR_TURN_STARTS_LIMIT) {
    const oldest = cursorTurnStarts.keys().next().value
    if (oldest === undefined) break
    cursorTurnStarts.delete(oldest)
  }
}

/** 单测用:外部清零内存状态 */
export function __resetCursorTurnStartsForTest(): void {
  cursorTurnStarts.clear()
}

/** 单测用:观测内存状态 */
export function __snapshotCursorTurnStarts(): Array<[string, CursorTurnStartEntry]> {
  return [...cursorTurnStarts.entries()]
}

export interface TurnStartRequestBody {
  projectRoot?: string
  conversationId?: string
  generationId?: string
}

export interface TurnStartResponse {
  ok: true
  /** happy path = true;字段缺失或 conversation_id/generation_id 空时为 false + reason */
  recorded: boolean
  reason?: 'missing_ids'
}

export interface TurnThoughtRequestBody {
  conversationId?: string
  generationId?: string
  durationMs?: number
}

export interface TurnThoughtResponse {
  ok: true
  /** false 表示对应 turn-start entry 不存在(daemon 重启错过 beforeSubmitPrompt),no-op */
  applied: boolean
  /** 累加之后的总时长(ms),便于 daemon 调试 */
  totalMs?: number
  reason?: 'missing_ids' | 'no_pending_turn' | 'invalid_duration'
}

export interface TurnHandlerDeps {
  nowFn?: () => Date
}

/**
 * v1.0.0-rc.18 `/ai-productivity/turn-start`:Cursor `beforeSubmitPrompt` 上报本轮起点。
 *
 * 失败语义:`conversation_id` / `generation_id` 任一空 → 200 + reason='missing_ids' + recorded=false,
 * hook 端 fail-open 不阻塞 IDE。HTTP 200 + envelope 与其它路由一致(便于看板 / e2e 复用 ok helper)。
 */
export function handleAiProductivityTurnStart(
  res: ServerResponse,
  body: TurnStartRequestBody | null,
  deps: TurnHandlerDeps = {}
): void {
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''
  const generationId = typeof body?.generationId === 'string' ? body.generationId.trim() : ''
  if (!conversationId || !generationId) {
    ok(res, { ok: true, recorded: false, reason: 'missing_ids' } satisfies TurnStartResponse)
    return
  }
  const nowDate = (deps.nowFn ?? (() => new Date()))()
  const now = nowDate.getTime()
  evictExpiredTurnStarts(now)

  const key = buildTurnKey(conversationId, generationId)
  // 已存在则覆盖:典型场景是 Cursor stop hook 强制 followup_message 重新提交,
  // 同 generation_id 不会复用但同 conversation_id + 新 generation_id 会形成新 entry。
  // 覆盖也是安全的(insertion order 重置),不会污染 FIFO。
  if (cursorTurnStarts.has(key)) cursorTurnStarts.delete(key)
  cursorTurnStarts.set(key, {
    startedAt: nowDate.toISOString(),
    thoughtDurationMs: 0,
    expireAt: now + CURSOR_TURN_STARTS_TTL_MS
  })
  evictOldestIfFull()
  turnDebugLog('turn-start', { key })

  ok(res, { ok: true, recorded: true } satisfies TurnStartResponse)
}

/**
 * v1.0.0-rc.18 `/ai-productivity/turn-thought`:Cursor `afterAgentThought` 上报本块 thinking 时长。
 *
 * 累加到对应 turn-start entry 的 thoughtDurationMs。entry 不存在时(典型:daemon 重启错过
 * beforeSubmitPrompt)200 + applied=false,no-op。durationMs 非有限数 / 负数 → 200 + invalid_duration。
 */
export function handleAiProductivityTurnThought(
  res: ServerResponse,
  body: TurnThoughtRequestBody | null,
  deps: TurnHandlerDeps = {}
): void {
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''
  const generationId = typeof body?.generationId === 'string' ? body.generationId.trim() : ''
  if (!conversationId || !generationId) {
    ok(res, { ok: true, applied: false, reason: 'missing_ids' } satisfies TurnThoughtResponse)
    return
  }
  const rawDuration = body?.durationMs
  if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration) || rawDuration < 0) {
    ok(res, { ok: true, applied: false, reason: 'invalid_duration' } satisfies TurnThoughtResponse)
    return
  }

  const nowDate = (deps.nowFn ?? (() => new Date()))()
  const now = nowDate.getTime()
  evictExpiredTurnStarts(now)

  const key = buildTurnKey(conversationId, generationId)
  const entry = cursorTurnStarts.get(key)
  if (!entry) {
    turnDebugLog('thought-dropped', { key, rawDuration, reason: 'no_pending_turn' })
    ok(res, {
      ok: true,
      applied: false,
      reason: 'no_pending_turn'
    } satisfies TurnThoughtResponse)
    return
  }
  entry.thoughtDurationMs += rawDuration
  turnDebugLog('thought-applied', { key, rawDuration, totalMs: entry.thoughtDurationMs })
  ok(res, {
    ok: true,
    applied: true,
    totalMs: entry.thoughtDurationMs
  } satisfies TurnThoughtResponse)
}

/**
 * v1.0.0-rc.18 afterAgentResponse 主路径用:消费并 delete 对应 entry。
 *
 * 返回 null 表示没有匹配 turn-start(老 hook / daemon 重启 / 非 Cursor 链路),
 * 调用方走原有 60s fallback。返回结构含 startedAt(ISO)与 pureThinkSeconds(秒,Math.round)。
 */
function consumeCursorTurnStart(
  rawHookPayload: Record<string, unknown> | undefined,
  source: string,
  now: number
): { startedAt: string; pureThinkSeconds: number } | null {
  if (source !== 'cursor-hook' || !rawHookPayload) return null
  const conversationId =
    typeof rawHookPayload.conversation_id === 'string' ? rawHookPayload.conversation_id : ''
  const generationId =
    typeof rawHookPayload.generation_id === 'string' ? rawHookPayload.generation_id : ''
  if (!conversationId || !generationId) return null
  evictExpiredTurnStarts(now)
  const key = buildTurnKey(conversationId, generationId)
  const entry = cursorTurnStarts.get(key)
  if (!entry) {
    turnDebugLog('consume-miss', { key })
    return null
  }
  cursorTurnStarts.delete(key)
  turnDebugLog('consume', { key, thoughtDurationMs: entry.thoughtDurationMs })
  return {
    startedAt: entry.startedAt,
    pureThinkSeconds: Math.round(entry.thoughtDurationMs / 1000)
  }
}

export interface HookRequestBody {
  projectRoot?: string
  branch?: string
  tokens: number
  source: string
  dedupeKey?: string
  rawHookPayload?: Record<string, unknown>
  /**
   * AI 整体用量旁路(D3):hook-core 在「无 project root(非仓库会话)」场景下置 true,
   * daemon recordUsage 后立即返回,不解析 git / 不写需求。详见 hook-core agent-client。
   */
  usageOnly?: boolean
}

function rawNum(payload: Record<string, unknown> | undefined, key: string): number {
  const v = payload?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** 读 transcript 取首条 user 文本时的最大字节数(够覆盖首批消息,避免读超大文件)。 */
const TRANSCRIPT_TITLE_MAX_BYTES = 2 * 1024 * 1024

/**
 * 从任意 transcript 行对象 best-effort 提取「user 文本」:
 * 兼容 `role/type === 'user'` + `content`(字符串或 text 块数组) / `message.content` / `text`。
 * 非 user 行或无文本返回空串。
 */
function extractUserTextFromTranscriptObj(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, unknown>
  const role = typeof o.role === 'string' ? o.role : typeof o.type === 'string' ? o.type : ''
  if (role !== 'user') return ''
  const msg = (o.message && typeof o.message === 'object' ? o.message : o) as Record<
    string,
    unknown
  >
  const content = msg.content ?? o.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      } else if (typeof block === 'string') {
        parts.push(block)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/**
 * Best-effort 读 Cursor transcript_path 首条 user 行文本作会话标题素材(D3)。
 *
 * 读不到文件 / 解析失败 / 无 user 行一律安全返回空串(标题留空,不阻断用量累加)。
 * 仅读前 TRANSCRIPT_TITLE_MAX_BYTES 字节,逐行 JSON 解析,命中首条 user 文本即返回。
 */
function readTranscriptTitle(transcriptPath: unknown): string {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return ''
  if (!existsSync(transcriptPath)) return ''
  let fd: number
  try {
    fd = openSync(transcriptPath, 'r')
  } catch {
    return ''
  }
  try {
    const chunkSize = 64 * 1024
    const buf = Buffer.alloc(chunkSize)
    let acc = ''
    let total = 0
    while (total < TRANSCRIPT_TITLE_MAX_BYTES) {
      const bytes = readSync(fd, buf, 0, chunkSize, total)
      if (bytes <= 0) break
      total += bytes
      acc += buf.toString('utf-8', 0, bytes)
      let nl: number
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl)
        acc = acc.slice(nl + 1)
        if (line.trim()) {
          try {
            const text = extractUserTextFromTranscriptObj(JSON.parse(line))
            if (text.trim()) return text
          } catch {
            /* 跳过非 JSON 行 */
          }
        }
      }
    }
    if (acc.trim()) {
      try {
        return extractUserTextFromTranscriptObj(JSON.parse(acc))
      } catch {
        /* ignore */
      }
    }
    return ''
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/**
 * 由 Cursor hook payload 归一化出「AI 整体用量」事件(D2)。
 *
 * 仅 cursor 来源返回事件(claude/codex 整体用量由各自 watcher 覆盖,避免双算)。
 * token 细分与 claude/codex 同口径:`total` 取有效用量(= body.tokens),
 * `input` 取剔除 cache 后的纯新增输入,cacheRead/cacheCreation 透传 Cursor 的
 * cache_read/cache_write。缺维度安全降级。仅结构化元数据 + 截断会话标题,不含完整正文。
 */
function buildCursorUsageEvent(body: HookRequestBody, at: string): AiUsageEvent | null {
  if (mapHookSource(body.source) !== 'cursor') return null
  const total = Number(body.tokens)
  if (!Number.isFinite(total) || total <= 0) return null

  const raw = body.rawHookPayload
  const inputTokens = rawNum(raw, 'input_tokens')
  const output = rawNum(raw, 'output_tokens')
  const cacheRead = rawNum(raw, 'cache_read_tokens')
  const cacheCreation = rawNum(raw, 'cache_write_tokens')
  // 纯新增输入 = 总输入 - cache_read - cache_write(input_tokens 含 cache 细分,见 hook parseHookTokens)
  const input = Math.max(0, inputTokens - cacheRead - cacheCreation)

  const model = typeof raw?.model === 'string' && raw.model ? raw.model : undefined
  const sessionId =
    (typeof raw?.conversation_id === 'string' && raw.conversation_id) ||
    (typeof body.dedupeKey === 'string' && body.dedupeKey) ||
    ''

  // 会话维度富化(D3):best-effort 读 transcript 首条 user 行作 title(读不到留空);
  // 已解析 issueKey 时填 jiraKey(从 branch 提取,main / 非仓库会话留空)。
  const title = truncateTitle(readTranscriptTitle(raw?.transcript_path)) || undefined
  const jiraKey = (typeof body.branch === 'string' && extractIssueKey(body.branch)) || undefined

  return {
    source: 'cursor',
    sessionId,
    model,
    tokens: { input, output, cacheRead, cacheCreation, total },
    title,
    jiraKey,
    at
  }
}

/**
 * v2.5.0 把 hook 入口上报的 source 字符串归一化为 IterationSource。
 *
 * - 'cursor-hook'  → 'cursor'(Cursor IDE 通过 hooks.json 触发 mcp.mjs hook)
 * - 'claude-hook'  → 'claude-code'(Claude Code 的 Stop hook 触发 mcp.mjs hook)
 * - 'codex-hook'   → 'codex'(Codex CLI 的 hook 触发,实际硬数据走 CodexWatcher)
 * - 其它/缺失      → 'unknown'
 */
function mapHookSource(raw: string): IterationSource {
  if (raw === 'cursor-hook') return 'cursor'
  if (raw === 'claude-hook') return 'claude-code'
  if (raw === 'codex-hook') return 'codex'
  return 'unknown'
}

export interface HookResponse {
  ok: true
  deduped: boolean
  bound: boolean
  accumulated: number
  cumulativeToken?: number
  jiraKey?: string
  iterationSeq?: number
  reason?: string
}

export interface HookDeps {
  dedupePath?: string
  collectDiff?: (gitRoot: string, baseRef: string) => GitDiffSummary
  collectNumstatFn?: (gitRoot: string, baseRef: string) => NumstatMap
  nowFn?: () => Date
}

export async function handleAiProductivityHook(
  res: ServerResponse,
  _config: ServiceConfig,
  body: HookRequestBody,
  deps: HookDeps = {}
): Promise<void> {
  if (!body || typeof body !== 'object') {
    fail(res, 400, '缺少 hook payload')
    return
  }

  const tokens = Number(body.tokens)
  if (!Number.isFinite(tokens) || tokens < 0) {
    fail(res, 400, 'tokens 必须 >= 0 的有限数')
    return
  }

  const source = typeof body.source === 'string' && body.source ? body.source : 'unknown-hook'
  const dedupePath = deps.dedupePath ?? DEFAULT_DEDUPE_PATH
  const dedupeKey = typeof body.dedupeKey === 'string' && body.dedupeKey ? body.dedupeKey : ''

  let dedupeState: DedupeState | null = null
  if (dedupeKey) {
    dedupeState = loadDedupeState(dedupePath)
    if (hasDedupeKey(dedupeState, dedupeKey)) {
      ok(res, {
        ok: true,
        deduped: true,
        bound: false,
        accumulated: 0,
        reason: `dedupeKey ${dedupeKey} 已处理`
      } satisfies HookResponse)
      return
    }
  }

  if (tokens === 0) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: 'tokens=0,无累加'
    } satisfies HookResponse)
    return
  }

  // AI 整体用量 + 用量测算旁路(D2/D3/4.2):在 issueKey 解析之前记录 Cursor 用量,独立于 Jira 绑定。
  // 放在 dedupe 闸门之后(去重事件不重复累加);闸门 isUsageCaptureActive = 整体用量开启 或
  // 有进行中测算会话,都不活跃时短路;容错静默。
  const usageAt = (deps.nowFn ?? (() => new Date()))().toISOString()
  let cursorUsageRecorded = false
  if (isUsageCaptureActive()) {
    try {
      const ev = buildCursorUsageEvent(body, usageAt)
      if (ev) {
        recordUsage(ev)
        cursorUsageRecorded = true
      }
    } catch {
      /* 整体用量采集失败绝不影响既有需求链路 */
    }
  }

  // 整体用量已记 → 立即持久化 dedupeKey(appendDedupeKey 幂等),避免「非 Jira 分支等
  // issueKey 闸门提前 return、dedupeKey 未落盘」导致同一事件重复累加整体用量。
  if (cursorUsageRecorded && dedupeKey) {
    try {
      saveDedupeState(
        dedupePath,
        appendDedupeKey(dedupeState ?? loadDedupeState(dedupePath), dedupeKey, usageAt)
      )
    } catch (err) {
      console.warn(`[ai-productivity hook] 持久化用量 dedupe 失败: ${(err as Error).message}`)
    }
  }

  // 仅用量信号(无仓库会话):记完即返回,不解析 git / 不写需求 binding/iteration。
  if (body.usageOnly) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: '仅整体用量信号(usageOnly)'
    } satisfies HookResponse)
    return
  }

  const cwd = body.projectRoot && body.projectRoot.trim() ? body.projectRoot : process.cwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: `${cwd} 不是 git 仓库`
    } satisfies HookResponse)
    return
  }

  const branch = (body.branch && body.branch.trim()) || getCurrentBranch(gitRoot)
  if (!branch) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: 'detached HEAD,跳过累加'
    } satisfies HookResponse)
    return
  }

  const issueKey = extractIssueKey(branch)
  if (!issueKey) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: `分支 ${branch} 不含 Jira Issue Key`
    } satisfies HookResponse)
    return
  }

  const nowDate = (deps.nowFn ?? (() => new Date()))()
  const now = nowDate.toISOString()
  const result = appendTokenUsage(gitRoot, branch, issueKey, tokens, now, source)

  let iterationSeq: number | undefined
  if (result.bound && result.binding) {
    try {
      const rawModel = body.rawHookPayload?.model
      const modelName = typeof rawModel === 'string' ? rawModel : ''
      const requirementForBase = loadRequirement(issueKey)
      const initBaseCommit = requirementForBase?.initBaseCommit ?? ''
      // v1.0.0-rc.18 消费 cursorTurnStarts:有真实 beforeSubmitPrompt 时拿到本轮起点 + 纯思考累加;
      // 无则返 null,buildIterationExtras 走原有 60s fallback,行为完全兼容。
      const turnStart = consumeCursorTurnStart(body.rawHookPayload, source, nowDate.getTime())
      const extras = buildIterationExtras({
        gitRoot,
        binding: result.binding,
        now: nowDate,
        previousReportedAt: result.previousReportedAt,
        // v1.0.0-rc.18 turnStart 命中时走 Claude Code 同款真实口径(300s cap);否则保留 v2.12.0
        // 收紧的 60s fallback,避免「上一轮 → 本轮」差值里用户阅读/输入时间被算成 AI 思考。
        turnStartedAt: turnStart?.startedAt,
        pureThinkSeconds: turnStart?.pureThinkSeconds,
        source,
        modelName,
        initBaseCommit,
        jiraKey: issueKey,
        collectDiff: deps.collectDiff,
        collectNumstatFn: deps.collectNumstatFn
      })

      const iteration = appendIteration(issueKey, {
        kind: 'coding',
        branch,
        source: mapHookSource(source),
        cumulativeToken: result.binding.cumulativeToken,
        elapsedMinutes: extras.elapsedMinutes,
        thinkSeconds: extras.thinkSeconds,
        pureThinkSeconds: extras.pureThinkSeconds,
        diffFiles: extras.diffFiles,
        diffInsertions: extras.diffInsertions,
        diffDeletions: extras.diffDeletions,
        changedFiles: extras.changedFiles,
        cumulativeDiffFiles: extras.cumulativeDiffFiles,
        cumulativeDiffInsertions: extras.cumulativeDiffInsertions,
        cumulativeDiffDeletions: extras.cumulativeDiffDeletions,
        cumulativeChangedFiles: extras.cumulativeChangedFiles,
        modelName: extras.modelName,
        reportedAt: now,
        rawPayload: {
          source,
          dedupeKey: dedupeKey || null,
          ...(body.rawHookPayload ?? {}),
          // 落盘 turn-start 命中标记,便于审计「本条 iteration 是否用了真实本轮起点」
          turnStartedAt: turnStart?.startedAt ?? null,
          pureThinkSeconds: turnStart?.pureThinkSeconds ?? null
        }
      })
      iterationSeq = iteration.seq
    } catch (err) {
      console.warn(
        `[ai-productivity hook] appendIteration 失败 ${issueKey}: ${(err as Error).message}`
      )
    }
  }

  if (dedupeKey) {
    const next = appendDedupeKey(dedupeState ?? loadDedupeState(dedupePath), dedupeKey, now)
    try {
      saveDedupeState(dedupePath, next)
    } catch (err) {
      console.warn(`[ai-productivity hook] 持久化 dedupe state 失败: ${(err as Error).message}`)
    }
  }

  ok(res, {
    ok: true,
    deduped: false,
    bound: result.bound,
    accumulated: tokens,
    cumulativeToken: result.binding?.cumulativeToken,
    jiraKey: result.binding?.jiraKey,
    iterationSeq,
    reason: result.bound
      ? 'binding 命中,已累加并落本地'
      : `pending 累加 ${result.pendingAccumulated},等待 init 后吸收`
  } satisfies HookResponse)
}

// ────────────────────────────────────────────────────────────────────
// Cursor hook 安装 (UI 触发)
//
// v2.2.0 起 Cursor Hook 入口与 MCP server 复用同一份 ~/Downloads/ai-productivity-mcp.mjs:
//   - hooks.json 命令字符串形如 `node <abs-mjs> hook # ai-productivity-hook`
//   - .mjs 在 argv[2] === 'hook' 时跳过 MCP loop,直接跑 @platform/ai-productivity-hook-core 的 runHook
//   - agent 自己直接写 hooks.json,不再 spawn 任何外部进程
//   - 检测到老 CLI 路径(`~/.local/bin/ai-productivity`) 时返回 legacyHookDetected=true
//     让前端提示用户「将被覆盖」
// ────────────────────────────────────────────────────────────────────

/**
 * Cursor Hook 入口路径(`node <path> hook` 的 `<path>`)。
 *
 * v1.0(独立 npm 包架构):daemon 自己就是 `dist/cli.mjs` esbuild bundle 进程,
 * `process.argv[1]` 指向当前 cli.mjs 的真实绝对路径,直接用它作为 hook 入口即可。
 * 这样浏览器侧「一键注入 Hook」按钮不需要传 hookEntry 也能落正确路径
 * (此前残留兜底到 ~/Downloads/ai-productivity-mcp.mjs 是 v2.x 老下载模式遗物,
 * 在新架构下该文件不会存在 → install 报 412)。
 *
 * 兜底:`process.argv[1]` 不像本工具入口(测试场景 / 非 cli 进程)时回退到老
 * Downloads 路径,保留向后兼容。
 */
export function defaultHookEntryPath(): string {
  const arg1 = process.argv[1]
  if (arg1 && looksLikeAiptCliEntry(arg1) && existsSync(arg1)) return arg1
  return join(homedir(), 'Downloads', 'ai-productivity-mcp.mjs')
}

/**
 * 判定 `process.argv[1]` 是不是本工具 cli.mjs 入口。
 *
 * 真实生产态:`<npm global>/.../ai-productivity-tracker/cli/dist/cli.mjs`
 *           或本仓库 dev 态 `packages/cli/dist/cli.mjs`、`packages/cli/src/index.ts`
 *
 * 测试态(vitest):`process.argv[1]` 通常指向 vitest 自身 → 判定为否,走 fallback
 * 保持老路径不变,避免每个测试都要 mock argv。
 */
function looksLikeAiptCliEntry(entry: string): boolean {
  // 入口必须有 cli 字样,且属于本工具的 cli 包或 ai-productivity-tracker 路径
  return (
    /(\/|\\)cli\.(mjs|js)$/.test(entry) ||
    /ai-productivity-tracker[\\/]cli[\\/]/.test(entry) ||
    /packages[\\/]cli[\\/](dist|src)[\\/]/.test(entry)
  )
}

/**
 * v2.13.0 解析本地 mcp.mjs 的版本号.
 *
 * `packages/ai-productivity-mcp/build.mjs` 在 banner 写入固定标记
 * `// __AI_PRODUCTIVITY_MCP_VERSION__: X.Y.Z`(v2.13.0 起),agent 用稳定正则提取.
 * 仅读文件前 4KB,远超 banner 实际长度,避免大文件全量加载.
 *
 * 不依赖 esbuild emit 的 `VERSION = true ? "X.Y.Z"`(emission 风格未来可能变),
 * 也不依赖 `running (v...)` runtime 日志(版本字符串可能被多次复用).
 *
 * 老版本(v2.12.x 及之前 build 的 .mjs)无 banner marker,返回 null,
 * 前端展示「本地: 未知(可能是 ≤ 0.1.11 旧版本)」并提示用户重新下载.
 */
function readMcpEntryVersion(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.slice(0, n).toString('utf-8')
    const m = /__AI_PRODUCTIVITY_MCP_VERSION__:\s*([0-9][\w.\-+]*)/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export interface CursorHookStatusResponse {
  /** v2.2.0 起,Hook 入口 = MCP .mjs;字段名沿用 `hookEntryInstalled`(更准确) */
  hookEntryInstalled: boolean
  hookEntryPath: string
  /**
   * v2.13.0 本地 mcp.mjs 解析出的版本号(从 banner marker `// __AI_PRODUCTIVITY_MCP_VERSION__: X.Y.Z` 提取);
   * 文件不存在 / 无 marker(v2.12.x 及之前 build 的老 .mjs) → null,前端展示「未知」并引导重新下载.
   */
  hookEntryVersion: string | null
  /** v2.1.x 兼容别名;与 hookEntryInstalled 同值,前端切完后可移除 */
  cliInstalled: boolean
  /** v2.1.x 兼容别名 */
  cliPath: string
  hooksFileExists: boolean
  hookInstalled: boolean
  hookCommand: string | null
  debugMode: boolean
  /** hooks.json 里仍残留老 CLI(~/.local/bin/ai-productivity) 路径,前端提示「将被覆盖」 */
  legacyHookDetected: boolean
  /**
   * v1.0.0-rc.18 各事件独立装机状态,看板 / doctor 用来精准提示「缺哪条 hook」。
   * 老 daemon 缺该字段时前端按 `hookInstalled` 兜底,不破坏向前兼容。
   */
  perEvent?: {
    afterAgentResponse: boolean
    beforeSubmitPrompt: boolean
    afterAgentThought: boolean
  }
}

export function handleAiProductivityCursorHookStatus(res: ServerResponse): void {
  const hookEntryPath = defaultHookEntryPath()
  const hookEntryInstalled = existsSync(hookEntryPath)
  const hookEntryVersion = hookEntryInstalled ? readMcpEntryVersion(hookEntryPath) : null
  const hooksPath = defaultCursorHooksPath()
  const inspect: CursorHookInspectResult = inspectCursorHook(hooksPath)

  ok(res, {
    hookEntryInstalled,
    hookEntryPath,
    hookEntryVersion,
    cliInstalled: hookEntryInstalled,
    cliPath: hookEntryPath,
    hooksFileExists: inspect.hooksFileExists,
    hookInstalled: inspect.hookInstalled,
    hookCommand: inspect.hookCommand,
    debugMode: inspect.debugMode,
    legacyHookDetected: inspect.legacyHookDetected,
    perEvent: inspect.perEvent
  } satisfies CursorHookStatusResponse)
}

export interface InstallCursorHookRequestBody {
  debug?: boolean
  /**
   * v1.0 由 cli/install.ts 显式传入的 hook entry 绝对路径(通常 = npm 全局
   * 安装的 cli.mjs 路径,如 `/usr/local/lib/node_modules/@.../dist/cli.mjs`)。
   *
   * 不传时退回到 `defaultHookEntryPath()`,该路径在源仓库 v2.x 指向
   * `~/Downloads/ai-productivity-mcp.mjs`(手动下载模式,已下线)。
   */
  hookEntry?: string
}

export interface InstallCursorHookResponse {
  ok: boolean
  hookEntryPath: string
  /** v2.1.x 兼容别名 */
  cliPath: string
  hooksPath: string
  /** 注入完成后写入 hooks.json 的完整 command 字符串(含 marker、可能含 debug 前缀) */
  finalCommand: string
  /** 是否替换了已有的 marker 条目 */
  replaced: boolean
  /** 被替换前的老 command 字符串(若 replaced=true) */
  previousCommand: string | null
  errorMessage?: string
}

export interface InstallCursorHookDeps {
  /** 测试注入: 覆盖默认 hook 入口 .mjs 路径 */
  hookEntryPath?: string
  /** 测试注入: 覆盖默认 hooks.json 路径 */
  hooksPath?: string
  /** 测试注入: 覆盖 .mjs 存在性校验 */
  hookEntryExists?: (path: string) => boolean
  /** 测试注入: 覆盖写盘逻辑 */
  install?: typeof installCursorHookFile
}

export async function handleAiProductivityInstallCursorHook(
  res: ServerResponse,
  body: InstallCursorHookRequestBody | null,
  deps: InstallCursorHookDeps = {}
): Promise<void> {
  // v1.0 优先用 cli/install.ts 通过 body.hookEntry 传入的绝对路径(npm 全局 cli.mjs 位置)
  // 退回到 default 仅作为老用户兜底(指向 ~/Downloads/ai-productivity-mcp.mjs,
  // v2.x 手动下载模式已下线,此 fallback 仅给 web UI 等极少数无 cli 上下文的调用方)
  const hookEntryPath = deps.hookEntryPath ?? body?.hookEntry ?? defaultHookEntryPath()
  const hooksPath = deps.hooksPath ?? defaultCursorHooksPath()
  const entryExists = deps.hookEntryExists ?? existsSync

  if (!entryExists(hookEntryPath)) {
    fail(
      res,
      412,
      `未找到 MCP/Hook 入口: ${hookEntryPath}。请确认已通过 \`npm i -g @ai-productivity-tracker/cli\` 全局安装,或显式传 hookEntry 字段。`
    )
    return
  }

  // 用 process.execPath(当前 node 二进制的绝对路径)而不是 'node':
  // Cursor / Claude Code 从 macOS launchd 启动 hook 子进程时 PATH 只有系统默认,
  // nvm/volta/fnm 装的 node 不在里面,会触发 ENOENT。
  const nodeBin = process.execPath
  const installFn = deps.install ?? installCursorHookFile
  try {
    const result: InstallCursorHookResult = installFn({
      command: `${nodeBin} ${hookEntryPath} hook`,
      debug: body?.debug ?? false,
      hooksPath
    })
    ok(res, {
      ok: true,
      hookEntryPath,
      cliPath: hookEntryPath,
      hooksPath: result.hooksPath,
      finalCommand: result.finalCommand,
      replaced: result.replaced,
      previousCommand: result.previousCommand
    } satisfies InstallCursorHookResponse)
  } catch (err) {
    const e = err as { message?: string }
    ok(res, {
      ok: false,
      hookEntryPath,
      cliPath: hookEntryPath,
      hooksPath,
      finalCommand: '',
      replaced: false,
      previousCommand: null,
      errorMessage: e.message ?? '写入 hooks.json 失败'
    } satisfies InstallCursorHookResponse)
  }
}

// ────────────────────────────────────────────────────────────────────
// MCP 单文件 .mjs 一键下载 (Web 看板 → agent 本地落盘)
//
// 浏览器侧 fetch 同源静态 .mjs → base64 POST 进 body;agent 仅负责
// 解码 + 写到 defaultHookEntryPath()(~/Downloads/ai-productivity-mcp.mjs)
// + chmod 0o755。这样既保持「agent 不主动出网」的设计,又免除用户
// 手动 curl 步骤,装完即可与 install-cursor-hook 衔接。
// ────────────────────────────────────────────────────────────────────

const MCP_ENTRY_MAX_BYTES = 2 * 1024 * 1024
const MCP_ENTRY_SANITY_TOKENS = ['ai-productivity-mcp', 'modelcontextprotocol']

export interface InstallMcpEntryRequestBody {
  contentBase64?: string
}

export interface InstallMcpEntryResponse {
  ok: true
  path: string
  bytesWritten: number
  replaced: boolean
}

export interface InstallMcpEntryDeps {
  /** 测试注入: 覆盖默认 .mjs 落盘路径 */
  targetPath?: string
  /** 测试注入: 覆盖文件存在性检查 */
  exists?: (path: string) => boolean
  /** 测试注入: 覆盖目录创建 */
  ensureDir?: (path: string) => void
  /** 测试注入: 覆盖写盘逻辑(content,path,mode) */
  writeFile?: (path: string, content: Buffer, mode: number) => void
}

export async function handleAiProductivityInstallMcpEntry(
  res: ServerResponse,
  body: InstallMcpEntryRequestBody | null,
  deps: InstallMcpEntryDeps = {}
): Promise<void> {
  const target = deps.targetPath ?? defaultHookEntryPath()
  const exists = deps.exists ?? existsSync

  const contentBase64 = body?.contentBase64
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    fail(res, 400, 'contentBase64 必填,且必须为非空字符串')
    return
  }

  let buf: Buffer
  try {
    buf = Buffer.from(contentBase64, 'base64')
  } catch {
    fail(res, 400, 'contentBase64 解码失败')
    return
  }
  if (buf.length === 0) {
    fail(res, 400, 'contentBase64 解码后为空')
    return
  }
  if (buf.length > MCP_ENTRY_MAX_BYTES) {
    fail(res, 413, `mjs 体积超出限制 (${buf.length} > ${MCP_ENTRY_MAX_BYTES})`)
    return
  }

  const hit = MCP_ENTRY_SANITY_TOKENS.some((token) => buf.includes(token, 0, 'utf8'))
  if (!hit) {
    fail(res, 400, '上传内容不像 ai-productivity-mcp.mjs(全文未命中签名)')
    return
  }

  try {
    const ensureDir = deps.ensureDir ?? ((p: string) => mkdirSync(p, { recursive: true }))
    ensureDir(dirname(target))
    const replaced = exists(target)
    const writeFile =
      deps.writeFile ??
      ((p: string, c: Buffer, mode: number) => {
        writeFileSync(p, c)
        chmodSync(p, mode)
      })
    writeFile(target, buf, 0o755)
    ok(res, {
      ok: true,
      path: target,
      bytesWritten: buf.length,
      replaced
    } satisfies InstallMcpEntryResponse)
  } catch (err) {
    const e = err as { message?: string }
    fail(res, 500, e?.message ?? '写入 ai-productivity-mcp.mjs 失败')
  }
}

// ────────────────────────────────────────────────────────────────────
// Panel 读端点 (Web 看板, origin 放行)
// ────────────────────────────────────────────────────────────────────

function buildRequirementListResponse() {
  const formula = readFormula()
  const requirements = listRequirementsFromStore()
  return requirements.map((req) => buildSummaryView(req, listIterations(req.jiraKey), formula))
}

export function handleAiProductivityListRequirements(
  res: ServerResponse,
  filter: { owner?: string; status?: string; project?: string; q?: string }
): void {
  let list = buildRequirementListResponse()
  if (filter.owner) list = list.filter((it) => it.owner === filter.owner)
  if (filter.status) list = list.filter((it) => it.status === filter.status)
  if (filter.project) list = list.filter((it) => it.projectSlug === filter.project)
  if (filter.q) {
    const k = filter.q.toLowerCase()
    list = list.filter(
      (it) =>
        it.jiraKey.toLowerCase().includes(k) ||
        it.title.toLowerCase().includes(k) ||
        it.owner.toLowerCase().includes(k) ||
        it.projectSlug.toLowerCase().includes(k)
    )
  }
  ok(res, list)
}

export function handleAiProductivityGetRequirement(res: ServerResponse, jiraKey: string): void {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const formula = readFormula()
  const iterations = listIterations(jiraKey)
  const summary = buildSummaryView(requirement, iterations, formula)
  ok(res, { ...summary, iterations })
}

export function handleAiProductivityListIterations(res: ServerResponse, jiraKey: string): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  ok(res, listIterations(jiraKey))
}

// ────────────────────────────────────────────────────────────────────
// v2.18.0 数据整理:合并 Cursor stop-hook 兜底产生的拆分 iteration
//
// 看板"数据整理"按钮的后端入口。dryRun=true 时只扫描候选,不写盘;
// 否则按严格规则合并 + 自动写 .bak 备份。
// ────────────────────────────────────────────────────────────────────

export interface MergeSplitIterationsRequestBody {
  /** true 时只扫描候选 + 计数,不写盘也不备份 */
  dryRun?: boolean
}

export interface MergeSplitIterationsResponse {
  jiraKey: string
  dryRun: boolean
  mergedPairs: Array<{ fromSeq: number; intoSeq: number }>
  totalBefore: number
  totalAfter: number
  /** 仅真合并成功且产生备份时给出绝对路径,其它情形为 null */
  backupPath: string | null
}

export function handleAiProductivityMergeSplitIterations(
  res: ServerResponse,
  jiraKey: string,
  body: MergeSplitIterationsRequestBody | null
): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const dryRun = body?.dryRun === true
  try {
    const result = mergeAutoSplitIterations(jiraKey, { dryRun })
    ok(res, {
      jiraKey,
      dryRun,
      mergedPairs: result.mergedPairs,
      totalBefore: result.totalBefore,
      totalAfter: result.totalAfter,
      backupPath: result.backupPath
    } satisfies MergeSplitIterationsResponse)
  } catch (err) {
    fail(res, 500, err instanceof Error ? err.message : '合并失败')
  }
}

export function handleAiProductivitySummary(res: ServerResponse): void {
  const views = buildRequirementListResponse()
  ok(res, buildOverallSummary(views))
}

export function handleAiProductivityGetFormula(res: ServerResponse): void {
  ok(res, readFormula())
}

export function handleAiProductivityGetJiraConfig(res: ServerResponse): void {
  const c = readJiraConfig()
  ok(res, {
    configured: isJiraConfigured(c),
    baseUrl: c.baseUrl,
    apiEmail: c.apiEmail,
    bugJqlTemplate: c.bugJqlTemplate
  })
}

export function handleAiProductivityStoragePath(res: ServerResponse): void {
  ok(res, { root: aipRoot() })
}

// ────────────────────────────────────────────────────────────────────
// Panel 写端点 (Web 看板, origin 放行)
// ────────────────────────────────────────────────────────────────────

export interface PatchRequirementBody {
  status?: 'in_progress' | 'finished' | 'abandoned'
  title?: string
  summary?: string
  manualEstimateMinutes?: number
  complexity?: 'low' | 'medium' | 'high'
  /**
   * 需求级 wThink 覆盖值。
   * - `number`(取值 ∈ [0,1],超出范围会被 daemon clamp):写入覆盖,需求与全局解耦
   * - `null`:显式清除,回退到「跟随全局 wThink」(老需求兼容路径)
   * - `undefined`(字段缺省):不修改该字段
   */
  formulaWThinkOverride?: number | null
}

export function handleAiProductivityPatchRequirement(
  res: ServerResponse,
  jiraKey: string,
  body: PatchRequirementBody
): void {
  const existing = loadRequirement(jiraKey)
  if (!existing) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const patch: UpdateRequirementPatch = {}
  if (body.status) patch.status = body.status
  if (typeof body.title === 'string') patch.title = body.title
  if (typeof body.summary === 'string') patch.summary = body.summary
  if (typeof body.manualEstimateMinutes === 'number')
    patch.manualEstimateMinutes = body.manualEstimateMinutes
  if (body.complexity) patch.complexity = body.complexity
  if ('formulaWThinkOverride' in body) {
    const raw = body.formulaWThinkOverride
    if (raw === null) {
      patch.formulaWThinkOverride = null
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      // 与 metrics/store 保持一致的 clamp 边界,避免越界写盘
      patch.formulaWThinkOverride = Math.max(0, Math.min(1, raw))
    }
  }

  const next = updateRequirement(jiraKey, patch)
  ok(res, { jiraKey: next.jiraKey, status: next.status })
}

export interface PatchSubtaskBody {
  done: boolean
  /** UI 触发的勾选记录为 manual,CLI/skill 路径记为 skill */
  source?: 'skill' | 'manual'
}

export function handleAiProductivityPatchSubtask(
  res: ServerResponse,
  jiraKey: string,
  subtaskId: string,
  body: PatchSubtaskBody
): void {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const subtasks = (requirement.subtasks ?? []).map((s) => ({ ...s }))
  const target = subtasks.find((s) => s.id === subtaskId)
  if (!target) {
    fail(res, 404, `subtask ${subtaskId} 未找到`)
    return
  }

  const next = Boolean(body.done)
  if (target.done !== next) {
    appendSubtaskEvent(jiraKey, {
      subtaskId,
      fromDone: target.done,
      toDone: next,
      source: body.source === 'skill' ? 'skill' : 'manual'
    })
    target.done = next
    target.doneAt = next ? new Date().toISOString() : null
  }

  const updated = updateRequirement(jiraKey, { subtasks })
  ok(res, { updated: true, subtasks: updated.subtasks })
}

export interface RefreshBugsBody {
  jql?: string
}

export interface RefreshBugsDeps {
  fetchImpl?: typeof fetch
}

export async function handleAiProductivityRefreshBugs(
  res: ServerResponse,
  jiraKey: string,
  body: RefreshBugsBody,
  deps: RefreshBugsDeps = {}
): Promise<void> {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }

  const config = readJiraConfig()
  if (!isJiraConfigured(config)) {
    fail(res, 400, '尚未配置 Jira 凭证,请前往设置页填写 Jira baseUrl/apiEmail/apiToken')
    return
  }

  // v2.15.2 三层 jql 兜底:body.jql → requirement.linkedBugJql → config.bugJqlTemplate
  // 旧实现用 `??` 短路,遇到 `requirement.linkedBugJql === ''` 不回退,导致全局 bugJqlTemplate
  // 永远不被采用 → 空 jql 传给 Atlassian → 400 unbounded。改为「空白都回退」+ 都空 400 引导。
  const rawTemplate =
    [body?.jql, requirement.linkedBugJql, config.bugJqlTemplate]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0) ?? ''

  if (!rawTemplate) {
    fail(
      res,
      400,
      'Jira Bug JQL 模板未配置,请前往「业务配置」Tab 的「Jira 查询凭证」卡片填写「Bug JQL 模板」'
    )
    return
  }

  // 渲染 {{jiraKey}} 占位符后再追加 bounded 兜底(Atlassian 新接口硬约束)
  const jql = ensureBoundedJql(renderJqlTemplate(rawTemplate, jiraKey), jiraKey)

  try {
    const total = await fetchJiraBugTotal(config, jql, deps.fetchImpl)
    const refreshedAt = new Date().toISOString()
    const updated = updateRequirement(jiraKey, {
      linkedBugCount: total,
      linkedBugJql: jql,
      bugsRefreshedAt: refreshedAt
    })
    ok(res, {
      linkedBugCount: updated.linkedBugCount,
      linkedBugJql: updated.linkedBugJql,
      bugsRefreshedAt: updated.bugsRefreshedAt
    })
  } catch (err) {
    if (err instanceof JiraBugFetchError) {
      fail(res, err.status >= 400 && err.status < 600 ? err.status : 502, err.message)
      return
    }
    fail(res, 500, err instanceof Error ? err.message : '未知错误')
  }
}

export interface SyncJiraTitleResponse {
  title: string
  source: 'jira'
}

export interface SyncJiraTitleDeps {
  fetchImpl?: typeof fetch
}

/**
 * v2.14.0 用 agent 已存的 Jira 凭证拉真实 issue summary,写回 requirement.title。
 *
 * 设计目的:
 * - 弥补「init 时 LLM 没传 title + agent 未配 Jira → 标题落成 jiraKey」的历史脏数据
 * - 也作为 Workspace Tab「openDetail 检测 title===jiraKey 时静默后台兜底」的入口
 *
 * v2.14.2 改用 inspectJiraIssueSummary 按 reason 输出细分 status & 文案,
 * 不再让用户对着"无法从 Jira 拉取..."统一兜底文案猜根因。
 */
export async function handleAiProductivitySyncJiraTitle(
  res: ServerResponse,
  jiraKey: string,
  deps: SyncJiraTitleDeps = {}
): Promise<void> {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }

  const config = readJiraConfig()
  if (!isJiraConfigured(config)) {
    fail(
      res,
      422,
      '尚未配置 Jira 凭证,请先到「AI 提效面板 → 配置」Tab 填写 Jira baseUrl/apiEmail/apiToken'
    )
    return
  }

  const result = await inspectJiraIssueSummary(config, jiraKey, deps.fetchImpl)
  if (!result.ok) {
    const { status, message } = mapJiraSummaryReason(result.reason, jiraKey, result.status)
    fail(res, status, message)
    return
  }

  const updated = updateRequirement(jiraKey, { title: result.summary })
  ok(res, { title: updated.title, source: 'jira' } satisfies SyncJiraTitleResponse)
}

function mapJiraSummaryReason(
  reason: JiraIssueSummaryReason,
  jiraKey: string,
  upstreamStatus?: number
): { status: number; message: string } {
  switch (reason) {
    case 'not_configured':
      return {
        status: 422,
        message:
          '尚未配置 Jira 凭证,请先到「AI 提效面板 → 配置」Tab 填写 Jira baseUrl/apiEmail/apiToken'
      }
    case 'empty_jira_key':
      return { status: 400, message: 'jiraKey 不能为空' }
    case 'invalid_url':
      return {
        status: 422,
        message:
          'Jira Base URL 无效,请检查是否包含 https:// 协议前缀(例如 https://yourorg.atlassian.net)'
      }
    case 'unauthorized':
      return {
        status: 401,
        message:
          'Jira 鉴权失败,请确认 API Email/Token 正确(可在 Atlassian 账户安全页重新生成 Token)'
      }
    case 'forbidden':
      return {
        status: 403,
        message: `Jira 凭证无权访问 ${jiraKey},请联系管理员开通对应项目权限`
      }
    case 'not_found':
      return {
        status: 404,
        message: `Jira 上未找到 ${jiraKey},请确认 issue key 与所在站点(baseUrl)是否匹配`
      }
    case 'http_error':
      return {
        status: 502,
        message: `Jira REST 调用失败:${upstreamStatus ?? 'unknown'},请稍后重试或检查 Jira 服务状态`
      }
    case 'network_error':
      return {
        status: 502,
        message: 'Jira 网络异常(DNS / 超时 / 证书),请检查 baseUrl 与本机网络/代理设置'
      }
    case 'invalid_json':
      return {
        status: 502,
        message: 'Jira 响应不是合法 JSON,baseUrl 可能指向了错误的站点'
      }
    case 'empty_summary':
      return {
        status: 422,
        message: `Jira 返回的 ${jiraKey} summary 为空,请在 Jira 上完善标题后再同步`
      }
    default:
      return {
        status: 502,
        message: `无法从 Jira 拉取 ${jiraKey} 的 summary,请稍后重试`
      }
  }
}

export function handleAiProductivityPatchFormula(
  res: ServerResponse,
  body: Partial<FormulaSettings>
): void {
  const next = writeFormula(body ?? {})
  ok(res, next)
}

export function handleAiProductivityPatchJiraConfig(
  res: ServerResponse,
  body: Partial<JiraStoredConfig>
): void {
  const next = writeJiraConfig(body ?? {})
  ok(res, {
    configured: isJiraConfigured(next),
    baseUrl: next.baseUrl,
    apiEmail: next.apiEmail,
    bugJqlTemplate: next.bugJqlTemplate
  })
}

// ────────────────────────────────────────────────────────────────────
// v2.4.0 软数据通道:对话总结 attach + Track Skill 一键注入
// ────────────────────────────────────────────────────────────────────

export type AttachSummaryConversationType = 'coding' | 'communication'

export interface AttachSummaryRequestBody {
  /** 优先级最高;缺省时尝试从 branch 解析 */
  jiraKey?: string
  /** 当 jiraKey 缺省时用 branch 解析 issueKey */
  branch?: string
  /** 一句话总结,≤120 字 */
  oneLine?: string
  /** 对话类型:coding=代码改动,communication=纯沟通 */
  type?: AttachSummaryConversationType
  /** 改动范围(coding 时必填) */
  changeScope?: string
  /** 讨论内容(communication 时必填) */
  discussion?: string
  /**
   * v2.5.0 调用方 AI 工具来源;由 skill 模板硬编码(SKILL.md 传 'claude-code',
   * CURSOR_RULE.md 传 'cursor',Codex skill 传 'codex')。仅在 target iteration.source
   * 为 'unknown' 时补写。
   */
  source?: 'cursor' | 'claude-code' | 'codex'
  /**
   * v2.5.1 当前工作目录;jiraKey/branch 都缺时,agent 用 cwd 取当前分支或
   * 该 git 仓库 bindings.json 里最近活跃的需求兜底。
   */
  cwd?: string
  /** v2.3.x 兼容字段:旧 skill 仍可能上传单字符串总结 */
  conversationSummary?: string
}

export interface AttachSummaryResponse {
  ok: true
  /** v2.7.0 起 happy path 恒为 true;v2.13.0 起 skipped 场景为 false */
  updated: boolean
  /**
   * v2.7.0:对话总结现在写入 `<jiraKey>/pending-summary.json` 中间态,
   * 待下一条 hook/watcher 触发的 iteration 写盘时被消费并挂到该 iteration 上。
   * `pending: true` 表示已经成功落 pending 文件(等价旧 `updated: true`)。
   */
  pending: boolean
  /**
   * v2.13.0 新增:LLM 在非 Jira 分支误调时,daemon 不再返 4xx,改为返
   * `200 { ok:true, skipped:true, reason:'no_jira_key', jiraKey:'' }`,
   * 让 IDE 工具面板不再标红失败。仅在 skipped=true 时 `reason='no_jira_key'`。
   */
  skipped?: boolean
  /** skipped=true 时为空串;happy path 为实际 jiraKey */
  jiraKey: string
  /** v2.7.0 起恒为 null:总结由下一条 iteration 接管,seq 在 attach 调用时尚未确定 */
  iterationSeq: number | null
  /** 'write_failed':jiraKey 解析成功但写盘失败;'no_jira_key':v2.13.0 兜底,非 Jira 分支误调 */
  reason?: 'write_failed' | 'no_jira_key'
}

const ONE_LINE_MAX = 120
const CHANGE_SCOPE_MAX = 120
const DISCUSSION_MAX = 300
const LEGACY_SUMMARY_MAX = 4000

interface ResolvedSummary {
  oneLine: string
  type: AttachSummaryConversationType
  changeScope?: string
  discussion?: string
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * v2.13.2 软截断:超长字段不再返回 400,改为静默 trim 到 max,console.info 记一行便于排查.
 *
 * 背景:zod max 校验放在 MCP 层时,LLM 第一次写超就直接 too_big 失败,触发 Stop Hook
 * `inject_followup` 强制重答,Claude Code 因协议把 reason 注入为新 user 行而产生双 iteration,
 * Cursor 因 followup_message 是同 turn 续答而吞掉表象但 LLM 仍多花一份 token.放宽到 agent
 * 端 graceful truncate,LLM 第一次就成功 → sentinel 同步落盘 → Stop Hook 直接放行.
 */
function softTrim(value: string, max: number, field: string): string {
  if (value.length <= max) return value
  console.info(`[attach_summary] ${field} truncated from ${value.length} to ${max}`)
  return value.slice(0, max)
}

/**
 * 解析入参为结构化总结。优先使用新字段,缺省时 fallback 到老 `conversationSummary` 字符串。
 *
 * v2.13.3 软兜底:除 `oneLine` 必填外,其它字段缺失一律不返回 400,改为本地兜底 + 走 200。
 * 背景:LLM 自动触发场景下经常漏填 `discussion` / `changeScope`,或把 `type` 写成 undefined 等
 * 非法值,导致 zod / agent 校验失败 → sentinel 没写 → Stop Hook 强制重答 → 看板双 iteration。
 * 字段缺失的代价(总结质量下降一档)远比"双 iteration + 空白条"小。
 *
 * 返回 string 表示校验失败(仅在彻底没有 oneLine 也没有 legacy summary 时),返回对象表示通过。
 */
function resolveAttachSummary(body: AttachSummaryRequestBody | null): ResolvedSummary | string {
  const oneLine = trimString(body?.oneLine)
  const rawType = trimString(body?.type)
  const changeScope = trimString(body?.changeScope)
  const discussion = trimString(body?.discussion)
  const legacySummary = trimString(body?.conversationSummary)

  // 新字段优先(只要有任一新字段就走新路径,兜底缺失字段)
  if (oneLine || rawType || changeScope || discussion) {
    if (!oneLine) return 'oneLine 不能为空'
    // v2.13.3 type 缺失 / 非法 → 默认 communication
    let resolvedType: AttachSummaryConversationType
    if (rawType === 'coding' || rawType === 'communication') {
      resolvedType = rawType
    } else {
      if (rawType) {
        console.info(`[attach_summary] type defaulted to communication (received "${rawType}")`)
      } else {
        console.info('[attach_summary] type defaulted to communication (missing)')
      }
      resolvedType = 'communication'
    }
    const trimmedOneLine = softTrim(oneLine, ONE_LINE_MAX, 'oneLine')
    // v2.13.3 type=coding 缺 changeScope → 用 oneLine 兜底;type=communication 缺 discussion 同理
    let resolvedChangeScope = changeScope
    let resolvedDiscussion = discussion
    if (resolvedType === 'coding' && !resolvedChangeScope) {
      console.info('[attach_summary] changeScope filled from oneLine (missing)')
      resolvedChangeScope = oneLine
    }
    if (resolvedType === 'communication' && !resolvedDiscussion) {
      console.info('[attach_summary] discussion filled from oneLine (missing)')
      resolvedDiscussion = oneLine
    }
    const trimmedChangeScope = resolvedChangeScope
      ? softTrim(resolvedChangeScope, CHANGE_SCOPE_MAX, 'changeScope')
      : ''
    const trimmedDiscussion = resolvedDiscussion
      ? softTrim(resolvedDiscussion, DISCUSSION_MAX, 'discussion')
      : ''
    return {
      oneLine: trimmedOneLine,
      type: resolvedType,
      ...(resolvedType === 'coding'
        ? { changeScope: trimmedChangeScope }
        : { discussion: trimmedDiscussion })
    }
  }

  // 兼容老 v2.3.x skill:整段字符串 → 包装成 communication
  if (legacySummary) {
    if (legacySummary.length > LEGACY_SUMMARY_MAX) {
      return `conversationSummary 超出长度上限 ${LEGACY_SUMMARY_MAX} 字符`
    }
    return {
      oneLine:
        legacySummary.length > ONE_LINE_MAX ? legacySummary.slice(0, ONE_LINE_MAX) : legacySummary,
      type: 'communication',
      discussion:
        legacySummary.length > DISCUSSION_MAX
          ? legacySummary.slice(0, DISCUSSION_MAX)
          : legacySummary
    }
  }

  return '缺少对话总结字段(oneLine + type + changeScope/discussion)'
}

export async function handleAiProductivityAttachSummary(
  res: ServerResponse,
  body: AttachSummaryRequestBody | null
): Promise<void> {
  const resolved = resolveAttachSummary(body)
  if (typeof resolved === 'string') {
    fail(res, 400, resolved)
    return
  }

  let jiraKey = typeof body?.jiraKey === 'string' ? body.jiraKey.trim().toUpperCase() : ''
  let resolveVia: 'explicit' | 'branch' | 'cwd_branch' | 'active_binding' = jiraKey
    ? 'explicit'
    : 'explicit'
  if (!jiraKey && typeof body?.branch === 'string') {
    const parsed = extractIssueKey(body.branch)
    if (parsed) {
      jiraKey = parsed
      resolveVia = 'branch'
    }
  }
  const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
  // v2.5.1 兜底:基于 cwd 取当前 git 分支再解析 issueKey
  if (!jiraKey && cwd) {
    const branchFromCwd = getCurrentBranch(cwd)
    if (branchFromCwd) {
      const parsed = extractIssueKey(branchFromCwd)
      if (parsed) {
        jiraKey = parsed
        resolveVia = 'cwd_branch'
      }
    }
  }
  // v2.5.1 兜底:基于 cwd 找 git 仓库下 bindings.json 的最近活跃需求
  if (!jiraKey && cwd) {
    const active = resolveActiveBindingByCwd(cwd)
    if (active?.jiraKey) {
      jiraKey = active.jiraKey
      resolveVia = 'active_binding'
    }
  }
  if (!jiraKey) {
    // v2.13.0 收紧非 Jira 分支触发(用户反馈:noise 主要来自 Cursor 工具面板红色失败):
    //   - 老行为:HTTP 400 + "无法推断当前追踪需求" → MCP 客户端拿到 isError=true,工具面板标红
    //   - 新行为:HTTP 200 + skipped:true + reason='no_jira_key',工具面板不再标红
    //   - 这只是「LLM 已经误调了 → 不让用户看到红色」的兜底防御,真正的硬约束在
    //     rule/skill 模板 + MCP tool description 层,要求 LLM 在分支不含 Jira key 时根本不调
    console.info('[attach_summary] skipped: no jira key resolvable from request / cwd')
    ok(res, {
      ok: true,
      updated: false,
      pending: false,
      skipped: true,
      jiraKey: '',
      iterationSeq: null,
      reason: 'no_jira_key'
    } satisfies AttachSummaryResponse)
    return
  }
  if (resolveVia !== 'explicit') {
    console.info(`[attach_summary] jiraKey resolved via ${resolveVia}: ${jiraKey}`)
  }

  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未在 AI 提效面板初始化`)
    return
  }

  const { writePendingSummary } = await import('@ai-productivity-tracker/core/store')
  const rawSource = typeof body?.source === 'string' ? body.source.trim() : ''
  const source =
    rawSource === 'cursor' || rawSource === 'claude-code' || rawSource === 'codex'
      ? rawSource
      : undefined

  // v2.7.0 attach-summary 改写为 pending consume 模型:
  // 把总结写入 <jiraKey>/pending-summary.json,等下一条 hook/watcher 触发的 iteration
  // 落盘时由 appendIteration 同步消费并挂到该 iteration 上 ─ 总结自然对齐"本轮"。
  const pending = writePendingSummary(jiraKey, resolved, source)
  if (!pending) {
    ok(res, {
      ok: true,
      updated: false,
      pending: false,
      jiraKey,
      iterationSeq: null,
      reason: 'write_failed'
    } satisfies AttachSummaryResponse)
    return
  }

  // v2.10.0 同步落 jiraKey 维度 sentinel:
  // 让本机 stop-check 在 LLM 答复结束触发时立即看到「本轮真调过 attach_summary」凭证。
  // 老链路依赖 Cursor afterMCPExecution Hook(fire-and-forget,跨进程时序不可控)
  // 写 conv-gen 维度 sentinel,实测漏写概率高,导致 followup_message 强制重答 + 重复上报。
  // 改为同进程同步写,sentinel 必定在 attach_summary HTTP 返回前落盘。
  // 失败仅 warn,不阻塞主流程(降级回退到老的"无 sentinel→注入 followup"行为,与 v2.9.x 一致)。
  try {
    const { writeRecentAttachSentinel } = await import('@ai-productivity-tracker/core/store')
    const written = writeRecentAttachSentinel(jiraKey)
    if (!written) {
      console.warn(`[attach_summary] 落 recent-attach sentinel 失败 jiraKey=${jiraKey}`)
    }
  } catch (err) {
    console.warn('[attach_summary] 写 recent-attach sentinel 异常:', err)
  }

  ok(res, {
    ok: true,
    updated: true,
    pending: true,
    jiraKey,
    iterationSeq: null
  } satisfies AttachSummaryResponse)
}

/**
 * v2.6.0 Claude Code UserPromptSubmit Hook 状态.
 * 仅在 SKILL.md 已安装通路存在.installed=false 时 upToDate 也为 false.
 */
export interface ClaudeTrackHookStatusResponse {
  path: string
  installed: boolean
  upToDate: boolean
  currentCommand: string | null
}

export interface TrackSkillStatusResponse {
  version: string
  claude: {
    defaultPath: string
    installed: boolean
    upToDate: boolean
    outdated: boolean
    hook: ClaudeTrackHookStatusResponse
  }
  cursor: { defaultPath: string; installed: boolean; upToDate: boolean; outdated: boolean }
}

export async function handleAiProductivityTrackSkillStatus(res: ServerResponse): Promise<void> {
  const { inspectAiTrackSkillBundle } = await import('../skill-sync.js')
  const status = await inspectAiTrackSkillBundle()
  ok(res, status satisfies TrackSkillStatusResponse)
}

export interface ClaudeTrackHookInstallResponse {
  path: string
  replaced: boolean
  previousCommand: string | null
  finalCommand: string
}

export interface InstallTrackSkillResponse {
  ok: true
  version: string
  claude: {
    path: string
    written: boolean
    replaced: boolean
    hook: ClaudeTrackHookInstallResponse
  }
  cursor: { path: string; written: boolean; replaced: boolean }
  /**
   * v2.16.0:复用「一键注入 Skill」按钮一并装入 lessons-extract skill 的结果(无 Hook)。
   * 老前端不读该字段 → undefined 也不影响;新前端可据此提示「同步装了 lessons-extract」。
   */
  lessonsExtract?: {
    version: string
    claude: { path: string; written: boolean; replaced: boolean }
    cursor: { path: string; written: boolean; replaced: boolean }
  }
}

export async function handleAiProductivityInstallTrackSkill(res: ServerResponse): Promise<void> {
  try {
    const { installAiTrackSkillBundle } = await import('../skill-sync.js')
    const result = await installAiTrackSkillBundle()
    ok(res, {
      ok: true,
      version: result.version,
      claude: result.claude,
      cursor: result.cursor,
      lessonsExtract: result.lessonsExtract
    } satisfies InstallTrackSkillResponse)
  } catch (err) {
    const e = err as { message?: string }
    fail(res, 500, e?.message ?? '注入 Track Skill 失败')
  }
}

// ────────────────────────────────────────────────────────────────────
// v2.16.0 P0 经验沉淀(lessons) 端点
// ────────────────────────────────────────────────────────────────────

/**
 * 看板侧 GET /ai-productivity/lessons (panel-origin 放行)
 *
 * 返回 INDEX.json 的投影列表;支持 jiraKey / type / tag / q / scope / projectSlug 客户端过滤。
 * v2.17.0 新增 scope='general'|'project'|'unscoped' 与 projectSlug 精确匹配。
 */
export function handleAiProductivityListLessons(
  res: ServerResponse,
  filter: {
    jiraKey?: string
    type?: string
    tag?: string
    q?: string
    scope?: string
    projectSlug?: string
  }
): void {
  const type =
    filter.type && (LESSON_TYPES as readonly string[]).includes(filter.type)
      ? (filter.type as LessonType)
      : undefined
  const rawScope = filter.scope?.trim() ?? ''
  const scope: 'general' | 'project' | 'unscoped' | undefined =
    rawScope === 'general' || rawScope === 'project' || rawScope === 'unscoped'
      ? rawScope
      : undefined
  const items = listLessons({
    jiraKey: filter.jiraKey?.trim() || undefined,
    type,
    tag: filter.tag?.trim() || undefined,
    q: filter.q?.trim() || undefined,
    scope,
    projectSlug: filter.projectSlug?.trim() || undefined
  })
  ok(res, items)
}

/**
 * 看板侧 GET /ai-productivity/lessons/:id (panel-origin 放行)
 *
 * 返回单条经验完整内容。
 */
export function handleAiProductivityGetLesson(res: ServerResponse, id: string): void {
  if (!isValidLessonId(id)) {
    fail(res, 400, `非法 lessonId: ${id}`)
    return
  }
  const lesson = loadLesson(id)
  if (!lesson) {
    fail(res, 404, `经验 ${id} 未找到`)
    return
  }
  ok(res, lesson)
}

/**
 * 看板侧 DELETE /ai-productivity/lessons/:id (panel-origin 放行)
 */
export function handleAiProductivityDeleteLesson(res: ServerResponse, id: string): void {
  if (!isValidLessonId(id)) {
    fail(res, 400, `非法 lessonId: ${id}`)
    return
  }
  const removed = removeLesson(id)
  if (!removed) {
    fail(res, 404, `经验 ${id} 未找到或已被删除`)
    return
  }
  ok(res, { deleted: true, id })
}

/**
 * lessons-extract skill 拉取数据包: GET /ai-productivity/requirements/:jiraKey/lessons-bundle
 *
 * **panel-origin 放行**(便于将来 Web 看板「重新提取」按钮直接消费;skill 通过 MCP 走 token 鉴权也可)。
 *
 * v2.17.0 返回结构追加 `currentProjectSlug` 字段(来自 requirement.projectSlug = package.json name),
 * existingLessons 已过滤为「通用 + 当前项目」,LLM 据此判断 scope='general'|'project' 并填 projectSlug。
 *
 * 注意:返回的 iterations 已经是经过 normalize 的 StoredIteration 列表,LLM 直接消费即可。
 */
export function handleAiProductivityLessonsBundle(res: ServerResponse, jiraKey: string): void {
  const bundle = buildLessonsBundle(jiraKey)
  if (!bundle.requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到,请先 ai_productivity_init`)
    return
  }
  ok(res, bundle)
}

/**
 * v2.15.0 per-turn 经验沉淀兜底: GET /ai-productivity/requirements/:jiraKey/latest-candidate
 *
 * stop-check hook 进程不直接依赖 core store(避免 hook 单文件打包膨胀),信号在 daemon 端算:
 *   - listIterations 取最新一条「非 init」iteration
 *   - 对其 seq 跑 isStrongCandidateIteration(复用 computeSignals 的 abnormal-stop + thinkSeconds)
 *   - 返回 { seq, strongCandidate, reasons }
 *
 * 无任何非 init iteration(只有 init 或空)→ { seq: null, strongCandidate: false, reasons: [] }(200),
 * 需求不存在 → 404。hook 端 fail-open:拿不到 / 报错都视为「无候选」,绝不阻塞 stop。
 */
export function handleAiProductivityLatestCandidate(res: ServerResponse, jiraKey: string): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const iterations = listIterations(jiraKey)
  // 倒序找最新一条非 init(stop hook 触发时当前轮尚未 flush,这里拿到的天然是「上一轮已 flush」的 iteration)
  let latest: { seq: number } | undefined
  for (let i = iterations.length - 1; i >= 0; i -= 1) {
    if (iterations[i].kind !== 'init') {
      latest = { seq: iterations[i].seq }
      break
    }
  }
  if (!latest) {
    ok(res, { seq: null, strongCandidate: false, reasons: [] })
    return
  }
  const candidate = isStrongCandidateIteration(jiraKey, latest.seq)
  ok(res, { seq: latest.seq, strongCandidate: candidate.hit, reasons: candidate.reasons })
}

export interface SaveLessonsRequestBody {
  jiraKey: string
  lessons: WriteLessonInput[]
  /** 可选:由 MCP 客户端硬编码标识 cursor / claude-code,用于 source.extractedBy */
  source?: LessonExtractedBy
  /**
   * v2.17.0 批次维度 projectSlug 兜底:LLM 一批 lessons 若全部漏填 projectSlug,
   * 用这条 body 级值统一兜底(优先级低于 lesson.projectSlug,高于 store 端按 jiraKey 反查 requirement)。
   * 实际链路中 skill 模板要求 LLM 在 scope='project' 的 lesson 里显式填 currentProjectSlug,
   * 这里只是给老调用方一条软兜底通道,不强制。
   */
  projectSlug?: string
}

/**
 * lessons-extract skill 落盘 LLM 推理出的经验: POST /ai-productivity/lessons (panel-origin 放行)
 *
 * 请求体: { jiraKey, lessons: WriteLessonInput[], source?, projectSlug? }
 *
 * 返回: { saved, savedCount, replaced, rejected }
 *
 * v2.17.0 关键变更:
 *  - 允许 lessons:[] 静默落盘(无任何写入,但仍返回 200 + savedCount=0),用于"本轮没价值经验"的场景
 *  - lesson.projectSlug 缺省时按 body.projectSlug → store 端按 jiraKey 反查 requirement.projectSlug 兜底
 *  - scope 缺省 → 'project'(保守默认,详见 lessons-store.normalizeWriteInput)
 *
 * 经验里的 jiraKey 优先取条目自身;条目缺省时由 body.jiraKey 兜底注入到每条 input。
 * 如果某条 input.jiraKey 与 body.jiraKey 不一致,以条目自身为准(允许跨需求批量补充)。
 */
export function handleAiProductivitySaveLessons(
  res: ServerResponse,
  body: SaveLessonsRequestBody | null
): void {
  if (!body || typeof body !== 'object') {
    fail(res, 400, 'Invalid JSON body')
    return
  }
  const fallbackJiraKey = typeof body.jiraKey === 'string' ? body.jiraKey.trim() : ''
  if (!Array.isArray(body.lessons)) {
    fail(res, 400, 'lessons 必须是数组')
    return
  }
  if (!fallbackJiraKey && body.lessons.some((l) => !l?.jiraKey)) {
    fail(res, 400, '未提供 body.jiraKey 时, 每条 lesson 必须自带 jiraKey')
    return
  }
  // v2.17.0 lessons:[] 短路:不触碰磁盘,直接返回空结果(对应 skill "本轮无价值经验" 的静默路径)
  if (body.lessons.length === 0) {
    ok(res, { saved: [], savedCount: 0, replaced: [], rejected: [] })
    return
  }
  const bodyProjectSlug = typeof body.projectSlug === 'string' ? body.projectSlug.trim() : ''
  const inputs = body.lessons.map((l) => ({
    ...l,
    jiraKey: l?.jiraKey || fallbackJiraKey,
    // 仅在 lesson 自身没显式给 projectSlug 时,落 body 级兜底;store 层 normalize 还会再按 jiraKey 反查兜底
    projectSlug:
      typeof l?.projectSlug === 'string' && l.projectSlug.trim()
        ? l.projectSlug
        : bodyProjectSlug || undefined
  }))
  const source: LessonExtractedBy =
    body.source === 'cursor' || body.source === 'claude-code' || body.source === 'codex'
      ? body.source
      : 'manual'
  const result = writeLessons(inputs, { extractedBy: source })
  // v2.15.0 per-turn:落盘成功后,对每条 lesson 的 iterationSeqs 写 lesson-handled sentinel,
  // 让 stop-check 兜底不再就同一 (jiraKey, seq) 候选重复打扰(用户已主动「记录」过)。
  // fail-open:任何写 sentinel 失败都不影响落盘主结果。
  for (const lesson of result.saved) {
    const lessonJiraKey = lesson.jiraKey || fallbackJiraKey
    if (!lessonJiraKey || !Array.isArray(lesson.iterationSeqs)) continue
    for (const seq of lesson.iterationSeqs) {
      if (Number.isInteger(seq) && seq > 0) writeLessonHandledSentinel(lessonJiraKey, seq)
    }
  }
  ok(res, {
    saved: result.saved,
    savedCount: result.saved.length,
    replaced: result.replaced,
    rejected: result.rejected
  })
}

// ────────────────────────────────────────────────────────────────────
// 单需求复盘报告 (retrospective) v1.0.0-rc.23
// ────────────────────────────────────────────────────────────────────

/**
 * retrospective-report skill 拉取数据包: GET /ai-productivity/requirements/:jiraKey/retrospective-bundle
 *
 * **panel-origin 放行**(便于看板「重新生成」按钮直接消费;skill 通过 MCP 走 token 鉴权也可)。
 *
 * 返回结构:`buildRetrospectiveBundle()` —— 含 requirement / iterations /
 * computedSignals / relatedLessons / existingRetrospective / currentProjectSlug。
 *
 * 需求不存在(从未 init)→ 404。
 */
export function handleAiProductivityRetrospectiveBundle(
  res: ServerResponse,
  jiraKey: string
): void {
  const bundle = buildRetrospectiveBundle(jiraKey)
  if (!bundle.requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到,请先 ai_productivity_init`)
    return
  }
  ok(res, bundle)
}

/**
 * 看板侧 GET /ai-productivity/requirements/:jiraKey/retrospective (panel-origin 放行)
 *
 * 返回 `StoredRetrospective | null`。文件不存在时返回 null(200),用于 UI 空态判断;
 * 需求不存在(从未 init)→ 404。
 */
export function handleAiProductivityGetRetrospective(res: ServerResponse, jiraKey: string): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const report = loadRetrospective(jiraKey)
  ok(res, report)
}

export interface SaveRetrospectiveRequestBody {
  /** LLM 推理产物的叙事字段(必填,overview 非空) */
  narrative: RetrospectiveNarrative
  /** 'cursor' / 'claude-code' / 'manual',缺省 'manual' */
  source?: RetrospectiveSource
  /** 引用的 lesson id 列表;不属于本 jiraKey 的 id 会被静默过滤 */
  referencedLessonIds?: string[]
  /** 报告锚点 iteration seq;超出范围的 seq 会被静默过滤 */
  anchorIterationSeqs?: number[]
  /** Harness 总结:可落地的工程护栏建议;非法 / 空条目会被静默过滤 */
  harnessSummary?: RetrospectiveHarnessSummary
}

/**
 * retrospective-report skill 落盘 LLM 推理出的复盘: POST /ai-productivity/requirements/:jiraKey/retrospective
 *
 * **MCP 主链路(Bearer token 鉴权)**。看板侧不直接调用,看板生成入口走"复制触发口令"模式。
 *
 * 单文件覆盖:同 jiraKey 重复落盘视为更新;snapshot / generatedAt /
 * generatedAtIterationSeq 由 store 端自动注入。
 *
 * 校验:
 * - 需求必须存在
 * - narrative.overview 必须非空(空叙事请走 DELETE 而非 POST)
 *
 * 返回:落盘后的完整 StoredRetrospective(含 store 自动注入的字段)。
 */
export function handleAiProductivitySaveRetrospective(
  res: ServerResponse,
  jiraKey: string,
  body: SaveRetrospectiveRequestBody | null
): void {
  if (!body || typeof body !== 'object') {
    fail(res, 400, 'Invalid JSON body')
    return
  }
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到,请先 ai_productivity_init`)
    return
  }
  if (!body.narrative || typeof body.narrative !== 'object') {
    fail(res, 400, 'narrative 必填')
    return
  }
  const overview = typeof body.narrative.overview === 'string' ? body.narrative.overview.trim() : ''
  if (!overview) {
    fail(res, 400, 'narrative.overview 不能为空')
    return
  }

  try {
    const written = writeRetrospective(
      jiraKey,
      {
        narrative: body.narrative,
        source: body.source,
        referencedLessonIds: body.referencedLessonIds,
        anchorIterationSeqs: body.anchorIterationSeqs,
        harnessSummary: body.harnessSummary
      } satisfies WriteRetrospectiveInput,
      undefined
    )
    ok(res, written)
  } catch (err) {
    const message = err instanceof Error ? err.message : '落盘失败'
    fail(res, 400, message)
  }
}

/**
 * 看板侧 DELETE /ai-productivity/requirements/:jiraKey/retrospective (panel-origin 放行)
 *
 * 文件不存在视为成功(返回 { deleted: false });需求不存在 → 404。
 */
export function handleAiProductivityDeleteRetrospective(
  res: ServerResponse,
  jiraKey: string
): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const deleted = removeRetrospective(jiraKey)
  ok(res, { deleted, jiraKey })
}

/**
 * 看板侧 GET /ai-productivity/harness-suggestions (panel-origin 放行)
 *
 * 跨需求实时聚合所有复盘报告里的 harness 护栏建议,供「复盘经验」看板的 harness 视图展示。
 * 不新建存储:每次请求遍历各需求 retrospective.json 摊平 harnessSummary.suggestions。
 *
 * 返回:`{ suggestions: AggregatedHarnessSuggestion[] }`(按 generatedAt 倒序)。
 */
export function handleAiProductivityListHarnessSuggestions(res: ServerResponse): void {
  const suggestions = listHarnessSuggestions()
  ok(res, { suggestions })
}

// ────────────────────────────────────────────────────────────────────
// AI 整体用量(panel-origin 放行)
// ────────────────────────────────────────────────────────────────────

/**
 * 看板侧 GET /ai-productivity/ai-usage?days=N (panel-origin 放行)
 *
 * 返回 `{ enabled, today, series }`,携带全部已采集维度(token 细分 / turns / sessions /
 * models / providers),前端按需取子集。days 默认 14,clamp 到 [1,365]。
 */
export function handleAiProductivityGetAiUsage(
  res: ServerResponse,
  query: { days?: string | null }
): void {
  let days = 14
  const raw = query.days
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) days = Math.floor(parsed)
  }
  const view: AiUsageView = getAiUsageView(days)
  ok(res, view)
}

export interface PatchAiUsageConfigBody {
  enabled?: unknown
}

/**
 * 看板侧 PATCH /ai-productivity/ai-usage/config (panel-origin 放行)
 *
 * body `{ enabled: boolean }`:切换采集开关并刷新进程内缓存,返回最新 config。
 */
export function handleAiProductivityPatchAiUsageConfig(
  res: ServerResponse,
  body: PatchAiUsageConfigBody
): void {
  if (!body || typeof body.enabled !== 'boolean') {
    fail(res, 400, 'enabled 必须为 boolean')
    return
  }
  const config = setAiUsageEnabled(body.enabled)
  ok(res, config)
}

const SESSION_USAGE_SOURCES: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

/**
 * 看板侧 GET /ai-productivity/session-usage (panel-origin 放行)
 *
 * query:`from?` / `to?`(ISO/日期)、`source?`(cursor|claude-code|codex)、
 * `limit?`(默认 50)、`sort?`(total|lastAt,默认 total)、`dir?`(asc|desc,默认 desc)。
 * 服务端完成过滤 / 排序 / 截断后返回 `{ sessions }`。
 */
export function handleSessionUsageQuery(
  res: ServerResponse,
  query: {
    from?: string | null
    to?: string | null
    source?: string | null
    limit?: string | null
    sort?: string | null
    dir?: string | null
  }
): void {
  const from = typeof query.from === 'string' && query.from.trim() ? query.from.trim() : undefined
  const to = typeof query.to === 'string' && query.to.trim() ? query.to.trim() : undefined
  const source =
    typeof query.source === 'string' &&
    (SESSION_USAGE_SOURCES as readonly string[]).includes(query.source)
      ? (query.source as AiUsageSource)
      : undefined
  let limit: number | undefined
  if (typeof query.limit === 'string' && query.limit.trim()) {
    const parsed = Number(query.limit)
    if (Number.isFinite(parsed) && parsed > 0) limit = Math.floor(parsed)
  }
  const sort: SessionUsageSortKey = query.sort === 'lastAt' ? 'lastAt' : 'total'
  const dir: SessionUsageSortDir = query.dir === 'asc' ? 'asc' : 'desc'

  const sessions: SessionUsageView[] = querySessions({ from, to, source, limit, sort, dir })
  ok(res, { sessions })
}

// ────────────────────────────────────────────────────────────────────
// 用量测算(usage-benchmark,秒表式窗口化测算,panel-origin 放行)
// ────────────────────────────────────────────────────────────────────

/**
 * GET /ai-productivity/usage-benchmark
 * 返回 `{ active, sessions }`:进行中会话(无则 null)+ 历史记录(倒序)。
 */
export function handleGetUsageBenchmark(res: ServerResponse): void {
  const file: UsageBenchmarkFile = readBenchmark()
  ok(res, { active: file.active, sessions: file.sessions })
}

export interface StartUsageBenchmarkBody {
  label?: unknown
  sources?: unknown
}

const BENCHMARK_SOURCE_SET: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

/**
 * POST /ai-productivity/usage-benchmark/start
 * body `{ label?, sources:string[] }`:启动测算会话。sources 非法 / 已有 active → 400。
 */
export function handleStartUsageBenchmark(
  res: ServerResponse,
  body: StartUsageBenchmarkBody
): void {
  const rawSources = Array.isArray(body?.sources) ? body.sources : []
  const sources = Array.from(
    new Set(
      rawSources.filter((s): s is AiUsageSource =>
        BENCHMARK_SOURCE_SET.includes(s as AiUsageSource)
      )
    )
  )
  if (sources.length === 0) {
    fail(res, 400, '至少选择一个有效的 AI 工具(cursor / claude-code / codex)')
    return
  }
  const label = typeof body?.label === 'string' ? body.label : undefined
  try {
    const active: UsageBenchmarkActive = startBenchmark({ label, sources })
    ok(res, { active })
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : '启动测算失败')
  }
}

/**
 * POST /ai-productivity/usage-benchmark/stop
 * 结束当前测算会话,返回刚定格的记录。无 active → 400。
 */
export function handleStopUsageBenchmark(res: ServerResponse): void {
  try {
    const session: UsageBenchmarkSession = stopBenchmark()
    ok(res, { session })
  } catch (err) {
    fail(res, 400, err instanceof Error ? err.message : '结束测算失败')
  }
}

/**
 * POST /ai-productivity/usage-benchmark/cancel
 * 取消当前测算会话(幂等),返回 `{ active:null }`。
 */
export function handleCancelUsageBenchmark(res: ServerResponse): void {
  cancelBenchmark()
  ok(res, { active: null })
}

export interface DeleteUsageBenchmarkBody {
  id?: unknown
}

/**
 * POST /ai-productivity/usage-benchmark/delete
 * body `{ id }`:删除一条历史记录(幂等)。
 */
export function handleDeleteUsageBenchmark(
  res: ServerResponse,
  body: DeleteUsageBenchmarkBody
): void {
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!id) {
    fail(res, 400, 'id 必填')
    return
  }
  deleteBenchmark(id)
  ok(res, { ok: true })
}

// 缺省导出,提供给 server.ts 注册
export { DEFAULT_FORMULA }
export type { StoredRequirement }
