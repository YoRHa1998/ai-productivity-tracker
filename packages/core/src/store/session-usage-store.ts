/**
 * 「会话维度用量」store —— 「AI 整体用量」(ai-usage.json)的细化视图。
 *
 * 落盘单文件 `~/.ai-productivity-tracker/data/session-usage.json`,按
 * `${source}:${sessionId}` 聚合,逐会话累加 token 细分 / 对话轮次 / 工具调用次数,
 * 并记录 source、model(best-effort)、会话标题(best-effort 首条用户输入截断)、
 * jiraKey(best-effort,可下钻)、首末活跃时间(时间窗)。
 *
 * 设计要点(见 openspec/changes/add-session-token-usage/design.md):
 * - D1:独立单文件(会话数随时间无界增长,不塞进按日聚合的 ai-usage.json);
 *   key 加 `source:` 前缀消歧跨工具撞 ID;token total 口径与 AiUsageTokens 一致;
 *   tmp+rename 原子写。
 * - D2:在 `recordUsage` 的 enabled 守卫之内 tee 一次 accumulateSessionUsage,
 *   与 daily 聚合同生命周期(全局开关关闭时不写)。
 * - D3:title 仅首次写入、后续轮不覆盖(标题恒为会话第一句);model / jiraKey
 *   非空时覆盖。
 * - D4:prune on write —— 删除过期会话(retentionDays)+ 按 lastAt 倒序截断条数上限。
 * - D7:title 是「绝不入库对话正文」原则的有意放宽——只存首条输入截断片段,
 *   受整体用量全局开关管辖。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AiUsageEvent, AiUsageSource } from './ai-usage-store.js'
import { sessionUsagePath } from './paths.js'

/** 会话标题截断上限(字符);采集点 / store 双重兜底。 */
export const TITLE_MAX_LEN = 80
/** 保留天数:lastAt 早于此天数的会话在写盘前被裁剪。 */
export const RETENTION_DAYS = 30
/** 会话条数上限:超出按 lastAt 倒序保留最近的。 */
export const MAX_SESSIONS = 1000

const SESSION_USAGE_SOURCES: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

/** 单个会话的持久化形态(token 细分口径与 AiUsageTokens 一致)。 */
export interface SessionUsageRecord {
  source: AiUsageSource
  sessionId: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 有效用量合计 = input + output + cacheCreation(不含 cacheRead) */
  total: number
  /** 对话轮次(每次累加 +1) */
  turns: number
  /** 工具调用次数累加(best-effort) */
  toolCalls: number
  /** 最近一次非空 model(best-effort) */
  model?: string
  /** 会话标题(best-effort,首条用户输入截断;仅首次写入不覆盖) */
  title?: string
  /** 命中的 Jira issue key(best-effort,可下钻;非空时覆盖) */
  jiraKey?: string
  /** 会话所属项目名(best-effort,取 package.json name 或目录名;非空时覆盖) */
  projectName?: string
  /** 会话所属分支(best-effort;非空时覆盖,取最近) */
  branch?: string
  firstAt: string
  lastAt: string
}

export interface SessionUsageFile {
  version: number
  /** sessions[`${source}:${sessionId}`] = record */
  sessions: Record<string, SessionUsageRecord>
}

