/**
 * v1.0.0-rc.23 单需求复盘报告(retrospective)存储层。
 *
 * 设计要点:
 * - per-feature 单文件:`<requirementDir>/retrospective.json`,每个 jiraKey 至多保留 1 份最新报告
 * - 覆盖式更新:LLM 通过 `ai_productivity_save_retrospective` 重新触发会替换老内容
 * - 快照锚点:落盘时记录 `generatedAtIterationSeq` / `generatedAtIterationCount`,
 *   即使后续 iteration 增长,也能看出报告基于哪一轮生成,避免语义漂移
 * - schemaVersion 软兜底:`loadRetrospective` 见到未知 schemaVersion 返回 null + 不删盘,
 *   留出 v2 schema 升级空间
 *
 * 与 lessons 联动(职责分离):
 * - 复盘 narrative 引用经验是「弱引用」,通过 `referencedLessonIds[]` 关联,**不重复落盘**
 *   lesson 内容;看板渲染时按 id 拉详情。lesson 删了之后看板侧友好降级。
 * - 复盘报告本身不承担「沉淀新经验」职责,LLM 应在复盘后单独走 lessons-extract skill。
 *
 * 写入采用 tmp + rename 原子模式,与 requirement-store / numstat-snapshot 一致。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

import { computeMetrics, type RequirementMetrics } from '../metrics.js'
import {
  ABNORMAL_STOP_REASONS,
  buildComputedSignals,
  listLessons,
  type BundleComputedSignals,
  type LessonIndexEntry
} from './lessons-store.js'
import { listIterations, loadRawPayload, type StoredIteration } from './iteration-store.js'
import { loadRequirement, type StoredRequirement } from './requirement-store.js'
import { readFormula, DEFAULT_FORMULA } from './formula-store.js'
import { ensureRequirementDir, retrospectivePath } from './paths.js'

export const CURRENT_RETROSPECTIVE_SCHEMA_VERSION = 1

export type RetrospectiveSource = 'cursor' | 'claude-code' | 'manual'

/** 单需求复盘报告里 LLM 推理产物的硬约束(超长会被 store 端静默截断) */
export const RETROSPECTIVE_LIMITS = {
  overviewMaxChars: 600,
  phaseSummaryMaxChars: 400,
  phaseTitleMaxChars: 80,
  bulletMaxChars: 300,
  phasesMaxCount: 8,
  bulletsMaxCount: 8,
  referencedLessonsMaxCount: 32,
  anchorIterationsMaxCount: 16
} as const

export interface RetrospectivePhase {
  /** 阶段标题(≤80 字),例如「设计与拆分」「调试与修复」 */
  title: string
  /** 该阶段覆盖的 iteration seq 闭区间 [from, to] */
  iterationSeqRange: [number, number]
  /** 阶段叙事(≤400 字,markdown / plain text) */
  summary: string
}

export interface RetrospectiveNarrative {
  /** 一段话总览(≤600 字) */
  overview: string
  /** 阶段拆分(最多 8 段) */
  phases: RetrospectivePhase[]
  /** 亮点(每条 ≤300 字,最多 8 条) */
  highlights: string[]
  /** 暴露的问题(每条 ≤300 字,最多 8 条) */
  issues: string[]
  /** 改进建议(每条 ≤300 字,最多 8 条) */
  improvements: string[]
  /** 观察到的坑(与 lessons pitfall 类型联动) */
  pitfallsObserved: string[]
  /** 下次类似需求的预热建议 */
  nextSteps: string[]
  /** 对话拆分建议(可选) */
  splitSuggestions?: string[]
}

/**
 * 落盘时 daemon 端基于 RequirementMetrics + iterations 自动算出的硬数据快照,
 * 跟 LLM 推理无关。LLM 即便传了字段也会被忽略;前端展示时优先用此处的数值,
 * 避免后续 iteration 增长后报告里的客观数据漂移。
 */
export interface RetrospectiveSnapshot {
  title: string
  status: 'in_progress' | 'finished' | 'abandoned'
  boost: number | null
  cumulativeToken: number
  totalThinkSeconds: number
  elapsedMinutes: number
  cumulativeDiffFiles: number
  cumulativeDiffInsertions: number
  cumulativeDiffDeletions: number
  linkedBugCount: number
  lessonsCount: number
  abnormalStopReasonsCount: number
}

