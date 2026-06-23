/**
 * v2.16.0 P0 经验沉淀(lessons) 存储层。
 *
 * 设计要点:
 * - 平铺目录: lessons/<lessonId>.json + lessons/INDEX.json,跨需求统一管理
 * - INDEX 仅持久化列表/筛选所需字段(id / jiraKey / type / title / tags / trust / createdAt),
 *   详情走单文件,避免 INDEX 单文件膨胀;读 list 端点只解析一次 INDEX.json
 * - 写入采用 tmp + rename 原子模式,与 requirement-store 一致
 * - 重复 id 视为覆盖式更新(LLM 重提取场景);delete 同步收缩 INDEX
 * - lessonId 受 isValidLessonId 正则约束,仓库内不会有路径遍历风险
 *
 * v2.18.0 信号化升级:
 * - StoredLesson 追加 signals / seenInJiraKeys / hitCount / trustReasons,所有字段可选并对老数据兜底
 * - writeLessons 内部新增「相似 lesson 自动合并」路径(type+scope+projectSlug+tags Jaccard+title 相似度)
 * - buildLessonsBundle 返回结构追加 computedSignals(供 LLM 推理时优先扫难点 / churn 文件)
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'

import { listIterations, loadRawPayload, type StoredIteration } from './iteration-store.js'
import { loadRequirement, type StoredRequirement } from './requirement-store.js'
import { readFormula, DEFAULT_FORMULA, type FormulaSettings } from './formula-store.js'
import { computeMetrics } from '../metrics.js'
import {
  ensureLessonsDir,
  isValidLessonId,
  lessonFilePath,
  lessonsDir,
  lessonsIndexPath
} from './paths.js'

export type LessonType = 'pitfall' | 'rule' | 'best-practice' | 'split-suggestion' | 'tooling'

export const LESSON_TYPES: readonly LessonType[] = [
  'pitfall',
  'rule',
  'best-practice',
  'split-suggestion',
  'tooling'
]

export type LessonTrust = 'high' | 'medium' | 'low'

export type LessonExtractedBy = 'cursor' | 'claude-code' | 'codex' | 'manual'

/**
 * v2.17.0 经验作用域:
 *   - 'general' = 通用经验,与项目无关,跨项目可复用(projectSlug 为空串)
 *   - 'project' = 项目专属经验,仅在 projectSlug 命中项目内复用(projectSlug 必填)
 *   - ''        = 老数据(v2.16.x 落盘) 未带 scope,前端展示「未分类」
 * 写入时如未明确传入,normalize 后默认 'project'(保守)。
 */
export type LessonScope = 'general' | 'project' | ''

export const LESSON_SCOPES: readonly Exclude<LessonScope, ''>[] = ['general', 'project']

export interface LessonSource {
  extractedBy: LessonExtractedBy
  extractedAt: string
}

/**
 * v2.18.0 经验客观信号快照。由 agent 端在落盘时基于 source iterations + requirement
 * 自动计算并注入,LLM 不需要自己填(填了也会被忽略)。
 *
 * - sourceBoost: 触发本 lesson 的需求当时的 boost(提效倍率);null 表示无人工预估或无 iteration 时长
 * - sourceLinkedBugCount: 触发本 lesson 的需求当时关联 bug 数;null 表示从未刷新过
 * - sourceEffectiveTokens / sourceThinkSeconds: 引用 iterations 的累计 token / 思考时长
 * - sourceAbnormalStopReasons: 引用 iterations 中的非正常 stopReason 集合(max_tokens / pause_turn 等)
 * - sourceMaxChurnFile: 引用 iterations 中被触碰次数最多的文件 + 累计 +/- 行
 *
 * 合并路径(同款经验跨需求再次出现)时,各字段按「boost 取较高、bug 取最新、token/think 累加、
 * stopReasons union、maxChurn 取较大」合并,保证客观信号单调演进。
 */
export interface LessonSignals {
  sourceBoost: number | null
  sourceLinkedBugCount: number | null
  sourceEffectiveTokens: number | null
  sourceThinkSeconds: number | null
  sourceAbnormalStopReasons: string[]
  sourceMaxChurnFile: {
    path: string
    touchCount: number
    insertions: number
    deletions: number
  } | null
}

export interface StoredLesson {
  id: string
  jiraKey: string
  jiraTitle: string
  type: LessonType
  title: string
  content: string
  rootCause?: string
  fix?: string
  reusableWhen?: string
  tags: string[]
  affectedFiles?: string[]
  iterationSeqs?: number[]
  trust: LessonTrust
  createdAt: string
  source: LessonSource
  /** v2.17.0 通用 / 项目专属;老数据缺省时为空串 */
  scope: LessonScope
  /** v2.17.0 项目标识(package.json name),scope='general' 时强制空串 */
  projectSlug: string
  /** v2.18.0 客观信号快照;老数据兜底 null */
  signals: LessonSignals | null
  /** v2.18.0 跨需求"同款踩了哪几个需求"的 jiraKey 列表;老数据兜底 [sourceJiraKey] */
  seenInJiraKeys: string[]
  /** v2.18.0 = seenInJiraKeys.length,冗余字段方便排序;老数据兜底 1 */
  hitCount: number
  /** v2.18.0 由 signals 自动渲染的可读证据数组,供前端展示;老数据兜底 [] */
  trustReasons: string[]
}

export interface LessonIndexEntry {
  id: string
  jiraKey: string
  type: LessonType
  title: string
  tags: string[]
  trust: LessonTrust
  createdAt: string
  /** v2.17.0 INDEX 投影同步 scope 字段,便于客户端 / agent 直接筛选 */
  scope: LessonScope
  /** v2.17.0 INDEX 投影同步 projectSlug,scope='general' 时为空串 */
  projectSlug: string
  /** v2.18.0 INDEX 投影同步 hitCount,便于按踩坑频次排序 */
  hitCount: number
}

export interface LessonsIndexFile {
  version: number
  updatedAt: string
  lessons: LessonIndexEntry[]
}

/** 写入 / 更新一条经验所需的最少字段,id/createdAt/source 由 store 端兜底生成 */
export interface WriteLessonInput {
  id?: string
  jiraKey: string
  jiraTitle?: string
  type: LessonType
  title: string
  content: string
  rootCause?: string
  fix?: string
  reusableWhen?: string
  tags?: string[]
  affectedFiles?: string[]
  iterationSeqs?: number[]
  trust?: LessonTrust
  createdAt?: string
  source?: Partial<LessonSource>
  /** v2.17.0 缺省 → 'project' */
  scope?: LessonScope
  /** v2.17.0 scope='project' 且缺省时,由 store 端按 jiraKey 反查 requirement.projectSlug 兜底 */
  projectSlug?: string
}