function emptyFile(): SessionUsageFile {
  return { version: 1, sessions: {} }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function isSessionUsageSource(v: unknown): v is AiUsageSource {
  return typeof v === 'string' && (SESSION_USAGE_SOURCES as readonly string[]).includes(v)
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 已知「噪声标签块」名:IDE 注入在用户输入外围的包裹标签,连内容一并剥离。
 * 大小写不敏感、容忍未闭合(见 sanitizeTitle)。
 */
const NOISE_TAG_NAMES: readonly string[] = [
  'timestamp',
  'cursor_commands',
  'system_reminder',
  'attached_files',
  'additional_data'
]

/**
 * 剥离 IDE 注入的包裹标签,只保留用户真实输入内容(标题去噪)。
 *
 * 口径(见 openspec/changes/improve-session-usage-list/design.md D1):
 * 1. 若含 `<user_query>...</user_query>`,优先提取**最后一个**块的内部正文(命令行 +
 *    真实输入并存时,真实输入在 user_query 内);容忍未闭合(取最后一个开标签之后的全部)。
 *    取到 user_query 正文后**不再**做全局标签剥离,保留含尖括号的正常文本(如泛型 `Array<T>`)。
 * 2. 否则移除已知噪声标签块(连内容,大小写不敏感、容忍未闭合)。
 * 3. 再剥离任何残留的成对 / 单个尖括号标签标记,保留标签之间的可读文本。
 *
 * 非字符串安全兜底成空串;幂等(对已清洗文本再跑结果不变)。不做折行 / 截断(交 truncateTitle)。
 */
export function sanitizeTitle(text: unknown): string {
  if (typeof text !== 'string') return ''

  // 1. user_query:优先提取最后一个闭合块内部正文。
  let inner: string | null = null
  const closed = /<user_query\b[^>]*>([\s\S]*?)<\/user_query>/gi
  let m: RegExpExecArray | null
  while ((m = closed.exec(text)) !== null) inner = m[1]
  if (inner === null) {
    // 容忍未闭合:取最后一个 <user_query ...> 开标签之后的全部正文。
    const open = /<user_query\b[^>]*>/gi
    let lastEnd = -1
    while ((m = open.exec(text)) !== null) lastEnd = m.index + m[0].length
    if (lastEnd >= 0) inner = text.slice(lastEnd)
  }
  if (inner !== null) return inner.trim()

  // 2. 无 user_query:移除已知噪声标签块(连内容,容忍未闭合)。
  let s = text
  for (const name of NOISE_TAG_NAMES) {
    s = s.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, 'gi'), ' ')
    s = s.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ')
  }
  // 3. 剥离残留的成对 / 单个尖括号标签标记,保留标签之间可读文本。
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 已知「纯图片占位」块宽松匹配:半/全角方括号包裹,内部正文以 `image` / `图片` 前缀
 * (大小写不敏感),容忍带文件名等变体(如 `[Image: foo.png]`)。
 *
 * 集合可按需扩展(后续如需覆盖视频 / 文件占位,补充前缀即可),漏判仅退化为
 * 「标题显示占位」,不影响用量数据。
 */
const PLACEHOLDER_BLOCK = /[[【]\s*(?:image|图片)[^\]】]*[\]】]/gi

/**
 * 判定一段文本是否为「无意义素材」(空 / 纯图片占位),用于采集与展示双侧跳过。
 *
 * 口径(见 openspec/changes/optimize-session-usage-panel/design.md D1):先 `sanitizeTitle`,
 * 若结果为空,或剥离全部已知占位块(可多块,如 `[Image][Image]`)后无其它可读正文,
 * 则视为无意义。幂等;非字符串安全兜底成 true。
 */
export function isPlaceholderTitle(text: unknown): boolean {
  const cleaned = sanitizeTitle(text)
  if (!cleaned) return true
  const stripped = cleaned.replace(PLACEHOLDER_BLOCK, ' ').replace(/\s+/g, ' ').trim()
  return stripped === ''
}

/**
 * 把任意文本归一化成一行会话标题:先去标签(sanitizeTitle)/ 去首尾空白 / 折行(及连续
 * 空白)压成单空格 / 截断。
 *
 * 非字符串或空白输入安全兜底成空串。各采集点与 store 共用,保证口径一致。
 */
export function truncateTitle(text: unknown, max: number = TITLE_MAX_LEN): string {
  const oneLine = sanitizeTitle(text).replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : TITLE_MAX_LEN
  return oneLine.length > limit ? oneLine.slice(0, limit) : oneLine
}

function normalizeRecord(key: string, raw: unknown): SessionUsageRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SessionUsageRecord>
  const source = isSessionUsageSource(r.source)
    ? r.source
    : ((key.split(':')[0] as AiUsageSource) ?? undefined)
  if (!isSessionUsageSource(source)) return null
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : key.slice(source.length + 1)
  if (!sessionId) return null
  const now = new Date().toISOString()
  const firstAt = typeof r.firstAt === 'string' && r.firstAt ? r.firstAt : now
  const lastAt = typeof r.lastAt === 'string' && r.lastAt ? r.lastAt : firstAt
  return {
    source,
    sessionId,
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheCreation: num(r.cacheCreation),
    total: num(r.total),
    turns: num(r.turns),
    toolCalls: num(r.toolCalls),
    model: optStr(r.model),
    title: optStr(r.title),
    jiraKey: optStr(r.jiraKey),
    projectName: optStr(r.projectName),
    branch: optStr(r.branch),
    firstAt,
    lastAt
  }
}