export interface StoredRetrospective {
  schemaVersion: number
  jiraKey: string
  generatedAt: string
  /** 基于哪一轮 iteration 生成(末轮 seq);无 iteration 时为 0 */
  generatedAtIterationSeq: number
  /** 生成时 iterations 总数,展示「基于第 N 轮 / 共 N 轮」 */
  generatedAtIterationCount: number
  source: RetrospectiveSource
  snapshot: RetrospectiveSnapshot
  narrative: RetrospectiveNarrative
  /** 复盘里引用的 lesson id(从本 jiraKey 已沉淀的经验里选) */
  referencedLessonIds: string[]
  /** 报告引用的关键 iteration(高 think / 高 churn / 异常 stop) */
  anchorIterationSeqs: number[]
}

/** LLM 通过 MCP 落盘时的最少入参,id/createdAt/snapshot 由 store 端兜底生成 */
export interface WriteRetrospectiveInput {
  narrative: RetrospectiveNarrative
  source?: RetrospectiveSource
  referencedLessonIds?: string[]
  anchorIterationSeqs?: number[]
}

export interface RetrospectiveBundleRelatedLesson {
  id: string
  jiraKey: string
  type: LessonIndexEntry['type']
  title: string
  scope: LessonIndexEntry['scope']
  projectSlug: string
  hitCount: number
}

export interface RetrospectiveBundle {
  jiraKey: string
  currentProjectSlug: string
  requirement: StoredRequirement | null
  iterations: StoredIteration[]
  computedSignals: BundleComputedSignals
  relatedLessons: RetrospectiveBundleRelatedLesson[]
  /** 已存在的报告(让 LLM 知道上次说了啥,避免无变化重复落盘) */
  existingRetrospective: StoredRetrospective | null
}

// ============== 工具函数 ==============

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

function clipString(input: unknown, maxChars: number): string {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(0, maxChars)
}

function clipBulletList(input: unknown, maxCount: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    const s = clipString(item, RETROSPECTIVE_LIMITS.bulletMaxChars)
    if (s) out.push(s)
    if (out.length >= maxCount) break
  }
  return out
}

function clipBulletListOptional(input: unknown, maxCount: number): string[] | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) return undefined
  const out = clipBulletList(input, maxCount)
  return out.length > 0 ? out : undefined
}

function normalizePhases(input: unknown): RetrospectivePhase[] {
  if (!Array.isArray(input)) return []
  const out: RetrospectivePhase[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const range = r.iterationSeqRange
    if (!Array.isArray(range) || range.length !== 2) continue
    const from = Number(range[0])
    const to = Number(range[1])
    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to < from) continue
    const title = clipString(r.title, RETROSPECTIVE_LIMITS.phaseTitleMaxChars)
    if (!title) continue
    const summary = clipString(r.summary, RETROSPECTIVE_LIMITS.phaseSummaryMaxChars)
    out.push({ title, iterationSeqRange: [from, to], summary })
    if (out.length >= RETROSPECTIVE_LIMITS.phasesMaxCount) break
  }
  return out
}

function normalizeNarrative(input: unknown): RetrospectiveNarrative {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    overview: clipString(r.overview, RETROSPECTIVE_LIMITS.overviewMaxChars),
    phases: normalizePhases(r.phases),
    highlights: clipBulletList(r.highlights, RETROSPECTIVE_LIMITS.bulletsMaxCount),
    issues: clipBulletList(r.issues, RETROSPECTIVE_LIMITS.bulletsMaxCount),
    improvements: clipBulletList(r.improvements, RETROSPECTIVE_LIMITS.bulletsMaxCount),
    pitfallsObserved: clipBulletList(r.pitfallsObserved, RETROSPECTIVE_LIMITS.bulletsMaxCount),
    nextSteps: clipBulletList(r.nextSteps, RETROSPECTIVE_LIMITS.bulletsMaxCount),
    splitSuggestions: clipBulletListOptional(
      r.splitSuggestions,
      RETROSPECTIVE_LIMITS.bulletsMaxCount
    )
  }
}