export interface WriteLessonsResult {
  saved: StoredLesson[]
  /** 重复 id 被覆盖的条目 id 列表 */
  replaced: string[]
  /** 输入字段不合法被拒收的条目下标(从 0 开始) */
  rejected: Array<{ index: number; reason: string }>
}

/**
 * v2.18.0 bundle 头部客观信号摘要,供 LLM 推理时优先扫"难点 / churn / 异常"。
 *
 * - boost / linkedBugCount: 来自 computeMetrics(实时算,反映当前需求的价值密度)
 * - cumulativeEffectiveTokens / cumulativeThinkSeconds: 整需求维度累计
 * - fileChurnMap: 按"被触碰轮数 + 累计 +/-"排序的 top 5 文件,LLM 可作 pitfall 候选
 * - abnormalStopReasons: 出现非正常 stop_reason 的轮次集合
 * - topThinkSeqs: 思考时长 top 3 轮次的 seq,LLM 优先扫这部分(大概率是难点)
 */
export interface BundleComputedSignals {
  boost: number | null
  linkedBugCount: number | null
  cumulativeEffectiveTokens: number
  cumulativeThinkSeconds: number
  fileChurnMap: Array<{
    path: string
    insertions: number
    deletions: number
    touchedSeqs: number[]
  }>
  abnormalStopReasons: Array<{ reason: string; seqs: number[] }>
  topThinkSeqs: number[]
}

export interface LessonsBundle {
  jiraKey: string
  /**
   * v2.17.0 当前需求所属项目标识(来自 requirement.projectSlug,即 package.json name)。
   * LLM 在生成 scope='project' 的 lesson 时应据此填 projectSlug,从而让经验
   * 后续可被同项目其他需求复用;若 requirement 缺失或 projectSlug 为空,返回空串。
   */
  currentProjectSlug: string
  requirement: StoredRequirement | null
  iterations: StoredIteration[]
  /**
   * v2.17.0 已过滤为「通用 + 当前项目」的存量经验,避免 LLM 去重视野跨项目污染。
   * 当 currentProjectSlug 为空时退化为「同 jiraKey existing + 全部通用」,
   * 保证老数据(无 projectSlug)场景下不被错误隐藏。
   */
  existingLessons: StoredLesson[]
  /** v2.18.0 客观信号摘要,供 LLM 推理时引用 */
  computedSignals: BundleComputedSignals
}

const DEFAULT_TRUST: LessonTrust = 'high'

function emptyIndex(): LessonsIndexFile {
  return { version: 1, updatedAt: new Date().toISOString(), lessons: [] }
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

function normalizeScope(input: unknown): LessonScope {
  if (input === 'general' || input === 'project') return input
  return ''
}

function normalizeStringArray(input: unknown, limit?: number): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const item of input) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (s) out.push(s)
    if (limit !== undefined && out.length >= limit) break
  }
  return out
}

function normalizeJiraKeyArray(input: unknown, limit = 64): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  for (const item of input) {
    const s = typeof item === 'string' ? item.trim().toUpperCase() : ''
    if (s) seen.add(s)
    if (seen.size >= limit) break
  }
  return Array.from(seen)
}

function normalizeSignals(input: unknown): LessonSignals | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Record<string, unknown>
  const churnRaw = r.sourceMaxChurnFile as Record<string, unknown> | null | undefined
  return {
    sourceBoost:
      typeof r.sourceBoost === 'number' && Number.isFinite(r.sourceBoost) ? r.sourceBoost : null,
    sourceLinkedBugCount:
      typeof r.sourceLinkedBugCount === 'number' && Number.isFinite(r.sourceLinkedBugCount)
        ? r.sourceLinkedBugCount
        : null,
    sourceEffectiveTokens:
      typeof r.sourceEffectiveTokens === 'number' && Number.isFinite(r.sourceEffectiveTokens)
        ? r.sourceEffectiveTokens
        : null,
    sourceThinkSeconds:
      typeof r.sourceThinkSeconds === 'number' && Number.isFinite(r.sourceThinkSeconds)
        ? r.sourceThinkSeconds
        : null,
    sourceAbnormalStopReasons: normalizeStringArray(r.sourceAbnormalStopReasons, 16),
    sourceMaxChurnFile:
      churnRaw && typeof churnRaw === 'object' && typeof churnRaw.path === 'string' && churnRaw.path
        ? {
            path: String(churnRaw.path),
            touchCount: typeof churnRaw.touchCount === 'number' ? churnRaw.touchCount : 0,
            insertions: typeof churnRaw.insertions === 'number' ? churnRaw.insertions : 0,
            deletions: typeof churnRaw.deletions === 'number' ? churnRaw.deletions : 0
          }
        : null
  }
}

export function readLessonsIndex(root?: string): LessonsIndexFile {
  const file = lessonsIndexPath(root)
  if (!existsSync(file)) return emptyIndex()
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LessonsIndexFile>
    if (!parsed || !Array.isArray(parsed.lessons)) return emptyIndex()
    return {
      version: parsed.version ?? 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      lessons: parsed.lessons
        .filter((row) => row && typeof row === 'object')
        .map((row) => {
          const r = row as unknown as Record<string, unknown>
          const hitCountRaw = r.hitCount
          return {
            id: String(row.id ?? ''),
            jiraKey: String(row.jiraKey ?? ''),
            type: (LESSON_TYPES as readonly string[]).includes(String(row.type))
              ? (row.type as LessonType)
              : 'rule',
            title: String(row.title ?? ''),
            tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)).filter(Boolean) : [],
            trust: row.trust === 'low' || row.trust === 'medium' ? row.trust : 'high',
            createdAt: String(row.createdAt ?? ''),
            scope: normalizeScope(r.scope),
            projectSlug: typeof r.projectSlug === 'string' ? r.projectSlug : '',
            hitCount:
              typeof hitCountRaw === 'number' && Number.isInteger(hitCountRaw) && hitCountRaw > 0
                ? hitCountRaw
                : 1
          }
        })
    }
  } catch {
    return emptyIndex()
  }
}

