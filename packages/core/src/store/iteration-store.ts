import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { ensureRawDir, ensureRequirementDir, iterationsFilePath } from './paths.js'
import { upsertIndexEntry } from './index-store.js'
import { consumePendingSummary } from './pending-summary.js'

export type IterationKind = 'init' | 'first_coding' | 'coding' | 'milestone'

export interface StoredChangedFile {
  path: string
  status: string
}

export type ConversationType = 'coding' | 'communication'

/**
 * v2.5.0 iteration 来源 AI 工具标识。
 *
 * - 'cursor': Hook 路径 body.source='cursor-hook',或 skill 模板硬编码
 * - 'claude-code': Watcher 监听 ~/.claude/projects,或 Hook 路径 body.source='claude-hook'
 * - 'unknown': 老数据缺失字段、来源无法识别
 *
 * 前端约定:'unknown' 不渲染 chip,避免视觉冗余。
 */
export type IterationSource = 'cursor' | 'claude-code' | 'unknown'

const VALID_SOURCES: readonly IterationSource[] = ['cursor', 'claude-code', 'unknown']

export function normalizeIterationSource(raw: unknown): IterationSource {
  if (typeof raw !== 'string') return 'unknown'
  return (VALID_SOURCES as readonly string[]).includes(raw) ? (raw as IterationSource) : 'unknown'
}

/**
 * v2.4.0 结构化对话总结。由 ai-productivity-track skill 在每轮答复前通过
 * ai_productivity_attach_summary MCP tool 回填到「最新一条非 init iteration」。
 *
 * 兼容性:v2.3.x 旧数据是字符串,反序列化时由 normalizeConversationSummary 包装为
 * { oneLine: 截前 120 字, type: 'communication', discussion: <原文> },前端只见结构化。
 */
export interface ConversationSummary {
  /** 一句话总结,≤120 字 */
  oneLine: string
  /** 对话类型:coding=本轮涉及代码改动,communication=纯沟通/讨论 */
  type: ConversationType
  /** 改动范围简述,≤120 字(type='coding' 时必填) */
  changeScope?: string
  /** 讨论内容简述,≤300 字(type='communication' 时必填) */
  discussion?: string
}

const ONE_LINE_MAX = 120
const CHANGE_SCOPE_MAX = 120
const DISCUSSION_MAX = 300

function truncateForStore(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 把 jsonl 中任意形态(旧字符串 / 新对象 / 残缺对象)规范化为 ConversationSummary | null。
 * 不做 throw,任何格式异常一律降级为 null,前端会显示「本轮无 AI 对话总结」占位。
 */
export function normalizeConversationSummary(raw: unknown): ConversationSummary | null {
  if (raw == null) return null

  // v2.3.x 旧字符串数据 → lazy 升级为 communication 类型
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    return {
      oneLine: truncateForStore(text, ONE_LINE_MAX),
      type: 'communication',
      discussion: text.length > DISCUSSION_MAX ? text.slice(0, DISCUSSION_MAX) : text
    }
  }

  if (typeof raw !== 'object') return null
  const r = raw as Partial<ConversationSummary>
  const oneLine = typeof r.oneLine === 'string' ? r.oneLine.trim() : ''
  if (!oneLine) return null
  const type: ConversationType = r.type === 'coding' ? 'coding' : 'communication'
  const changeScope = typeof r.changeScope === 'string' ? r.changeScope.trim() : ''
  const discussion = typeof r.discussion === 'string' ? r.discussion.trim() : ''
  return {
    oneLine: truncateForStore(oneLine, ONE_LINE_MAX),
    type,
    ...(changeScope ? { changeScope: truncateForStore(changeScope, CHANGE_SCOPE_MAX) } : {}),
    ...(discussion ? { discussion: truncateForStore(discussion, DISCUSSION_MAX) } : {})
  }
}