function normalizeIdArray(input: unknown, limit: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

function normalizeSeqArray(input: unknown, limit: number): number[] {
  if (!Array.isArray(input)) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const item of input) {
    const n = Number(item)
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= limit) break
  }
  return out.sort((a, b) => a - b)
}

function normalizeSource(input: unknown): RetrospectiveSource {
  if (input === 'cursor' || input === 'claude-code' || input === 'manual') return input
  return 'manual'
}

function normalizeSnapshot(input: unknown): RetrospectiveSnapshot {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const status = r.status
  const safeStatus: RetrospectiveSnapshot['status'] =
    status === 'in_progress' || status === 'finished' || status === 'abandoned'
      ? status
      : 'in_progress'
  const numberOr = (v: unknown, dft: number): number => {
    return typeof v === 'number' && Number.isFinite(v) ? v : dft
  }
  const boost = typeof r.boost === 'number' && Number.isFinite(r.boost) ? r.boost : null
  return {
    title: typeof r.title === 'string' ? r.title : '',
    status: safeStatus,
    boost,
    cumulativeToken: numberOr(r.cumulativeToken, 0),
    totalThinkSeconds: numberOr(r.totalThinkSeconds, 0),
    elapsedMinutes: numberOr(r.elapsedMinutes, 0),
    cumulativeDiffFiles: numberOr(r.cumulativeDiffFiles, 0),
    cumulativeDiffInsertions: numberOr(r.cumulativeDiffInsertions, 0),
    cumulativeDiffDeletions: numberOr(r.cumulativeDiffDeletions, 0),
    linkedBugCount: numberOr(r.linkedBugCount, 0),
    lessonsCount: numberOr(r.lessonsCount, 0),
    abnormalStopReasonsCount: numberOr(r.abnormalStopReasonsCount, 0)
  }
}

// ============== 公开 API ==============

/**
 * 读取单需求复盘报告。
 *
 * - 文件不存在:返回 null
 * - JSON 解析失败:返回 null(打印 warning)
 * - schemaVersion > CURRENT_RETROSPECTIVE_SCHEMA_VERSION:返回 null(预留升级空间,
 *   不主动删盘以保留用户数据)
 * - 字段缺失:走兜底默认值,保证返回结构完整
 */
export function loadRetrospective(jiraKey: string, root?: string): StoredRetrospective | null {
  const file = retrospectivePath(jiraKey, root)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoredRetrospective> & Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null

    const schemaVersion =
      typeof parsed.schemaVersion === 'number' && Number.isInteger(parsed.schemaVersion)
        ? parsed.schemaVersion
        : 1
    if (schemaVersion > CURRENT_RETROSPECTIVE_SCHEMA_VERSION) {
      // 未来 schema,本版本不识别;返回 null,看板侧降级到空态
      console.warn(
        `[retrospective-store] 未识别的 schemaVersion=${schemaVersion}, 当前实现仅支持 ≤${CURRENT_RETROSPECTIVE_SCHEMA_VERSION}`
      )
      return null
    }

    const generatedAtIterationSeqRaw = parsed.generatedAtIterationSeq
    const generatedAtIterationCountRaw = parsed.generatedAtIterationCount
    const generatedAtIterationSeq =
      typeof generatedAtIterationSeqRaw === 'number' &&
      Number.isInteger(generatedAtIterationSeqRaw) &&
      generatedAtIterationSeqRaw >= 0
        ? generatedAtIterationSeqRaw
        : 0
    const generatedAtIterationCount =
      typeof generatedAtIterationCountRaw === 'number' &&
      Number.isInteger(generatedAtIterationCountRaw) &&
      generatedAtIterationCountRaw >= 0
        ? generatedAtIterationCountRaw
        : 0

    return {
      schemaVersion,
      jiraKey: typeof parsed.jiraKey === 'string' && parsed.jiraKey ? parsed.jiraKey : jiraKey,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      generatedAtIterationSeq,
      generatedAtIterationCount,
      source: normalizeSource(parsed.source),
      snapshot: normalizeSnapshot(parsed.snapshot),
      narrative: normalizeNarrative(parsed.narrative),
      referencedLessonIds: normalizeIdArray(
        parsed.referencedLessonIds,
        RETROSPECTIVE_LIMITS.referencedLessonsMaxCount
      ),
      anchorIterationSeqs: normalizeSeqArray(
        parsed.anchorIterationSeqs,
        RETROSPECTIVE_LIMITS.anchorIterationsMaxCount
      )
    }
  } catch (err) {
    console.warn(`[retrospective-store] 解析 ${file} 失败:`, err)
    return null
  }
}