function toIndexEntry(lesson: StoredLesson): LessonIndexEntry {
  return {
    id: lesson.id,
    jiraKey: lesson.jiraKey,
    type: lesson.type,
    title: lesson.title,
    tags: [...lesson.tags],
    trust: lesson.trust,
    createdAt: lesson.createdAt,
    scope: lesson.scope,
    projectSlug: lesson.projectSlug,
    hitCount: lesson.hitCount
  }
}

function rewriteIndex(root: string | undefined, items: StoredLesson[]): void {
  ensureLessonsDir(root)
  const next: LessonsIndexFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    lessons: items
      .map(toIndexEntry)
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
  }
  writeAtomic(lessonsIndexPath(root), next)
}

export function loadLesson(id: string, root?: string): StoredLesson | null {
  if (!isValidLessonId(id)) return null
  const file = lessonFilePath(id, root)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredLesson> &
      Record<string, unknown>
    // v2.17.0 老 lesson 文件缺 scope/projectSlug 时兜底空串(前端展示「未分类」),
    // 不主动迁移以保留"用户选择 keep_legacy"语义。
    // v2.18.0 老 lesson 缺 signals/seenInJiraKeys/hitCount/trustReasons 时兜底初值,
    // 不重算 signals(避免读取旁路触发计算副作用),由下次 writeLessons 合并路径自然填充。
    const seenInJiraKeys = normalizeJiraKeyArray(raw.seenInJiraKeys)
    const fallbackSeen =
      seenInJiraKeys.length > 0 ? seenInJiraKeys : raw.jiraKey ? [String(raw.jiraKey)] : []
    const hitCountRaw = (raw as { hitCount?: unknown }).hitCount
    const hitCount =
      typeof hitCountRaw === 'number' && Number.isInteger(hitCountRaw) && hitCountRaw > 0
        ? hitCountRaw
        : Math.max(fallbackSeen.length, 1)
    return {
      ...(raw as StoredLesson),
      scope: normalizeScope(raw.scope),
      projectSlug: typeof raw.projectSlug === 'string' ? raw.projectSlug : '',
      signals: normalizeSignals(raw.signals),
      seenInJiraKeys: fallbackSeen,
      hitCount,
      trustReasons: normalizeStringArray((raw as { trustReasons?: unknown }).trustReasons, 16)
    }
  } catch {
    return null
  }
}

export interface ListLessonsOptions {
  jiraKey?: string
  type?: LessonType
  tag?: string
  q?: string
  /** v2.17.0 'general' 仅返回通用;'project' 仅返回项目专属;'unscoped' 仅返回老数据(scope='') */
  scope?: 'general' | 'project' | 'unscoped'
  /** v2.17.0 精确匹配 projectSlug;通常配合 scope='project' 使用 */
  projectSlug?: string
}

export function listLessons(options: ListLessonsOptions = {}, root?: string): LessonIndexEntry[] {
  const idx = readLessonsIndex(root)
  const { jiraKey, type, tag, q, scope, projectSlug } = options
  const tagLower = tag?.toLowerCase()
  const qLower = q?.toLowerCase()
  return idx.lessons.filter((row) => {
    if (jiraKey && row.jiraKey !== jiraKey) return false
    if (type && row.type !== type) return false
    if (tagLower && !row.tags.some((t) => t.toLowerCase() === tagLower)) return false
    if (
      qLower &&
      !(row.title.toLowerCase().includes(qLower) || row.jiraKey.toLowerCase().includes(qLower))
    )
      return false
    if (scope === 'general' && row.scope !== 'general') return false
    if (scope === 'project' && row.scope !== 'project') return false
    if (scope === 'unscoped' && row.scope !== '') return false
    if (projectSlug && row.projectSlug !== projectSlug) return false
    return true
  })
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function generateLessonId(jiraKey: string): string {
  const safeKey = String(jiraKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 60)
  if (!safeKey) throw new Error('jiraKey 不能为空')
  return `lsn-${safeKey}-${randomSuffix()}`
}

function normalizeWriteInput(
  input: WriteLessonInput,
  defaults: { source: LessonSource; jiraTitle: string; projectSlug: string }
): { ok: true; lesson: StoredLesson } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: '缺少 lesson 对象' }
  if (!input.jiraKey || typeof input.jiraKey !== 'string')
    return { ok: false, reason: 'jiraKey 必填' }
  if (!input.type || !(LESSON_TYPES as readonly string[]).includes(input.type))
    return { ok: false, reason: `type 必须是 ${LESSON_TYPES.join('/')}` }
  if (!input.title || typeof input.title !== 'string') return { ok: false, reason: 'title 必填' }
  if (!input.content || typeof input.content !== 'string')
    return { ok: false, reason: 'content 必填' }

  const id = input.id && isValidLessonId(input.id) ? input.id : generateLessonId(input.jiraKey)
  const createdAt = input.createdAt ?? new Date().toISOString()

  // v2.17.0 scope 兜底:缺/非法 → 'project'(保守,避免把项目专属经验错挂到通用)
  const rawScope = input.scope
  const scope: LessonScope = rawScope === 'general' || rawScope === 'project' ? rawScope : 'project'

  // projectSlug 兜底:scope='general' 时强制清空;scope='project' 时优先显式入参,
  // 缺省时落 defaults.projectSlug(由 writeLessons 按 jiraKey 反查 requirement.projectSlug 注入),
  // 仍为空时落空串(显式分类为「未分类」可见)。
  let projectSlug = ''
  if (scope === 'project') {
    const explicit = typeof input.projectSlug === 'string' ? input.projectSlug.trim() : ''
    projectSlug = explicit || defaults.projectSlug || ''
  }

  const lesson: StoredLesson = {
    id,
    jiraKey: input.jiraKey,
    jiraTitle: input.jiraTitle ?? defaults.jiraTitle,
    type: input.type,
    title: input.title.trim().slice(0, 200),
    content: input.content.trim().slice(0, 4000),
    rootCause: input.rootCause?.trim() || undefined,
    fix: input.fix?.trim() || undefined,
    reusableWhen: input.reusableWhen?.trim() || undefined,
    tags: Array.isArray(input.tags)
      ? Array.from(new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))).slice(0, 16)
      : [],
    affectedFiles: Array.isArray(input.affectedFiles)
      ? input.affectedFiles
          .map((f) => String(f).trim())
          .filter(Boolean)
          .slice(0, 32)
      : undefined,
    iterationSeqs: Array.isArray(input.iterationSeqs)
      ? input.iterationSeqs
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 64)
      : undefined,
    trust: input.trust === 'low' || input.trust === 'medium' ? input.trust : DEFAULT_TRUST,
    createdAt,
    source: {
      extractedBy: input.source?.extractedBy ?? defaults.source.extractedBy,
      extractedAt: input.source?.extractedAt ?? defaults.source.extractedAt
    },
    scope,
    projectSlug,
    // v2.18.0 新字段:writeLessons 后续会覆盖 signals/seenInJiraKeys/hitCount/trustReasons,
    // 这里只是给 normalizeWriteInput 失败旁路一份合法默认值。
    signals: null,
    seenInJiraKeys: [input.jiraKey],
    hitCount: 1,
    trustReasons: []
  }
  return { ok: true, lesson }
}

