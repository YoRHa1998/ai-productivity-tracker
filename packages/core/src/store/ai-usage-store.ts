/**
 * 「AI 整体用量」store —— 与需求维度正交的全局硬数据采集。
 *
 * 落盘单文件 `~/.ai-productivity-tracker/data/ai-usage.json`,按 `AI 工具 × 自然日`
 * 聚合,字段对齐 OpenTelemetry GenAI usage 语义约定(input/output/cache_read/
 * cache_creation),但用扁平 camelCase 适配前端。
 *
 * 设计要点(见 openspec/changes/add-ai-usage-overview/design.md):
 * - D1:独立单文件聚合,查询 O(1),不必扫各需求目录;tmp+rename 原子写。
 * - D2:三条采集链路(Claude / Codex / Cursor)各自把原生数据归一化成 `AiUsageEvent`
 *   再调 `recordUsage`,旁路插在各链路 issueKey 闸门之前,覆盖 main / 非仓库会话。
 * - D4:`sessions` 维度按当日 sessionId 去重得出 —— 落盘保留当日 distinct sessionId
 *   列表(随当日去重,数量级 = 当日会话数,极小),查询侧 `length` 即会话数;
 *   turns(对话次数)由 recordUsage 每次 +1,调用点幂等由上游保证(watcher offset /
 *   hook dedupeKey)。
 * - D5b:仅采结构化元数据(source/model/provider/token 细分/sessionId/时间戳),
 *   绝不入库对话正文。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { aiUsagePath } from './paths.js'
import { accumulateBenchmark, hasActiveBenchmark } from './usage-benchmark-store.js'

/** AI 用量维度键 —— 复用既有 IterationSource 的可采集子集(排除 'unknown')。 */
export type AiUsageSource = 'cursor' | 'claude-code' | 'codex'

/**
 * 归一化 token 细分(OTel GenAI usage 子集)。
 *
 * `total` 取「有效用量」口径(= input + output + cacheCreation,**剔除 cacheRead**),
 * 与 claude-message.effectiveTokens / hook parseHookTokens 一致,跨 AI 可横向比较。
 */
export interface AiUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 有效用量合计 = input + output + cacheCreation(不含 cacheRead) */
  total: number
}

/**
 * 归一化用量事件(OTel GenAI 子集)。三条链路把原生数据映射成它再 `recordUsage`。
 *
 * 仅结构化元数据,**不含任何对话正文 / 工具参数 / 模型输入输出大字段**。
 */
export interface AiUsageEvent {
  source: AiUsageSource
  /** 会话标识;用于按当日去重 sessions 维度 */
  sessionId: string
  /** 轮次标识(best-effort,可缺) */
  turnId?: string
  /** 模型名(best-effort,缺则不计入 models 细分) */
  model?: string
  /** provider(best-effort,缺则不计入 providers 细分) */
  provider?: string
  tokens: AiUsageTokens
  /** 工具调用次数(best-effort,缺则记 0) */
  toolCalls?: number
  /** 事件时间(ISO 字符串),决定落入哪个自然日桶 */
  at: string
}

/** 单个 (AI 工具, 自然日) 桶的持久化形态。 */
export interface AiUsageDailyBucket {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 有效用量合计(= 各事件 tokens.total 之和) */
  total: number
  /** 对话次数(每次 recordUsage +1) */
  turns: number
  /** 工具调用次数累加(best-effort) */
  toolCalls: number
  /**
   * 当日 distinct sessionId 列表(随事件去重)。
   * 不预存 `sessions` 数字 —— 查询侧 `length` 即会话数(D4「按当日 sessionId 重算去重」)。
   */
  sessionIds: string[]
  /** model 维度细分(best-effort) */
  models: Record<string, { total: number; turns: number }>
  /** provider 维度细分(best-effort) */
  providers: Record<string, { total: number }>
}

export interface AiUsageConfig {
  enabled: boolean
}

export interface AiUsageFile {
  version: number
  config: AiUsageConfig
  /** daily[source][YYYY-MM-DD] = bucket */
  daily: Record<string, Record<string, AiUsageDailyBucket>>
}

const AI_USAGE_SOURCES: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

function emptyFile(): AiUsageFile {
  return { version: 1, config: { enabled: false }, daily: {} }
}

/**
 * 进程内 `enabled` 缓存,按解析后的文件路径分桶(测试用不同 tmp root 时互不污染)。
 * recordUsage 据此零盘 I/O 短路;setAiUsageEnabled 写盘后刷新对应桶。
 */