/**
 * 落盘单需求复盘报告。
 *
 * - 校验:`narrative.overview` 必须非空,否则抛错(LLM 返空叙事相当于"未生成")
 * - 自动注入:`schemaVersion` / `generatedAt` / `generatedAtIterationSeq` /
 *   `generatedAtIterationCount` / `snapshot` 全部由 store 端基于当前 iterations + requirement 计算
 * - referencedLessonIds:写入前过滤掉不存在 / 跨需求 / 已删除的 id,避免悬挂引用
 *   (调用方传什么落什么的"宽松"路径在 spec 里特别关心)
 * - anchorIterationSeqs:写入前过滤掉超出 iteration 范围的 seq
 * - 覆盖式:同 jiraKey 重复落盘视为更新
 *
 * 返回值是落盘后的完整对象(snapshot / generatedAt 已注入)。
 */
export function writeRetrospective(
  jiraKey: string,
  input: WriteRetrospectiveInput,
  root?: string
): StoredRetrospective {
  if (!jiraKey || typeof jiraKey !== 'string') {
    throw new Error('jiraKey 必填')
  }
  if (!input || typeof input !== 'object') {
    throw new Error('retrospective 入参必须是对象')
  }
  const narrative = normalizeNarrative(input.narrative)
  if (!narrative.overview) {
    throw new Error('narrative.overview 不能为空(空叙事请走 retrospective.delete 而非 save)')
  }

  ensureRequirementDir(jiraKey, root)

  const requirement = loadRequirement(jiraKey, root)
  const iterations = listIterations(jiraKey, root)

  const referencedLessonIds = (() => {
    const ids = normalizeIdArray(
      input.referencedLessonIds,
      RETROSPECTIVE_LIMITS.referencedLessonsMaxCount
    )
    if (ids.length === 0) return []
    // 过滤掉不属于本 jiraKey 的 lesson(避免引用其它需求的经验产生污染);
    // lessons-store 的 listLessons 已对 jiraKey 做了精确匹配,这里直接交集。
    const ownIds = new Set(listLessons({ jiraKey }, root).map((l) => l.id))
    return ids.filter((id) => ownIds.has(id))
  })()

  const validSeqs = new Set(iterations.map((it) => it.seq))
  const anchorIterationSeqs = normalizeSeqArray(
    input.anchorIterationSeqs,
    RETROSPECTIVE_LIMITS.anchorIterationsMaxCount
  ).filter((seq) => validSeqs.has(seq))

  const generatedAtIterationCount = iterations.length
  const generatedAtIterationSeq = iterations.length ? iterations[iterations.length - 1].seq : 0

  const snapshot = computeRetrospectiveSnapshot(jiraKey, requirement, iterations, root)

  const next: StoredRetrospective = {
    schemaVersion: CURRENT_RETROSPECTIVE_SCHEMA_VERSION,
    jiraKey,
    generatedAt: new Date().toISOString(),
    generatedAtIterationSeq,
    generatedAtIterationCount,
    source: normalizeSource(input.source),
    snapshot,
    narrative,
    referencedLessonIds,
    anchorIterationSeqs
  }

  writeAtomic(retrospectivePath(jiraKey, root), next)
  return next
}

