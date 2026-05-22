import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