export interface WriteLessonsContext {
  /** v 2.16.0 默认 manual,由 MCP 端传 cursor / claude-code */
  extractedBy?: LessonExtractedBy
  extractedAt?: string
  /** 当 input.jiraTitle 缺失时,从 requirement.json 兜底拉取 */
  jiraTitleFallback?: string
}

// ============== v2.18.0 信号化纯函数 ==============

/** 经验合并相似度阈值(供外部测试 / 调参) */
export const LESSON_MERGE_THRESHOLDS = {
  /** type+scope+projectSlug 必须完全相等;tagsJaccard 至少达到此值才进入下一道闸 */
  tagsJaccardMin: 0.5,
  /** title 相似度 ≥ 此值视为"同款"(双闸的一条;另一条是 affectedFiles 交集 ≥ 1) */
  titleSimilarityMin: 0.8
}

/** 非正常 stopReason 集合(出现即视为"AI 被打断 / 异常结束") */
export const ABNORMAL_STOP_REASONS: readonly string[] = [
  'max_tokens',
  'pause_turn',
  'tool_use',
  'stale_timeout'
]

/**
 * 计算两个 tag 数组的 Jaccard 系数(intersection / union),大小写不敏感。
 * 空集合两端均空 → 1.0(等价);任一端空、另一端非空 → 0.0。
 */
export function tagsJaccard(a: string[] | undefined, b: string[] | undefined): number {
  const aSet = new Set((a ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))
  const bSet = new Set((b ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))
  if (aSet.size === 0 && bSet.size === 0) return 1
  if (aSet.size === 0 || bSet.size === 0) return 0
  let inter = 0
  for (const v of aSet) if (bSet.has(v)) inter += 1
  const union = aSet.size + bSet.size - inter
  return union === 0 ? 0 : inter / union
}

function tokenizeTitle(s: string): string[] {
  // 中英文混排:中文按字、英文按 word 切分,统一小写;过滤过短 token
  const lower = (s ?? '').trim().toLowerCase()
  if (!lower) return []
  const tokens: string[] = []
  let buf = ''
  for (const ch of lower) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      tokens.push(ch)
    } else if (/[a-z0-9]/.test(ch)) {
      buf += ch
    } else {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
    }
  }
  if (buf) tokens.push(buf)
  return tokens
}

/**
 * 标题相似度,基于 token 集合的 Dice 系数(2 * inter / (|A| + |B|))。
 * 两端均空 → 1.0;任一端空 → 0.0。无外部依赖,中英文混排足够稳。
 */
export function titleSimilarity(a: string, b: string): number {
  const at = new Set(tokenizeTitle(a))
  const bt = new Set(tokenizeTitle(b))
  if (at.size === 0 && bt.size === 0) return 1
  if (at.size === 0 || bt.size === 0) return 0
  let inter = 0
  for (const v of at) if (bt.has(v)) inter += 1
  return (2 * inter) / (at.size + bt.size)
}

function affectedFilesIntersect(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const aSet = new Set(a.map((s) => s.trim()).filter(Boolean))
  for (const f of b) {
    if (aSet.has((f ?? '').trim())) return true
  }
  return false
}

/**
 * 在已存在的 lesson 列表里找一条"语义同款"的候选,作为合并目标。
 *
 * 命中规则(全部满足):
 *  1. type / scope / projectSlug 完全相等
 *  2. tagsJaccard ≥ LESSON_MERGE_THRESHOLDS.tagsJaccardMin
 *  3. 标题相似度 ≥ LESSON_MERGE_THRESHOLDS.titleSimilarityMin 或 affectedFiles 有交集
 *
 * 候选按 createdAt 倒序扫描,首个命中即返回;同一 id 的候选(LLM 显式覆盖路径)直接跳过,
 * 让既有 v2.16.x 同 id 覆盖语义不被合并路径接管。
 */
export function findMergeCandidate(
  existing: StoredLesson[],
  target: StoredLesson
): StoredLesson | null {
  const ordered = [...existing].sort((a, b) =>
    a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0
  )
  for (const cand of ordered) {
    if (cand.id === target.id) continue
    if (cand.type !== target.type) continue
    if (cand.scope !== target.scope) continue
    if (cand.projectSlug !== target.projectSlug) continue
    if (tagsJaccard(cand.tags, target.tags) < LESSON_MERGE_THRESHOLDS.tagsJaccardMin) continue
    const titleHit =
      titleSimilarity(cand.title, target.title) >= LESSON_MERGE_THRESHOLDS.titleSimilarityMin
    const filesHit = affectedFilesIntersect(cand.affectedFiles, target.affectedFiles)
    if (!titleHit && !filesHit) continue
    return cand
  }
  return null
}

export interface ComputeSignalsDeps {
  loadRequirement?: typeof loadRequirement
  listIterations?: typeof listIterations
  loadRawPayload?: typeof loadRawPayload
  readFormula?: typeof readFormula
}