const enabledCache = new Map<string, boolean>()

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function normalizeBucket(raw: unknown): AiUsageDailyBucket {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AiUsageDailyBucket>
  const models: Record<string, { total: number; turns: number }> = {}
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models as Record<string, unknown>)) {
      const mv = (v && typeof v === 'object' ? v : {}) as { total?: unknown; turns?: unknown }
      models[k] = { total: num(mv.total), turns: num(mv.turns) }
    }
  }
  const providers: Record<string, { total: number }> = {}
  if (r.providers && typeof r.providers === 'object') {
    for (const [k, v] of Object.entries(r.providers as Record<string, unknown>)) {
      const pv = (v && typeof v === 'object' ? v : {}) as { total?: unknown }
      providers[k] = { total: num(pv.total) }
    }
  }
  const sessionIds = Array.isArray(r.sessionIds)
    ? Array.from(new Set(r.sessionIds.filter((s): s is string => typeof s === 'string' && !!s)))
    : []
  return {
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheCreation: num(r.cacheCreation),
    total: num(r.total),
    turns: num(r.turns),
    toolCalls: num(r.toolCalls),
    sessionIds,
    models,
    providers
  }
}

export function readAiUsage(root?: string): AiUsageFile {
  const file = aiUsagePath(root)
  if (!existsSync(file)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AiUsageFile>
    const daily: AiUsageFile['daily'] = {}
    if (parsed.daily && typeof parsed.daily === 'object') {
      for (const [source, byDate] of Object.entries(parsed.daily)) {
        if (!byDate || typeof byDate !== 'object') continue
        const dateMap: Record<string, AiUsageDailyBucket> = {}
        for (const [date, bucket] of Object.entries(byDate as Record<string, unknown>)) {
          dateMap[date] = normalizeBucket(bucket)
        }
        daily[source] = dateMap
      }
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      config: { enabled: Boolean(parsed.config?.enabled) },
      daily
    }
  } catch {
    return emptyFile()
  }
}

function writeAiUsage(file: AiUsageFile, root?: string): void {
  const path = aiUsagePath(root)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

/** 本机时区自然日键 `YYYY-MM-DD`;at 非法时退化为「现在」。 */
export function localDateKey(at: string | Date): string {
  let d = typeof at === 'string' ? new Date(at) : at
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 读取采集开关(带进程内缓存)。缺文件 / 解析失败一律视为关闭(opt-in)。
 */
export function isAiUsageEnabled(root?: string): boolean {
  const key = aiUsagePath(root)
  const cached = enabledCache.get(key)
  if (cached !== undefined) return cached
  const enabled = readAiUsage(root).config.enabled
  enabledCache.set(key, enabled)
  return enabled
}

/**
 * 是否有任意「用量采集消费者」在工作 —— 整体用量监控开启,或有进行中的测算会话。
 *
 * 采集链路(watcher / hook 旁路)用它作闸门:任一为真即把事件送达 `recordUsage`,
 * `recordUsage` 内部再各自决定写 ai-usage.json(仅 enabled)与写测算(仅有 active 会话)。
 * 两个分支都读进程内布尔缓存,无消费者时与改造前等价短路(零盘 I/O)。
 */
export function isUsageCaptureActive(root?: string): boolean {
  return isAiUsageEnabled(root) || hasActiveBenchmark(root)
}

/**
 * 切换采集开关并持久化 + 刷新进程内缓存。返回最新 config。
 */
export function setAiUsageEnabled(enabled: boolean, root?: string): AiUsageConfig {
  const file = readAiUsage(root)
  file.config = { enabled }
  writeAiUsage(file, root)
  enabledCache.set(aiUsagePath(root), enabled)
  return { enabled }
}

function ensureBucket(file: AiUsageFile, source: string, date: string): AiUsageDailyBucket {
  let byDate = file.daily[source]
  if (!byDate) {
    byDate = {}
    file.daily[source] = byDate
  }
  let bucket = byDate[date]
  if (!bucket) {
    bucket = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      turns: 0,
      toolCalls: 0,
      sessionIds: [],
      models: {},
      providers: {}
    }
    byDate[date] = bucket
  }
  return bucket
}

/**
 * 记录一条归一化用量事件,按本机时区分日累加。
 *
 * - `enabled===false` 时整段短路(读进程内缓存,零盘 I/O)。
 * - turns 每次 +1;sessionId 去重进当日列表;token 细分 / models / providers 累加。
 * - 缺 model / provider 维度安全降级(跳过对应细分),不阻断主累加。
 *
 * 调用点幂等由上游保证:Claude/Codex watcher 的 offset state 防重读,Cursor hook 的
 * dedupeKey 防重复 POST —— 故同一真实事件不会被重复 record。
 */
export function recordUsage(event: AiUsageEvent, root?: string): void {
  if (!event || !AI_USAGE_SOURCES.includes(event.source)) return

  // 测算旁路(D2):无 active 会话时 accumulateBenchmark 自身零盘 I/O 短路;
  // 独立于整体用量开关,故放在 enabled 守卫之外。容错由调用点 try/catch 兜底。
  accumulateBenchmark(event, root)

  // 整体用量日聚合:语义不变,仅 enabled 时写 ai-usage.json。
  if (!isAiUsageEnabled(root)) return

  const file = readAiUsage(root)
  const date = localDateKey(event.at)
  const bucket = ensureBucket(file, event.source, date)

  const input = num(event.tokens?.input)
  const output = num(event.tokens?.output)
  const cacheRead = num(event.tokens?.cacheRead)
  const cacheCreation = num(event.tokens?.cacheCreation)
  const total = num(event.tokens?.total) || input + output + cacheCreation

  bucket.input += input
  bucket.output += output
  bucket.cacheRead += cacheRead
  bucket.cacheCreation += cacheCreation
  bucket.total += total
  bucket.turns += 1
  bucket.toolCalls += num(event.toolCalls)

  if (event.sessionId && !bucket.sessionIds.includes(event.sessionId)) {
    bucket.sessionIds.push(event.sessionId)
  }

  const model = typeof event.model === 'string' ? event.model.trim() : ''
  if (model) {
    const m = bucket.models[model] ?? { total: 0, turns: 0 }
    m.total += total
    m.turns += 1
    bucket.models[model] = m
  }

  const provider = typeof event.provider === 'string' ? event.provider.trim() : ''
  if (provider) {
    const p = bucket.providers[provider] ?? { total: 0 }
    p.total += total
    bucket.providers[provider] = p
  }

  writeAiUsage(file, root)
}

// ────────────────────────────────────────────────────────────────────
// 查询视图(供 HTTP 端点 / 看板消费)
// ────────────────────────────────────────────────────────────────────

/** 单日单 AI 的查询视图(展开 OTel 命名,sessions 在此重算去重得出)。 */
export interface AiUsageDailyView {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  turns: number
  /** = 当日 distinct sessionId 数量(查询侧重算) */
  sessions: number
  toolCalls: number
  models: Record<string, { totalTokens: number; turns: number }>
  providers: Record<string, { totalTokens: number }>
}

export interface AiUsageSeriesPoint {
  date: string
  /** source -> 当日视图;无数据的 source 不出现在该点 */
  [source: string]: AiUsageDailyView | string
}

export interface AiUsageView {
  enabled: boolean
  /** 今天各 AI 的用量视图(无数据返回零值视图) */
  today: Record<AiUsageSource, AiUsageDailyView>
  /** 近 days 天按日序列(升序),每点含各 source 的视图 */
  series: AiUsageSeriesPoint[]
}

function emptyDailyView(): AiUsageDailyView {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turns: 0,
    sessions: 0,
    toolCalls: 0,
    models: {},
    providers: {}
  }
}