export interface StoredIteration {
  seq: number
  kind: IterationKind
  branch: string
  /**
   * v2.5.0 调用方 AI 工具来源。Hook 路径按 body.source 归一化、Watcher 路径硬编码 'claude-code'、
   * MCP attach_summary 可选传入并仅在 target 缺失时回填。老数据缺字段 lazy 默认为 'unknown'。
   */
  source: IterationSource
  cumulativeToken: number
  elapsedMinutes: number
  firstCodingCompletion: number | null
  aiQualitySelfScore: number | null
  aiConfidence: number | null
  /**
   * 本次对话变更(自上一轮 iteration 以来的增量), 通过两次 numstat 做减法得出。
   * 历史 v2.0.x 数据语义为「相对 HEAD 的未提交改动」, 但前端展示统一按「本次对话变更」呈现,
   * 老数据看起来会偏大一些, 属于可接受的回填精度。
   */
  diffFiles: number
  diffInsertions: number
  diffDeletions: number
  changedFiles: StoredChangedFile[]
  /**
   * 总变更(自 init 时记录的 baseCommit 以来的累计变更, 含工作区未提交)。
   * 老数据没有此字段时, 反序列化后为空数组 / 0, 前端展示 '—'。
   */
  cumulativeDiffFiles: number
  cumulativeDiffInsertions: number
  cumulativeDiffDeletions: number
  cumulativeChangedFiles: StoredChangedFile[]
  milestoneNote: string
  thinkSeconds: number
  /**
   * v1.0.0-rc.18 新增:本轮内 Cursor `afterAgentThought` hook 上报的 thinking 块 `duration_ms`
   * 累加之后取整除 1000。表示「纯模型思考时间」,与 `thinkSeconds`(本轮 wall time)解耦。
   *
   * - Cursor 链路:有 `afterAgentThought` hook 触发时 ≥ 0;无 thinking 模型时通常为 0。
   * - Claude Code 链路 / 老数据:字段缺失,反序列化保留为 `undefined`,UI tooltip 自动隐藏。
   */
  pureThinkSeconds?: number
  modelName: string
  reportedAt: string
  /** rawPayload 落盘到 raw/<reportedAt>-<seq>.json,这里只存相对文件名;为 null 表示未落 raw */
  rawPayloadFile: string | null
  /**
   * v2.4.0 结构化对话总结。v2.3.x 旧数据是字符串,读取时由 normalizeConversationSummary
   * 升级为对象。前端只面对结构化结果。
   */
  conversationSummary: ConversationSummary | null
}

export interface AppendIterationInput {
  kind: IterationKind
  branch?: string
  /** v2.5.0 调用方 AI 工具来源,缺省 'unknown' */
  source?: IterationSource
  cumulativeToken?: number
  elapsedMinutes?: number
  firstCodingCompletion?: number | null
  aiQualitySelfScore?: number | null
  aiConfidence?: number | null
  diffFiles?: number
  diffInsertions?: number
  diffDeletions?: number
  changedFiles?: StoredChangedFile[]
  cumulativeDiffFiles?: number
  cumulativeDiffInsertions?: number
  cumulativeDiffDeletions?: number
  cumulativeChangedFiles?: StoredChangedFile[]
  milestoneNote?: string
  thinkSeconds?: number
  /** v1.0.0-rc.18 Cursor afterAgentThought 累加纯思考时长;Claude Code / 旧数据缺省 */
  pureThinkSeconds?: number
  modelName?: string
  rawPayload?: Record<string, unknown>
  /** 自定义 reportedAt;缺省 now() */
  reportedAt?: string
}