function extractStopReason(
  jiraKey: string,
  iter: StoredIteration,
  root: string | undefined,
  deps: ComputeSignalsDeps
): string | null {
  if (!iter.rawPayloadFile) return null
  const loader = deps.loadRawPayload ?? loadRawPayload
  const raw = loader(jiraKey, iter.rawPayloadFile, root)
  if (!raw || typeof raw !== 'object') return null
  const candidates: unknown[] = [
    (raw as Record<string, unknown>).triggerStopReason,
    (raw as Record<string, unknown>).stopReason,
    (raw as Record<string, unknown>).stop_reason
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/**
 * 基于 jiraKey + 引用 iterationSeqs 计算客观信号快照。
 *
 * - boost / linkedBugCount: 来自 computeMetrics(实时算,反映落盘那一刻的需求价值密度)
 * - effectiveTokens / thinkSeconds: 引用 iterations 累加(若 iterationSeqs 为空,fallback 累计全需求)
 * - abnormalStopReasons: 引用 iterations 的 rawPayload.triggerStopReason 集合,
 *                       命中 ABNORMAL_STOP_REASONS 的进入信号
 * - sourceMaxChurnFile: 引用 iterations 中 changedFiles 出现次数最多的文件,
 *                       insertions/deletions 来自 iteration.diffInsertions/Deletions 平均到所有文件的近似;
 *                       更准的 +/- 走 cumulative numstat snapshot 时再升级,本期不引入
 */
export function computeSignals(
  jiraKey: string,
  iterationSeqs: number[] | undefined,
  root?: string,
  deps: ComputeSignalsDeps = {}
): LessonSignals {
  const loadReq = deps.loadRequirement ?? loadRequirement
  const listIter = deps.listIterations ?? listIterations
  const formulaReader = deps.readFormula ?? readFormula

  const requirement = loadReq(jiraKey, root)
  const allIterations = listIter(jiraKey, root)
  const seqSet = new Set(
    Array.isArray(iterationSeqs) ? iterationSeqs.filter((n) => Number.isInteger(n) && n > 0) : []
  )
  const sourceIterations: StoredIteration[] =
    seqSet.size > 0 ? allIterations.filter((it) => seqSet.has(it.seq)) : allIterations

  let sourceBoost: number | null = null
  let sourceLinkedBugCount: number | null = null
  if (requirement) {
    const formula: FormulaSettings = (() => {
      try {
        return formulaReader(root)
      } catch {
        return { ...DEFAULT_FORMULA }
      }
    })()
    const metrics = computeMetrics({
      manualEstimateMinutes: requirement.manualEstimateMinutes,
      iterations: allIterations,
      subtasks: Array.isArray(requirement.subtasks) ? requirement.subtasks : [],
      linkedBugCount: requirement.linkedBugCount,
      formula
    })
    sourceBoost = metrics.boost
    sourceLinkedBugCount = requirement.bugsRefreshedAt ? requirement.linkedBugCount : null
  }

  const sourceEffectiveTokens = sourceIterations.reduce((s, it) => s + (it.cumulativeToken || 0), 0)
  const sourceThinkSeconds = sourceIterations.reduce((s, it) => s + (it.thinkSeconds || 0), 0)

  const abnormalSet = new Set<string>()
  for (const it of sourceIterations) {
    const reason = extractStopReason(jiraKey, it, root, deps)
    if (reason && (ABNORMAL_STOP_REASONS as readonly string[]).includes(reason))
      abnormalSet.add(reason)
  }

  // 文件 churn 统计:per path { touchCount, insertions, deletions }
  // insertions/deletions 按"该 iteration 总 +/- 平均到 changedFiles 数"做近似分摊
  const churn = new Map<string, { touchCount: number; insertions: number; deletions: number }>()
  for (const it of sourceIterations) {
    const files = Array.isArray(it.changedFiles) ? it.changedFiles : []
    if (!files.length) continue
    const perFileIns = files.length > 0 ? Math.round((it.diffInsertions || 0) / files.length) : 0
    const perFileDel = files.length > 0 ? Math.round((it.diffDeletions || 0) / files.length) : 0
    for (const f of files) {
      const path = (f.path ?? '').trim()
      if (!path) continue
      const prev = churn.get(path) ?? { touchCount: 0, insertions: 0, deletions: 0 }
      prev.touchCount += 1
      prev.insertions += perFileIns
      prev.deletions += perFileDel
      churn.set(path, prev)
    }
  }
  let maxChurn: { path: string; touchCount: number; insertions: number; deletions: number } | null =
    null
  for (const [path, v] of churn.entries()) {
    if (!maxChurn || v.touchCount > maxChurn.touchCount) {
      maxChurn = {
        path,
        touchCount: v.touchCount,
        insertions: v.insertions,
        deletions: v.deletions
      }
    }
  }

  return {
    sourceBoost,
    sourceLinkedBugCount,
    sourceEffectiveTokens: sourceEffectiveTokens > 0 ? sourceEffectiveTokens : null,
    sourceThinkSeconds: sourceThinkSeconds > 0 ? sourceThinkSeconds : null,
    sourceAbnormalStopReasons: Array.from(abnormalSet),
    sourceMaxChurnFile: maxChurn
  }
}

/**
 * v2.15.0 per-turn 经验沉淀:单轮"强候选"思考时长阈值(秒)。
 *
 * 单轮 thinkSeconds ≥ 此值视为"AI 在这一轮想得特别久 / 卡壳",大概率是难点或决策点,
 * 配合 abnormalStopReasons 一起作为 stop hook 兜底是否提示"本轮可能有可沉淀经验"的客观依据。
 * 导出常量便于测试断言与未来调参。
 */
export const STRONG_THINK_SECONDS = 180

export interface StrongCandidateResult {
  hit: boolean
  /** 命中原因(人类可读,供 daemon 端点 / 兜底文案引用),未命中为空数组 */
  reasons: string[]
}

/**
 * v2.15.0 判定**单个 iteration**是否为"强候选经验轮"。
 *
 * 复用 computeSignals(jiraKey, [seq]) 的 per-iteration 信号,只看两个**单轮可判**的客观信号:
 *   - sourceAbnormalStopReasons 非空(本轮被 max_tokens / pause_turn / tool_use / stale_timeout 打断)
 *   - sourceThinkSeconds ≥ STRONG_THINK_SECONDS(本轮思考特别久)
 *
 * 刻意**不**看 churn:churn 是跨轮信号(同文件被反复改),在单轮 seq 上意义弱,
 * churn / 反复 bugfix 类候选完全交给 skill 内联主路径由 LLM 从实时上下文自评(详见实现计划风险 3)。
 *
 * 任何读取异常一律视为未命中(daemon 端调用方 fail-open,不阻塞主流程)。
 */
export function isStrongCandidateIteration(
  jiraKey: string,
  seq: number,
  root?: string,
  deps: ComputeSignalsDeps = {}
): StrongCandidateResult {
  if (!Number.isInteger(seq) || seq <= 0) return { hit: false, reasons: [] }
  try {
    const signals = computeSignals(jiraKey, [seq], root, deps)
    const reasons: string[] = []
    if (signals.sourceAbnormalStopReasons.length > 0) {
      reasons.push(`本轮异常中断: ${signals.sourceAbnormalStopReasons.join(',')}`)
    }
    if ((signals.sourceThinkSeconds ?? 0) >= STRONG_THINK_SECONDS) {
      reasons.push(
        `本轮思考时长 ${Math.round(signals.sourceThinkSeconds ?? 0)}s ≥ ${STRONG_THINK_SECONDS}s`
      )
    }
    return { hit: reasons.length > 0, reasons }
  } catch {
    return { hit: false, reasons: [] }
  }
}

/**
 * 合并新老 signals:同款经验跨需求再出现时,各信号单调演进。
 *
 * - boost 取较高(更高效的复用证据更值钱)
 * - linkedBugCount 取较新一方(后续刷新会覆盖;新一方未知时保留老)
 * - effectiveTokens / thinkSeconds 累加(代表"为这条经验我们一共花了多少")
 * - stopReasons union
 * - maxChurnFile 取 touchCount 更大的一方
 */
export function mergeSignals(prev: LessonSignals | null, next: LessonSignals): LessonSignals {
  if (!prev) return next
  const pickNumberMax = (a: number | null, b: number | null) => {
    if (a == null && b == null) return null
    if (a == null) return b
    if (b == null) return a
    return Math.max(a, b)
  }
  const sumNullable = (a: number | null, b: number | null) => {
    if (a == null && b == null) return null
    return (a ?? 0) + (b ?? 0)
  }
  return {
    sourceBoost: pickNumberMax(prev.sourceBoost, next.sourceBoost),
    sourceLinkedBugCount:
      next.sourceLinkedBugCount != null ? next.sourceLinkedBugCount : prev.sourceLinkedBugCount,
    sourceEffectiveTokens: sumNullable(prev.sourceEffectiveTokens, next.sourceEffectiveTokens),
    sourceThinkSeconds: sumNullable(prev.sourceThinkSeconds, next.sourceThinkSeconds),
    sourceAbnormalStopReasons: Array.from(
      new Set([
        ...(prev.sourceAbnormalStopReasons ?? []),
        ...(next.sourceAbnormalStopReasons ?? [])
      ])
    ),
    sourceMaxChurnFile:
      !prev.sourceMaxChurnFile && !next.sourceMaxChurnFile
        ? null
        : !prev.sourceMaxChurnFile
          ? next.sourceMaxChurnFile
          : !next.sourceMaxChurnFile
            ? prev.sourceMaxChurnFile
            : prev.sourceMaxChurnFile.touchCount >= next.sourceMaxChurnFile.touchCount
              ? prev.sourceMaxChurnFile
              : next.sourceMaxChurnFile
  }
}

function formatThink(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.round(sec / 60)
  return `${m}min`
}

function formatTokens(n: number | null): string {
  if (n == null || n <= 0) return ''
  if (n < 1_000) return `${n}`
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * 由 signals + hitCount 渲染人类可读证据数组,看板列表 / 抽屉直接消费。
 * 输出风格固定,顺序: boost → bug → tokens/think → churn → 异常 stop → 同款踩了 N 次。
 */
export function recomputeTrustReasons(signals: LessonSignals | null, hitCount: number): string[] {
  const out: string[] = []
  if (!signals) {
    if (hitCount >= 2) out.push(`同款踩了 ${hitCount} 次`)
    return out
  }
  if (signals.sourceBoost != null) {
    if (signals.sourceBoost >= 5) out.push(`boost=${signals.sourceBoost.toFixed(1)}x (高效需求)`)
    else if (signals.sourceBoost < 1)
      out.push(`boost=${signals.sourceBoost.toFixed(1)}x (低效需求)`)
    else out.push(`boost=${signals.sourceBoost.toFixed(1)}x`)
  }
  if (signals.sourceLinkedBugCount != null) {
    if (signals.sourceLinkedBugCount === 0) out.push('bug=0 (无回归)')
    else out.push(`bug=${signals.sourceLinkedBugCount}`)
  }
  const tokens = formatTokens(signals.sourceEffectiveTokens)
  const think = formatThink(signals.sourceThinkSeconds)
  if (tokens || think) {
    const parts: string[] = []
    if (tokens) parts.push(`tokens=${tokens}`)
    if (think) parts.push(`think=${think}`)
    out.push(parts.join(' / '))
  }
  if (signals.sourceMaxChurnFile && signals.sourceMaxChurnFile.touchCount >= 2) {
    const { path, touchCount, insertions, deletions } = signals.sourceMaxChurnFile
    const churnDetail = insertions + deletions > 0 ? ` +${insertions} -${deletions}` : ''
    out.push(`churn 最大 ${path} (${touchCount}轮${churnDetail})`)
  }
  if (signals.sourceAbnormalStopReasons.length > 0) {
    out.push(`异常 stop: ${signals.sourceAbnormalStopReasons.join(',')}`)
  }
  if (hitCount >= 2) out.push(`同款踩了 ${hitCount} 次`)
  return out
}

// ============== /v2.18.0 信号化纯函数 ==============

/**
 * 批量落盘多条经验。v2.18.0 起带「相似 lesson 自动合并」路径。
 *
 * 流程:
 *  1. 校验每条字段 → 不合法的纳入 rejected
 *  2. 已显式带合法 id 且同名文件已存在 → 走"覆盖式更新"老路径(保留 v2.16.x 语义)
 *  3. 否则查 findMergeCandidate:命中老 lesson 且新 jiraKey 未登记过 → 合并路径
 *     - seenInJiraKeys ∪= [newJiraKey],hitCount = length
 *     - signals = mergeSignals(prev, computeSignals(new))
 *     - trustReasons = recomputeTrustReasons(signals, hitCount)
 *     - content / fix / reusableWhen 不自动覆盖(避免破坏 LLM 既有沉淀)
 *  4. 未命中合并候选 → 新建路径,落盘 + 初算 signals/trustReasons,seenInJiraKeys=[jiraKey]
 *  5. 最后扫盘重建 INDEX 保单源真值
 */
export function writeLessons(
  inputs: WriteLessonInput[],
  ctx: WriteLessonsContext = {},
  root?: string
): WriteLessonsResult {
  ensureLessonsDir(root)
  const now = new Date().toISOString()
  const defaults: { source: LessonSource; jiraTitle: string; projectSlug: string } = {
    source: { extractedBy: ctx.extractedBy ?? 'manual', extractedAt: ctx.extractedAt ?? now },
    jiraTitle: ctx.jiraTitleFallback ?? '',
    projectSlug: ''
  }

  const result: WriteLessonsResult = { saved: [], replaced: [], rejected: [] }
  const existingIds = new Set<string>()
  for (const f of safeReadDir(lessonsDir(root))) {
    if (f.endsWith('.json') && f !== 'INDEX.json') existingIds.add(f.slice(0, -5))
  }

  // v2.17.0 同一批 jiraKey 出现多次时缓存 requirement,避免重复磁盘读
  const requirementCache = new Map<string, ReturnType<typeof loadRequirement>>()
  const lookupRequirement = (jiraKey: string) => {
    if (!requirementCache.has(jiraKey)) {
      requirementCache.set(jiraKey, loadRequirement(jiraKey, root))
    }
    return requirementCache.get(jiraKey) ?? null
  }

  // v2.18.0 合并候选池:首轮初始化为磁盘扫描结果,后续每写一条同步更新
  // (本批次内多条相同 lesson 也能正确合并到第一条)
  const mergePool: StoredLesson[] = scanLessonsFromDisk(root)
  const upsertPool = (lesson: StoredLesson) => {
    const idx = mergePool.findIndex((l) => l.id === lesson.id)
    if (idx >= 0) mergePool[idx] = lesson
    else mergePool.push(lesson)
  }

  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i]
    let perJiraTitle = defaults.jiraTitle
    let perProjectSlug = defaults.projectSlug
    if (raw && typeof raw === 'object' && raw.jiraKey) {
      const req =
        (!raw.jiraTitle && !perJiraTitle) || (raw.scope !== 'general' && !raw.projectSlug?.trim())
          ? lookupRequirement(raw.jiraKey)
          : null
      if (req?.title && !raw.jiraTitle && !perJiraTitle) perJiraTitle = req.title
      if (req?.projectSlug) perProjectSlug = req.projectSlug
    }
    const normalized = normalizeWriteInput(raw, {
      source: defaults.source,
      jiraTitle: perJiraTitle,
      projectSlug: perProjectSlug
    })
    if (!normalized.ok) {
      result.rejected.push({ index: i, reason: normalized.reason })
      continue
    }
    const lesson = normalized.lesson

    // 老路径:LLM 显式带 id 命中老文件 → 视为"覆盖式更新",带上原 seenInJiraKeys 不丢
    if (raw.id && isValidLessonId(raw.id) && existingIds.has(raw.id)) {
      const prev = mergePool.find((l) => l.id === raw.id) ?? null
      const newSignals = computeSignals(lesson.jiraKey, lesson.iterationSeqs, root)
      const seenSet = new Set<string>([...(prev?.seenInJiraKeys ?? []), lesson.jiraKey])
      lesson.seenInJiraKeys = Array.from(seenSet)
      lesson.hitCount = lesson.seenInJiraKeys.length
      lesson.signals = mergeSignals(prev?.signals ?? null, newSignals)
      lesson.trustReasons = recomputeTrustReasons(lesson.signals, lesson.hitCount)
      result.replaced.push(lesson.id)
      writeAtomic(lessonFilePath(lesson.id, root), lesson)
      result.saved.push(lesson)
      upsertPool(lesson)
      continue
    }

    // v2.18.0 合并路径:查相似候选(同 type+scope+projectSlug + tags Jaccard + title/files)
    // 同 jiraKey 命中老条目时也走合并路径,但 seenInJiraKeys 不重复 push(避免计数夸大);
    // 不同 jiraKey 命中时把新 jiraKey 追加进 seenInJiraKeys,hitCount 同步增长。
    const candidate = findMergeCandidate(mergePool, lesson)
    if (candidate) {
      const newSignals = computeSignals(lesson.jiraKey, lesson.iterationSeqs, root)
      const merged: StoredLesson = {
        ...candidate,
        seenInJiraKeys: Array.from(new Set([...candidate.seenInJiraKeys, lesson.jiraKey])),
        signals: mergeSignals(candidate.signals, newSignals),
        // jiraTitle 保留老条目;tags 取并集(便于跨需求 tag 多源汇聚)
        tags: Array.from(new Set([...candidate.tags, ...lesson.tags])).slice(0, 16),
        // affectedFiles 取并集(同款经验可能在不同需求里影响不同文件)
        affectedFiles:
          candidate.affectedFiles || lesson.affectedFiles
            ? Array.from(
                new Set([...(candidate.affectedFiles ?? []), ...(lesson.affectedFiles ?? [])])
              ).slice(0, 32)
            : undefined
      }
      merged.hitCount = merged.seenInJiraKeys.length
      merged.trustReasons = recomputeTrustReasons(merged.signals, merged.hitCount)
      writeAtomic(lessonFilePath(merged.id, root), merged)
      result.replaced.push(merged.id)
      result.saved.push(merged)
      upsertPool(merged)
      continue
    }

    // 新建路径:首次记录该经验,初算 signals + trustReasons
    lesson.signals = computeSignals(lesson.jiraKey, lesson.iterationSeqs, root)
    lesson.seenInJiraKeys = [lesson.jiraKey]
    lesson.hitCount = 1
    lesson.trustReasons = recomputeTrustReasons(lesson.signals, 1)
    if (existingIds.has(lesson.id)) result.replaced.push(lesson.id)
    writeAtomic(lessonFilePath(lesson.id, root), lesson)
    result.saved.push(lesson)
    upsertPool(lesson)
  }

  // 重新生成 INDEX:扫描目录确保索引与磁盘一致(单源真值原则)
  rewriteIndex(root, scanLessonsFromDisk(root))
  return result
}

function safeReadDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function scanLessonsFromDisk(root?: string): StoredLesson[] {
  const out: StoredLesson[] = []
  for (const filename of safeReadDir(lessonsDir(root))) {
    if (!filename.endsWith('.json') || filename === 'INDEX.json') continue
    const id = filename.slice(0, -5)
    if (!isValidLessonId(id)) continue
    const lesson = loadLesson(id, root)
    if (lesson) out.push(lesson)
  }
  return out
}

export function removeLesson(id: string, root?: string): boolean {
  if (!isValidLessonId(id)) return false
  const file = lessonFilePath(id, root)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
  } catch {
    return false
  }
  rewriteIndex(root, scanLessonsFromDisk(root))
  return true
}