function bucketToView(bucket: AiUsageDailyBucket): AiUsageDailyView {
  const models: Record<string, { totalTokens: number; turns: number }> = {}
  for (const [k, v] of Object.entries(bucket.models)) {
    models[k] = { totalTokens: v.total, turns: v.turns }
  }
  const providers: Record<string, { totalTokens: number }> = {}
  for (const [k, v] of Object.entries(bucket.providers)) {
    providers[k] = { totalTokens: v.total }
  }
  return {
    totalTokens: bucket.total,
    inputTokens: bucket.input,
    outputTokens: bucket.output,
    cacheReadTokens: bucket.cacheRead,
    cacheCreationTokens: bucket.cacheCreation,
    turns: bucket.turns,
    sessions: bucket.sessionIds.length,
    toolCalls: bucket.toolCalls,
    models,
    providers
  }
}

/**
 * 构造看板查询视图:今天各 AI 用量 + 近 days 天按日序列 + 开关状态。
 *
 * `now` 可注入测试;默认 `new Date()`。days 至少 1,最多 365。
 */
export function buildAiUsageView(
  file: AiUsageFile,
  days = 14,
  now: Date = new Date()
): AiUsageView {
  const span = Math.max(1, Math.min(365, Math.floor(days) || 14))
  const todayKey = localDateKey(now)

  const today = {} as Record<AiUsageSource, AiUsageDailyView>
  for (const source of AI_USAGE_SOURCES) {
    const bucket = file.daily[source]?.[todayKey]
    today[source] = bucket ? bucketToView(bucket) : emptyDailyView()
  }

  const series: AiUsageSeriesPoint[] = []
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const dateKey = localDateKey(d)
    const point: AiUsageSeriesPoint = { date: dateKey }
    for (const source of AI_USAGE_SOURCES) {
      const bucket = file.daily[source]?.[dateKey]
      if (bucket) point[source] = bucketToView(bucket)
    }
    series.push(point)
  }

  return { enabled: file.config.enabled, today, series }
}

/** 便捷:直接从盘读 + 构造视图。 */
export function getAiUsageView(days = 14, root?: string, now: Date = new Date()): AiUsageView {
  return buildAiUsageView(readAiUsage(root), days, now)
}

/** 仅供测试:清空进程内 enabled 缓存。 */
export function __resetAiUsageCacheForTest(): void {
  enabledCache.clear()
}