function safeReadLines(file: string): string[] {
  if (!existsSync(file)) return []
  try {
    const raw = readFileSync(file, 'utf-8')
    return raw.split('\n').filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

/**
 * 把 jsonl 旧条目缺失的 cumulative* 字段补成 0 / [], 避免前端访问 undefined。
 * 同时让 changedFiles 永远是数组。
 */
function normalizeIterationRow(raw: unknown): StoredIteration | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<StoredIteration>
  if (typeof r.seq !== 'number') return null
  return {
    seq: r.seq,
    kind: (r.kind ?? 'coding') as IterationKind,
    branch: typeof r.branch === 'string' ? r.branch : '',
    source: normalizeIterationSource(r.source),
    cumulativeToken: typeof r.cumulativeToken === 'number' ? r.cumulativeToken : 0,
    elapsedMinutes: typeof r.elapsedMinutes === 'number' ? r.elapsedMinutes : 0,
    firstCodingCompletion:
      typeof r.firstCodingCompletion === 'number' ? r.firstCodingCompletion : null,
    aiQualitySelfScore: typeof r.aiQualitySelfScore === 'number' ? r.aiQualitySelfScore : null,
    aiConfidence: typeof r.aiConfidence === 'number' ? r.aiConfidence : null,
    diffFiles: typeof r.diffFiles === 'number' ? r.diffFiles : 0,
    diffInsertions: typeof r.diffInsertions === 'number' ? r.diffInsertions : 0,
    diffDeletions: typeof r.diffDeletions === 'number' ? r.diffDeletions : 0,
    changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : [],
    cumulativeDiffFiles: typeof r.cumulativeDiffFiles === 'number' ? r.cumulativeDiffFiles : 0,
    cumulativeDiffInsertions:
      typeof r.cumulativeDiffInsertions === 'number' ? r.cumulativeDiffInsertions : 0,
    cumulativeDiffDeletions:
      typeof r.cumulativeDiffDeletions === 'number' ? r.cumulativeDiffDeletions : 0,
    cumulativeChangedFiles: Array.isArray(r.cumulativeChangedFiles) ? r.cumulativeChangedFiles : [],
    milestoneNote: typeof r.milestoneNote === 'string' ? r.milestoneNote : '',
    thinkSeconds: typeof r.thinkSeconds === 'number' ? r.thinkSeconds : 0,
    // v1.0.0-rc.18: 旧数据缺该字段时保持 undefined,UI 据此判断是否渲染 tooltip 第二行。
    // 显式 0 / 数字保留;非法值(字符串等)归 undefined。
    pureThinkSeconds: typeof r.pureThinkSeconds === 'number' ? r.pureThinkSeconds : undefined,
    modelName: typeof r.modelName === 'string' ? r.modelName : '',
    reportedAt: typeof r.reportedAt === 'string' ? r.reportedAt : '',
    rawPayloadFile: typeof r.rawPayloadFile === 'string' ? r.rawPayloadFile : null,
    conversationSummary: normalizeConversationSummary(r.conversationSummary)
  }
}

export function listIterations(jiraKey: string, root?: string): StoredIteration[] {
  const file = iterationsFilePath(jiraKey, root)
  const out: StoredIteration[] = []
  for (const line of safeReadLines(file)) {
    try {
      const normalized = normalizeIterationRow(JSON.parse(line))
      if (normalized) out.push(normalized)
    } catch {
      // skip malformed line
    }
  }
  return out.sort((a, b) => a.seq - b.seq)
}

export function getNextSeq(jiraKey: string, root?: string): number {
  const all = listIterations(jiraKey, root)
  if (!all.length) return 1
  return Math.max(...all.map((it) => it.seq)) + 1
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, '-')
}

/**
 * 追加一条 iteration. 自动:
 * - 分配自增 seq
 * - 时间戳缺省为 now
 * - 若 input.rawPayload 非空,落盘到 raw/<safe-reportedAt>-<seq>.json 并存文件名
 * - 更新 index.json 的 iterationCount / latestIterationAt / updatedAt
 */