/** 删除复盘报告。文件不存在视为成功(返回 false 表示「无可删」)。 */
export function removeRetrospective(jiraKey: string, root?: string): boolean {
  const file = retrospectivePath(jiraKey, root)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * 计算落盘时的硬数据快照。供 writeRetrospective 内部使用,
 * 也允许测试 / 看板独立调用以"预演"将要落盘的 snapshot。
 */
export function computeRetrospectiveSnapshot(
  jiraKey: string,
  requirement: StoredRequirement | null,
  iterations: StoredIteration[],
  root?: string
): RetrospectiveSnapshot {
  const formula = (() => {
    try {
      return readFormula(root)
    } catch {
      return { ...DEFAULT_FORMULA }
    }
  })()

  let metrics: RequirementMetrics | null = null
  if (requirement) {
    metrics = computeMetrics({
      manualEstimateMinutes: requirement.manualEstimateMinutes,
      iterations,
      subtasks: Array.isArray(requirement.subtasks) ? requirement.subtasks : [],
      linkedBugCount: requirement.linkedBugCount,
      formula
    })
  }

  // 累计 diff 取最后一条 iteration 的 cumulativeDiff*(语义对齐看板)
  const latest = iterations[iterations.length - 1]
  const cumulativeDiffFiles = latest?.cumulativeDiffFiles ?? 0
  const cumulativeDiffInsertions = latest?.cumulativeDiffInsertions ?? 0
  const cumulativeDiffDeletions = latest?.cumulativeDiffDeletions ?? 0

  // 异常 stopReason 数(去重的 reason 种类数)
  const abnormalReasonSet = new Set<string>()
  for (const it of iterations) {
    if (!it.rawPayloadFile) continue
    const raw = loadRawPayload(jiraKey, it.rawPayloadFile, root)
    const reason = raw && typeof raw.triggerStopReason === 'string' ? raw.triggerStopReason : ''
    if (reason && (ABNORMAL_STOP_REASONS as readonly string[]).includes(reason)) {
      abnormalReasonSet.add(reason)
    }
  }

  const lessonsCount = listLessons({ jiraKey }, root).length

  return {
    title: requirement?.title ?? '',
    status: (requirement?.status as RetrospectiveSnapshot['status']) ?? 'in_progress',
    boost: metrics?.boost ?? null,
    cumulativeToken: metrics?.latestCumulativeToken ?? 0,
    totalThinkSeconds: metrics?.totalThinkSeconds ?? 0,
    elapsedMinutes: metrics?.latestElapsedMinutes ?? 0,
    cumulativeDiffFiles,
    cumulativeDiffInsertions,
    cumulativeDiffDeletions,
    linkedBugCount: requirement?.linkedBugCount ?? 0,
    lessonsCount,
    abnormalStopReasonsCount: abnormalReasonSet.size
  }
}

/**
 * 组装一个 jiraKey 的「复盘报告生成数据包」,作为 retrospective-report skill 的输入。
 *
 * 字段构成:
 * - requirement / iterations / computedSignals:复用 buildLessonsBundle 的硬数据计算
 * - currentProjectSlug:用于 LLM 在叙事里准确引用项目名
 * - relatedLessons:本需求已沉淀的经验摘要(精简结构,只含 id / type / scope / projectSlug / title / hitCount),
 *   LLM 在 narrative.referencedLessonIds 里挑选关联经验时用
 * - existingRetrospective:已存在的报告(如果有),让 LLM 知道上次怎么写的,避免无变化重复落盘
 */
export function buildRetrospectiveBundle(jiraKey: string, root?: string): RetrospectiveBundle {
  const requirement = loadRequirement(jiraKey, root)
  const currentProjectSlug = requirement?.projectSlug ?? ''
  const iterations = listIterations(jiraKey, root)
  const computedSignals = buildComputedSignals(jiraKey, iterations, requirement, root)

  const relatedLessons = listLessons({ jiraKey }, root).map<RetrospectiveBundleRelatedLesson>(
    (l) => ({
      id: l.id,
      jiraKey: l.jiraKey,
      type: l.type,
      title: l.title,
      scope: l.scope,
      projectSlug: l.projectSlug,
      hitCount: l.hitCount
    })
  )

  const existingRetrospective = loadRetrospective(jiraKey, root)

  return {
    jiraKey,
    currentProjectSlug,
    requirement,
    iterations,
    computedSignals,
    relatedLessons,
    existingRetrospective
  }
}