export function readSessionUsage(root?: string): SessionUsageFile {
  const file = sessionUsagePath(root)
  if (!existsSync(file)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionUsageFile>
    const sessions: Record<string, SessionUsageRecord> = {}
    if (parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [k, v] of Object.entries(parsed.sessions as Record<string, unknown>)) {
        const rec = normalizeRecord(k, v)
        if (rec) sessions[k] = rec
      }
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      sessions
    }
  } catch {
    return emptyFile()
  }
}

export function writeSessionUsage(file: SessionUsageFile, root?: string): void {
  const path = sessionUsagePath(root)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

/**
 * 保留上限治理(D4):写盘前原地裁剪 file.sessions。
 *
 * - 删除 lastAt 早于 `retentionDays`(默认 30 天,以 now 为基准)的会话;
 * - 再按 lastAt 倒序截断到 `maxSessions`(默认 1000)条上限。
 *
 * `now` 可注入测试。返回同一个(被修改的)file 以便链式。
 */
export function pruneSessions(
  file: SessionUsageFile,
  now: Date = new Date(),
  retentionDays: number = RETENTION_DAYS,
  maxSessions: number = MAX_SESSIONS
): SessionUsageFile {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  let entries = Object.entries(file.sessions).filter(([, rec]) => {
    const t = Date.parse(rec.lastAt)
    return Number.isFinite(t) ? t >= cutoff : true
  })
  entries.sort((a, b) => (Date.parse(b[1].lastAt) || 0) - (Date.parse(a[1].lastAt) || 0))
  if (entries.length > maxSessions) entries = entries.slice(0, maxSessions)
  const next: Record<string, SessionUsageRecord> = {}
  for (const [k, rec] of entries) next[k] = rec
  file.sessions = next
  return file
}

/**
 * 把一条归一化用量事件累加进对应会话维度记录。
 *
 * - 空 sessionId 直接短路(不可归属事件不入会话维度,不创建空 key)。
 * - key = `${source}:${sessionId}`;累加 token 细分 / turns+1 / toolCalls;
 *   刷新 lastAt、首见设 firstAt;非空 model / jiraKey 覆盖;title 仅首次写入不覆盖。
 * - 写盘前跑一次 pruneSessions(D4)。
 * - 幂等继承上游(watcher offset / hook dedupeKey),无需自建去重。
 */
export function accumulateSessionUsage(event: AiUsageEvent, root?: string): void {
  if (!event || !isSessionUsageSource(event.source)) return
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
  if (!sessionId) return

  const file = readSessionUsage(root)
  const key = `${event.source}:${sessionId}`
  const at = typeof event.at === 'string' && event.at ? event.at : new Date().toISOString()

  const input = num(event.tokens?.input)
  const output = num(event.tokens?.output)
  const cacheRead = num(event.tokens?.cacheRead)
  const cacheCreation = num(event.tokens?.cacheCreation)
  const total = num(event.tokens?.total) || input + output + cacheCreation

  let rec = file.sessions[key]
  if (!rec) {
    rec = {
      source: event.source,
      sessionId,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
      turns: 0,
      toolCalls: 0,
      firstAt: at,
      lastAt: at
    }
    file.sessions[key] = rec
  }

  rec.input += input
  rec.output += output
  rec.cacheRead += cacheRead
  rec.cacheCreation += cacheCreation
  rec.total += total
  rec.turns += 1
  rec.toolCalls += num(event.toolCalls)

  // firstAt 取最早、lastAt 取最近(跨自然日累加,不被日切分拆开)。
  if (Date.parse(at) < Date.parse(rec.firstAt)) rec.firstAt = at
  if (Date.parse(at) >= Date.parse(rec.lastAt)) rec.lastAt = at

  const model = optStr(event.model)
  if (model) rec.model = model

  const jiraKey = optStr(event.jiraKey)
  if (jiraKey) rec.jiraKey = jiraKey

  // projectName / branch 非空覆盖(取最近一次,与 model 同策略;branch 中途切换以最近为准)。
  const projectName = optStr(event.projectName)
  if (projectName) rec.projectName = projectName

  const branch = optStr(event.branch)
  if (branch) rec.branch = branch

  // title 仅首次写入,后续轮不覆盖(标题恒为会话第一句)。
  // 纯占位 / 空素材跳过不写,留待后续真实输入补位(D1)。
  if (!rec.title) {
    const title = truncateTitle(event.title)
    if (title && !isPlaceholderTitle(title)) rec.title = title
  }

  pruneSessions(file)
  writeSessionUsage(file, root)
}

// ────────────────────────────────────────────────────────────────────
// 查询视图(供 HTTP 端点 / 看板消费)
// ────────────────────────────────────────────────────────────────────

/** 单个会话的查询视图(展开 *Tokens 命名,与 AiUsageDailyView 一致)。 */
export interface SessionUsageView {
  key: string
  source: AiUsageSource
  sessionId: string
  title?: string
  jiraKey?: string
  projectName?: string
  branch?: string
  model?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  turns: number
  toolCalls: number
  firstAt: string
  lastAt: string
}

export type SessionUsageSortKey = 'total' | 'lastAt'
export type SessionUsageSortDir = 'asc' | 'desc'

export interface QuerySessionsParams {
  /** 起始(ISO/日期),过滤掉 lastAt 早于它的会话 */
  from?: string
  /** 结束(ISO/日期),过滤掉 firstAt 晚于它的会话 */
  to?: string
  /** 工具过滤 */
  source?: AiUsageSource
  /** 所属项目过滤(按 projectName 精确匹配;空 / 缺省不过滤) */
  project?: string
  /** 截断条数(默认 50) */
  limit?: number
  /** 排序字段(默认 total) */
  sort?: SessionUsageSortKey
  /** 排序方向(默认 desc) */
  dir?: SessionUsageSortDir
}

const DEFAULT_QUERY_LIMIT = 50

function recordToView(key: string, rec: SessionUsageRecord): SessionUsageView {
  return {
    key,
    source: rec.source,
    sessionId: rec.sessionId,
    // 展示侧幂等去标签(D1):清洗本能力上线前落盘的「带标签脏标题」,不改写落盘数据;
    // 历史落盘的纯占位标题(如 `[Image]`)视为空走兜底短 ID。
    title:
      rec.title && !isPlaceholderTitle(rec.title)
        ? truncateTitle(rec.title) || undefined
        : undefined,
    jiraKey: rec.jiraKey,
    projectName: rec.projectName,
    branch: rec.branch,
    model: rec.model,
    inputTokens: rec.input,
    outputTokens: rec.output,
    cacheReadTokens: rec.cacheRead,
    cacheCreationTokens: rec.cacheCreation,
    totalTokens: rec.total,
    turns: rec.turns,
    toolCalls: rec.toolCalls,
    firstAt: rec.firstAt,
    lastAt: rec.lastAt
  }
}

/**
 * 查询会话维度用量:按 source / 时间窗过滤 + 排序 + 截断,返回视图数组。
 *
 * - 时间过滤为「活跃时间窗与 [from, to] 相交」语义:from 过滤 lastAt < from,
 *   to 过滤 firstAt > to。
 * - 默认按 total 倒序、截断到 50 条;sort='lastAt' 按最近活跃,dir 可切升序。
 */
export function querySessions(params: QuerySessionsParams = {}, root?: string): SessionUsageView[] {
  const file = readSessionUsage(root)
  const source = isSessionUsageSource(params.source) ? params.source : undefined
  const project = optStr(params.project)
  const fromMs = params.from ? Date.parse(params.from) : NaN
  const toMs = params.to ? Date.parse(params.to) : NaN
  const sort: SessionUsageSortKey = params.sort === 'lastAt' ? 'lastAt' : 'total'
  const dir: SessionUsageSortDir = params.dir === 'asc' ? 'asc' : 'desc'
  const limit =
    Number.isFinite(params.limit) && (params.limit as number) > 0
      ? Math.floor(params.limit as number)
      : DEFAULT_QUERY_LIMIT

  let entries = Object.entries(file.sessions).filter(([, rec]) => {
    if (source && rec.source !== source) return false
    if (project && rec.projectName !== project) return false
    if (Number.isFinite(fromMs)) {
      const last = Date.parse(rec.lastAt)
      if (Number.isFinite(last) && last < fromMs) return false
    }
    if (Number.isFinite(toMs)) {
      const first = Date.parse(rec.firstAt)
      if (Number.isFinite(first) && first > toMs) return false
    }
    return true
  })

  entries.sort((a, b) => {
    let av: number
    let bv: number
    if (sort === 'lastAt') {
      av = Date.parse(a[1].lastAt) || 0
      bv = Date.parse(b[1].lastAt) || 0
    } else {
      av = a[1].total
      bv = b[1].total
    }
    return dir === 'asc' ? av - bv : bv - av
  })

  if (entries.length > limit) entries = entries.slice(0, limit)
  return entries.map(([k, rec]) => recordToView(k, rec))
}