export function appendIteration(
  jiraKey: string,
  input: AppendIterationInput,
  root?: string
): StoredIteration {
  ensureRequirementDir(jiraKey, root)
  const seq = getNextSeq(jiraKey, root)
  const reportedAt = input.reportedAt ?? new Date().toISOString()

  let rawPayloadFile: string | null = null
  if (input.rawPayload && Object.keys(input.rawPayload).length > 0) {
    const rawDir = ensureRawDir(jiraKey, root)
    const filename = `${sanitizeForFilename(reportedAt)}-${seq}.json`
    const fullPath = join(rawDir, filename)
    writeFileSync(fullPath, JSON.stringify(input.rawPayload, null, 2) + '\n', 'utf-8')
    rawPayloadFile = filename
  }

  // v2.7.0 attach-summary pending consume:
  // attach_summary 不再直接改写"最新一条非 init iteration"(那写到上一轮,本轮永远空),
  // 而是把总结写到 <jiraKey>/pending-summary.json,在落新一条 iteration 时同步消费,
  // 让总结自然挂到当前这轮 iteration 上。kind='init' 跳过(init 不挂总结)。
  let consumedSummary: ConversationSummary | null = null
  let consumedSource: IterationSource | null = null
  if (input.kind !== 'init') {
    try {
      const pending = consumePendingSummary(jiraKey, root)
      if (pending) {
        consumedSummary = pending.summary
        consumedSource = pending.source ?? null
      }
    } catch {
      // pending 读盘失败时不阻塞 iteration 写入
    }
  }

  const incomingSource = normalizeIterationSource(input.source)
  const finalSource: IterationSource =
    incomingSource !== 'unknown'
      ? incomingSource
      : consumedSource && consumedSource !== 'unknown'
        ? consumedSource
        : 'unknown'

  const entry: StoredIteration = {
    seq,
    kind: input.kind,
    branch: input.branch ?? '',
    source: finalSource,
    cumulativeToken: input.cumulativeToken ?? 0,
    elapsedMinutes: input.elapsedMinutes ?? 0,
    firstCodingCompletion: input.firstCodingCompletion ?? null,
    aiQualitySelfScore: input.aiQualitySelfScore ?? null,
    aiConfidence: input.aiConfidence ?? null,
    diffFiles: input.diffFiles ?? 0,
    diffInsertions: input.diffInsertions ?? 0,
    diffDeletions: input.diffDeletions ?? 0,
    changedFiles: input.changedFiles ?? [],
    cumulativeDiffFiles: input.cumulativeDiffFiles ?? 0,
    cumulativeDiffInsertions: input.cumulativeDiffInsertions ?? 0,
    cumulativeDiffDeletions: input.cumulativeDiffDeletions ?? 0,
    cumulativeChangedFiles: input.cumulativeChangedFiles ?? [],
    milestoneNote: input.milestoneNote ?? '',
    thinkSeconds: input.thinkSeconds ?? 0,
    // 仅在显式传入 number 时落盘;缺省 undefined,jsonl 序列化时整字段省略,兼容老看板。
    ...(typeof input.pureThinkSeconds === 'number'
      ? { pureThinkSeconds: input.pureThinkSeconds }
      : {}),
    modelName: input.modelName ?? '',
    reportedAt,
    rawPayloadFile,
    conversationSummary: consumedSummary
  }

  const file = iterationsFilePath(jiraKey, root)
  appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8')

  const total = seq
  upsertIndexEntry(
    jiraKey,
    {
      iterationCount: total,
      latestIterationAt: reportedAt,
      updatedAt: reportedAt
    },
    root
  )

  return entry
}