/**
 * v2.18.0 基于 jiraKey 全需求 iterations + requirement 计算 bundle 头部客观信号摘要。
 *
 * 用途:在 lessons-extract skill 推理之前给 LLM 一份"难点 / churn / 异常"高亮,
 * 让 LLM 优先扫这部分内容,提高经验质量。
 *
 * - boost / linkedBugCount: 来自 computeMetrics(基于实时公式 + 最新 manualEstimateMinutes)
 * - cumulativeEffectiveTokens / cumulativeThinkSeconds: 整需求维度累加
 * - fileChurnMap: 全需求 changedFiles 维度按"被触碰轮数"排序的 top 5
 * - abnormalStopReasons: 出现 ABNORMAL_STOP_REASONS 的轮次集合
 * - topThinkSeqs: 思考时长 top 3 的 seq
 */
export function buildComputedSignals(
  jiraKey: string,
  iterations: StoredIteration[],
  requirement: StoredRequirement | null,
  root?: string,
  deps: ComputeSignalsDeps = {}
): BundleComputedSignals {
  const formulaReader = deps.readFormula ?? readFormula
  let boost: number | null = null
  let linkedBugCount: number | null = null
  if (requirement) {
    const formula: FormulaSettings = (() => {
      try {
        return formulaReader(root)
      } catch {
        return { ...DEFAULT_FORMULA }
      }
    })()
    const metrics = computeMetrics({
      manualEstimateMinutes: requirement.manualEstimateMinutes,
      iterations,
      subtasks: Array.isArray(requirement.subtasks) ? requirement.subtasks : [],
      linkedBugCount: requirement.linkedBugCount,
      formula
    })
    boost = metrics.boost
    linkedBugCount = requirement.bugsRefreshedAt ? requirement.linkedBugCount : null
  }

  const cumulativeEffectiveTokens = iterations.reduce((s, it) => s + (it.cumulativeToken || 0), 0)
  const cumulativeThinkSeconds = iterations.reduce((s, it) => s + (it.thinkSeconds || 0), 0)

  // top 3 思考时长(过滤掉 thinkSeconds=0 的轮次,避免老数据塞进去)
  const topThinkSeqs = iterations
    .filter((it) => (it.thinkSeconds || 0) > 0)
    .slice()
    .sort((a, b) => (b.thinkSeconds || 0) - (a.thinkSeconds || 0))
    .slice(0, 3)
    .map((it) => it.seq)

  // 异常 stopReason 集合 + 涉及 seqs
  const abnormalMap = new Map<string, Set<number>>()
  for (const it of iterations) {
    const reason = extractStopReason(jiraKey, it, root, deps)
    if (reason && (ABNORMAL_STOP_REASONS as readonly string[]).includes(reason)) {
      const set = abnormalMap.get(reason) ?? new Set<number>()
      set.add(it.seq)
      abnormalMap.set(reason, set)
    }
  }
  const abnormalStopReasons = Array.from(abnormalMap.entries()).map(([reason, set]) => ({
    reason,
    seqs: Array.from(set).sort((a, b) => a - b)
  }))

  // 文件 churn:全需求维度按"被触碰轮数"排序 top 5
  // insertions/deletions 按 iteration 总 +/- 平均到 changedFiles 数做近似分摊
  const churn = new Map<
    string,
    { insertions: number; deletions: number; touchedSeqs: Set<number> }
  >()
  for (const it of iterations) {
    const files = Array.isArray(it.changedFiles) ? it.changedFiles : []
    if (!files.length) continue
    const perFileIns = files.length > 0 ? Math.round((it.diffInsertions || 0) / files.length) : 0
    const perFileDel = files.length > 0 ? Math.round((it.diffDeletions || 0) / files.length) : 0
    for (const f of files) {
      const path = (f.path ?? '').trim()
      if (!path) continue
      const prev = churn.get(path) ?? {
        insertions: 0,
        deletions: 0,
        touchedSeqs: new Set<number>()
      }
      prev.insertions += perFileIns
      prev.deletions += perFileDel
      prev.touchedSeqs.add(it.seq)
      churn.set(path, prev)
    }
  }
  const fileChurnMap = Array.from(churn.entries())
    .map(([path, v]) => ({
      path,
      insertions: v.insertions,
      deletions: v.deletions,
      touchedSeqs: Array.from(v.touchedSeqs).sort((a, b) => a - b)
    }))
    .sort((a, b) => {
      const ta = a.touchedSeqs.length
      const tb = b.touchedSeqs.length
      if (tb !== ta) return tb - ta
      return b.insertions + b.deletions - (a.insertions + a.deletions)
    })
    .slice(0, 5)

  return {
    boost,
    linkedBugCount,
    cumulativeEffectiveTokens,
    cumulativeThinkSeconds,
    fileChurnMap,
    abnormalStopReasons,
    topThinkSeqs
  }
}