export function loadRawPayload(
  jiraKey: string,
  rawPayloadFile: string,
  root?: string
): Record<string, unknown> | null {
  if (!rawPayloadFile) return null
  const fullPath = join(ensureRawDir(jiraKey, root), rawPayloadFile)
  if (!existsSync(fullPath)) return null
  try {
    return JSON.parse(readFileSync(fullPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────
// v2.18.0 数据整理:合并 Cursor stop-hook 兜底产生的拆分 iteration
//
// 背景:Cursor 偶尔不主动调 ai_productivity_attach_summary, stop-hook 兜底
// 强制 LLM 重答,触发第二次 afterAgentResponse hook → appendIteration 被调用
// 两次 → 形成"前一条 conversationSummary=null + 后一条 conversationSummary 满"
// 的拆分对。本节提供一个手动整理通路,把这类双条记录合并成一条,看板 UI
// 通过新增的「数据整理」按钮一键触发。
//
// 设计点:
// - 唯一写入点仍是 appendIteration(append-only)。整理时走 rewriteIterations
//   (整文件 tmp + rename),不动 append-only 主路径。
// - 严格识别规则避免误合相邻两轮真实对话(详 shouldMergeAutoSplit)。
// - 合并前自动写 .bak-<ts> 备份,误判可手动 mv 回来。
// - StoredIteration schema 完全不变(不引入 mergedAt / mergedFromSeqs 等
//   新字段),UI / api 类型 0 变更。被合并的 b 行 raw 文件保留在 raw/
//   下,但不再被主表引用,事实上的孤儿,审计可从 .bak 比对找回。
// ────────────────────────────────────────────────────────────────────

const MERGE_AUTO_SPLIT_MAX_INTERVAL_MS = 120_000

/**
 * 把 jsonl 行用 mutator 替换为新数组,整文件 tmp+rename 原子重写。
 * 同步更新 INDEX 的 iterationCount / latestIterationAt / updatedAt。
 *
 * 注意:rewriteIterations 会丢失任何 normalizeIterationRow 不识别的旧字段。
 * 老数据若带有 schema 外的扩展字段不应走该路径(本仓库目前无此情况)。
 */
export function rewriteIterations(
  jiraKey: string,
  mutator: (rows: StoredIteration[]) => StoredIteration[],
  root?: string
): { wrote: number } {
  ensureRequirementDir(jiraKey, root)
  const rows = listIterations(jiraKey, root)
  const next = mutator(rows)

  const file = iterationsFilePath(jiraKey, root)
  const tmp = `${file}.tmp`
  const payload = next.length ? next.map((it) => JSON.stringify(it)).join('\n') + '\n' : ''
  writeFileSync(tmp, payload, 'utf-8')
  renameSync(tmp, file)

  const latest = next.length > 0 ? next[next.length - 1] : null
  const now = new Date().toISOString()
  upsertIndexEntry(
    jiraKey,
    {
      iterationCount: next.length,
      latestIterationAt: latest?.reportedAt ?? null,
      updatedAt: now
    },
    root
  )

  return { wrote: next.length }
}

/**
 * 备份当前 iterations.jsonl 到 `<file>.bak-<YYYYMMDDHHMMSS>`,
 * 文件不存在或备份失败时返回 null。
 */
export function backupIterations(jiraKey: string, root?: string): string | null {
  const file = iterationsFilePath(jiraKey, root)
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backupPath = `${file}.bak-${stamp}`
  try {
    copyFileSync(file, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * 严格识别"Cursor stop-hook 兜底产生的拆分对"。
 *
 * 同时满足以下条件才会被认为是同一轮对话的双条记录:
 * - 两条均非 init iteration
 * - 同一个非空 branch
 * - 时间间隔 [0, 120s](stop-hook 兜底的强制重答几乎都在 60s 以内)
 * - 前一条 conversationSummary === null(LLM 没调 attach_summary)
 * - 后一条 conversationSummary !== null(stop-hook 兜底 + 强制重答补上了总结)
 * - 后一条 source === 'cursor'(本兜底链路只存在于 Cursor 一侧)
 */
export function shouldMergeAutoSplit(a: StoredIteration, b: StoredIteration): boolean {
  if (a.kind === 'init' || b.kind === 'init') return false
  if (!a.branch || !b.branch || a.branch !== b.branch) return false
  if (a.conversationSummary != null) return false
  if (b.conversationSummary == null) return false
  if (b.source !== 'cursor') return false
  const aTime = Date.parse(a.reportedAt)
  const bTime = Date.parse(b.reportedAt)
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false
  const delta = bTime - aTime
  if (delta < 0 || delta > MERGE_AUTO_SPLIT_MAX_INTERVAL_MS) return false
  return true
}

function mergeChangedFiles(a: StoredChangedFile[], b: StoredChangedFile[]): StoredChangedFile[] {
  const byPath = new Map<string, StoredChangedFile>()
  for (const f of a) {
    if (f && typeof f.path === 'string' && f.path) byPath.set(f.path, f)
  }
  // 后者覆盖前者,保留更接近终态的 status
  for (const f of b) {
    if (f && typeof f.path === 'string' && f.path) byPath.set(f.path, f)
  }
  return [...byPath.values()]
}

/**
 * 把拆分对 (a, b) 合并为一条 iteration。b 合到 a:
 *
 * - seq:沿用 a.seq(前端按数组顺序渲染,seq 不连续无影响)
 * - kind/source/branch/modelName:b 优先(b 是补救后的"完整态"),空时回退 a
 * - 累计快照(cumulative*):取 b(b 时间更晚,快照更准)
 * - 本轮增量(diff* / changedFiles / thinkSeconds):a + b(同一轮真实增量之和)
 * - cumulativeToken / elapsedMinutes:max(a, b)(理论上 b ≥ a,容错保护)
 * - reportedAt:取 b 的(代表合并后这条 iteration 的最终时间)
 * - rawPayloadFile:保留 a 的指针(b 的 raw 文件不删,但变成孤儿,可从 .bak 反查)
 * - conversationSummary:取 b 的(非空那条)
 */
export function mergeIterationPair(a: StoredIteration, b: StoredIteration): StoredIteration {
  const safeStr = (val: string, fallback: string): string => (val && val.trim() ? val : fallback)
  return {
    seq: a.seq,
    kind: b.kind,
    branch: safeStr(b.branch, a.branch),
    source: b.source !== 'unknown' ? b.source : a.source,
    cumulativeToken: Math.max(a.cumulativeToken, b.cumulativeToken),
    elapsedMinutes: Math.max(a.elapsedMinutes, b.elapsedMinutes),
    firstCodingCompletion: a.firstCodingCompletion ?? b.firstCodingCompletion,
    aiQualitySelfScore: b.aiQualitySelfScore ?? a.aiQualitySelfScore,
    aiConfidence: b.aiConfidence ?? a.aiConfidence,
    diffFiles: a.diffFiles + b.diffFiles,
    diffInsertions: a.diffInsertions + b.diffInsertions,
    diffDeletions: a.diffDeletions + b.diffDeletions,
    changedFiles: mergeChangedFiles(a.changedFiles, b.changedFiles),
    cumulativeDiffFiles: b.cumulativeDiffFiles,
    cumulativeDiffInsertions: b.cumulativeDiffInsertions,
    cumulativeDiffDeletions: b.cumulativeDiffDeletions,
    cumulativeChangedFiles: b.cumulativeChangedFiles,
    milestoneNote: safeStr(b.milestoneNote, a.milestoneNote),
    thinkSeconds: a.thinkSeconds + b.thinkSeconds,
    // pureThinkSeconds:与 thinkSeconds 同口径(同一轮真实增量之和)。任一缺失走兜底,
    // 两条都缺失才保留 undefined,避免给老数据强行注入 0 改变 UI 渲染行为。
    pureThinkSeconds:
      typeof a.pureThinkSeconds === 'number' || typeof b.pureThinkSeconds === 'number'
        ? (a.pureThinkSeconds ?? 0) + (b.pureThinkSeconds ?? 0)
        : undefined,
    modelName: safeStr(b.modelName, a.modelName),
    reportedAt: b.reportedAt,
    rawPayloadFile: a.rawPayloadFile,
    conversationSummary: b.conversationSummary
  }
}

export interface MergeAutoSplitPair {
  fromSeq: number
  intoSeq: number
}

export interface MergeAutoSplitResult {
  mergedPairs: MergeAutoSplitPair[]
  totalBefore: number
  totalAfter: number
  /** dryRun=true 或 mergedPairs=[] 时为 null;真合并成功时为备份文件绝对路径 */
  backupPath: string | null
}

/**
 * 扫描指定需求的 iterations.jsonl,按 shouldMergeAutoSplit 规则合并拆分对。
 *
 * - options.dryRun=true 时只做扫描 + 计数,不写盘,不备份
 * - 没有候选对时:不写盘,backupPath=null,totalAfter=totalBefore
 * - 真合并时:先写 .bak-<ts> 备份,再 rewriteIterations 整文件重写
 *
 * 多趟扫描设计:合并完一对后从 b 之后接着扫描,保证 [空, 空, 满] 三条相邻
 * 时不会把第一条空跟第二条空错配成"合并对"。
 */
export function mergeAutoSplitIterations(
  jiraKey: string,
  options: { dryRun?: boolean; root?: string } = {}
): MergeAutoSplitResult {
  const rows = listIterations(jiraKey, options.root)
  const merged: StoredIteration[] = []
  const pairs: MergeAutoSplitPair[] = []

  let i = 0
  while (i < rows.length) {
    const a = rows[i]
    const b = rows[i + 1]
    if (b && shouldMergeAutoSplit(a, b)) {
      merged.push(mergeIterationPair(a, b))
      pairs.push({ fromSeq: b.seq, intoSeq: a.seq })
      i += 2
    } else {
      merged.push(a)
      i += 1
    }
  }

  if (pairs.length === 0) {
    return {
      mergedPairs: pairs,
      totalBefore: rows.length,
      totalAfter: rows.length,
      backupPath: null
    }
  }

  if (options.dryRun) {
    return {
      mergedPairs: pairs,
      totalBefore: rows.length,
      totalAfter: merged.length,
      backupPath: null
    }
  }

  const backupPath = backupIterations(jiraKey, options.root)
  rewriteIterations(jiraKey, () => merged, options.root)
  return {
    mergedPairs: pairs,
    totalBefore: rows.length,
    totalAfter: merged.length,
    backupPath
  }
}