/**
 * 组装一个 jiraKey 的「经验提取数据包」,作为 lessons-extract skill 的输入:
 * - requirement.json
 * - currentProjectSlug(LLM 标注 scope='project' 时用)
 * - 全部 iterations
 * - 已过滤的 existingLessons(用于 LLM 自检去重)
 * - v2.18.0 computedSignals(供 LLM 优先扫"难点 / churn / 异常")
 *
 * v2.17.0 existingLessons 过滤策略:
 *  - 当 currentProjectSlug 非空:返回「通用 + 当前项目」+「老数据(scope='') 且 jiraKey 命中」
 *    这样 LLM 同时看到跨项目通用经验和本项目历史经验,但不会被其他项目的 project 经验污染
 *  - 当 currentProjectSlug 为空(老 requirement 没存 projectSlug):
 *    退化为「全部通用 + 本 jiraKey 的所有 lessons」,保证老数据场景下不被错误隐藏
 */
export function buildLessonsBundle(jiraKey: string, root?: string): LessonsBundle {
  const requirement = loadRequirement(jiraKey, root)
  const currentProjectSlug = requirement?.projectSlug ?? ''
  const allLessons = scanLessonsFromDisk(root)
  const existingLessons = allLessons.filter((l) => {
    if (l.scope === 'general') return true
    if (currentProjectSlug && l.scope === 'project' && l.projectSlug === currentProjectSlug)
      return true
    // 兜底:无 projectSlug 的老数据 / requirement 缺 projectSlug 时,保留本 jiraKey 的历史经验避免漏看
    if (l.jiraKey === jiraKey) return true
    if (!currentProjectSlug && l.scope === '') return true
    return false
  })
  const iterations = listIterations(jiraKey, root)
  const computedSignals = buildComputedSignals(jiraKey, iterations, requirement, root)
  return {
    jiraKey,
    currentProjectSlug,
    requirement,
    iterations,
    existingLessons,
    computedSignals
  }
}
