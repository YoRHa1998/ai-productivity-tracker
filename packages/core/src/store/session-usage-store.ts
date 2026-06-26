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

/**
 * 会话标题 / 逐轮名称素材的安全上限(字符);采集点 / store 双重兜底。
 *
 * 由历史的「80 字符硬截断」放宽为「完整记录」——正常对话完整保留,仅在防御异常超长输入
 * (如粘贴整段日志)时按此大上限 slice 兜底,避免单条标题撑爆落盘文件(见 design D6)。
 */
export const TITLE_MAX_LEN = 4000
/** 保留天数:lastAt 早于此天数的会话在写盘前被裁剪。 */
export const RETENTION_DAYS = 30
/** 会话条数上限:超出按 lastAt 倒序保留最近的。 */
export const MAX_SESSIONS = 1000
/**
 * 单会话逐轮明细(turnDetails)条数上限:超出按时间保留最近的若干项。
 *
 * 与会话级 `turns` 计数解耦——`turns` 仍累加真实总轮数,明细数组只留最近 N 项,
 * 详情弹窗对「明细被裁剪」给出说明(见 design D3)。
 */
export const MAX_TURN_DETAILS = 500

const SESSION_USAGE_SOURCES: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

/**
 * 单轮明细的持久化形态(一条 `AiUsageEvent` = 一轮,与 `rec.turns += 1` 同步追加)。
 *
 * token 细分口径与 `AiUsageTokens` / `SessionUsageRecord` 一致;`title` 为该轮用户输入素材
 * (去标签 / 压一行 / 完整记录,大安全上限兜底)。无时长字段——时长由相邻轮 `at` 差值在
 * 查询 / 视图层推导,不落盘(见 design D2)。
 */
export interface SessionTurnDetail {
  /** 该轮事件时间戳(ISO) */
  at: string
  /** 本轮有效用量合计 = input + output + cacheCreation(不含 cacheRead) */
  total: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 本轮工具调用次数(best-effort) */
  toolCalls: number
  /** 本轮模型(best-effort) */
  model?: string
  /** 本轮名称素材 = 该轮用户输入(去标签 / 压一行 / 完整记录) */
  title?: string
}

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
  /**
   * 逐轮明细(可选,加性 schema):每轮 push 一项,超 `MAX_TURN_DETAILS` 按时间保留最近的。
   * 本能力上线前写入的旧记录无此字段,读取时安全兜底为 undefined(见 design D1/D3)。
   */
  turnDetails?: SessionTurnDetail[]
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

/**
 * 加性安全解析逐轮明细数组:
 * - 缺失 / 非数组 → undefined(旧记录向后兼容,绝不报错);
 * - 逐项过滤掉非法项(非对象 / 无合法 `at`),数值字段经 `num` 兜底、`title`/`model` 经 `optStr`;
 * - 全部非法 → undefined(而非空数组),与「无明细」语义一致;
 * - 超 `MAX_TURN_DETAILS` 时保留最近的若干项(防御异常超大旧文件)。
 */
function normalizeTurnDetails(raw: unknown): SessionTurnDetail[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SessionTurnDetail[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Partial<SessionTurnDetail>
    const at = typeof t.at === 'string' && t.at ? t.at : ''
    if (!at) continue
    const input = num(t.input)
    const output = num(t.output)
    const cacheRead = num(t.cacheRead)
    const cacheCreation = num(t.cacheCreation)
    const total = num(t.total) || input + output + cacheCreation
    out.push({
      at,
      total,
      input,
      output,
      cacheRead,
      cacheCreation,
      toolCalls: num(t.toolCalls),
      model: optStr(t.model),
      title: optStr(t.title)
    })
  }
  if (out.length === 0) return undefined
  return out.length > MAX_TURN_DETAILS ? out.slice(out.length - MAX_TURN_DETAILS) : out
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
    turnDetails: normalizeTurnDetails(r.turnDetails),
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

  // 逐轮明细:与 `rec.turns += 1` 同步追加一项(一事件 = 一轮)。
  // turns 计数反映真实总轮数,明细数组只留最近 MAX_TURN_DETAILS 项(裁剪不影响 turns,见 D3)。
  if (!Array.isArray(rec.turnDetails)) rec.turnDetails = []
  const turnTitle = truncateTitle(event.title)
  rec.turnDetails.push({
    at,
    total,
    input,
    output,
    cacheRead,
    cacheCreation,
    toolCalls: num(event.toolCalls),
    model: optStr(event.model),
    title: turnTitle || undefined
  })
  if (rec.turnDetails.length > MAX_TURN_DETAILS) {
    rec.turnDetails = rec.turnDetails.slice(rec.turnDetails.length - MAX_TURN_DETAILS)
  }

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
  /**
   * 按会话 key 集合精确过滤(每项 `${source}:${sessionId}`)。
   * 提供时仅保留 key 命中集合内的会话,过滤在排序 / 截断之前施加(不被 top-N 挤掉);
   * 集合内不存在的 key 安全忽略;空 / 缺省不过滤(向后兼容)。
   */
  keys?: string[]
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
  // keys 集合过滤:非空数组时构造 Set,在排序 / 截断之前按 key 命中保留;空 / 缺省(或全部非法)不过滤。
  let keySet: Set<string> | undefined
  if (Array.isArray(params.keys) && params.keys.length > 0) {
    const valid = params.keys.filter((k): k is string => typeof k === 'string' && k.length > 0)
    if (valid.length > 0) keySet = new Set(valid)
  }

  let entries = Object.entries(file.sessions).filter(([key, rec]) => {
    if (keySet && !keySet.has(key)) return false
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

// ────────────────────────────────────────────────────────────────────
// 会话详情(逐轮明细)查询视图
// ────────────────────────────────────────────────────────────────────

/** 单轮明细的查询视图:落盘字段 + 视图层推导的 durationMs / ratio。 */
export interface SessionTurnDetailView {
  at: string
  total: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  toolCalls: number
  model?: string
  /** 本轮名称素材(展示侧幂等去标签 / 压一行;纯占位则留空) */
  title?: string
  /**
   * 本轮时长(ms)= 相邻两轮事件时间戳之差(`at[i+1] - at[i]`);
   * 含用户思考 / 空闲,非纯模型耗时;**最后一轮**无后继时留空(展示侧呈现「—」)。见 D2。
   */
  durationMs?: number
  /** 本轮 total / 会话 total,clamp 到 [0,1];会话 total<=0 时为 0。 */
  ratio: number
}

/** 会话详情查询结果:会话头部(无则 null)+ 按时间升序的逐轮明细。 */
export interface SessionDetailResult {
  /** 会话头部(复用列表视图);key 不存在时为 null。 */
  session: SessionUsageView | null
  /** 逐轮明细(按 at 升序);key 不存在 / 无明细时为空数组。 */
  turns: SessionTurnDetailView[]
}

/**
 * 按会话 key(`${source}:${sessionId}`)查询单个会话的逐轮明细视图。
 *
 * - 逐轮明细按 `at` 升序;每轮推导 `durationMs`(相邻轮间隔、末轮留空)与 `ratio`
 *   (本轮 total ÷ 会话 total)。
 * - key 不存在 → `{ session: null, turns: [] }`(端点据此返回 200 空态,非 404)。
 * - key 存在但无逐轮明细(上线前历史会话)→ `{ session, turns: [] }`,绝不报错。
 */
export function querySessionDetail(key: string, root?: string): SessionDetailResult {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return { session: null, turns: [] }

  const file = readSessionUsage(root)
  const rec = file.sessions[trimmed]
  if (!rec) return { session: null, turns: [] }

  const session = recordToView(trimmed, rec)
  const details = Array.isArray(rec.turnDetails) ? rec.turnDetails : []
  if (details.length === 0) return { session, turns: [] }

  // 按 at 升序(防御乱序落盘);无法解析的 at 视为 0 排到最前,稳定排序保留相对次序。
  const sorted = [...details].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
  const sessionTotal = rec.total > 0 ? rec.total : 0

  const turns: SessionTurnDetailView[] = sorted.map((t, i) => {
    let durationMs: number | undefined
    if (i < sorted.length - 1) {
      const cur = Date.parse(t.at)
      const next = Date.parse(sorted[i + 1].at)
      if (Number.isFinite(cur) && Number.isFinite(next) && next >= cur) durationMs = next - cur
    }
    const ratio = sessionTotal > 0 ? usageRatioClamp(t.total / sessionTotal) : 0
    return {
      at: t.at,
      total: t.total,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheCreation: t.cacheCreation,
      toolCalls: t.toolCalls,
      model: t.model,
      title:
        t.title && !isPlaceholderTitle(t.title) ? truncateTitle(t.title) || undefined : undefined,
      durationMs,
      ratio
    }
  })

  return { session, turns }
}

/** 把比值 clamp 到 [0,1];非法 / 负值归 0,超 1 归 1。 */
function usageRatioClamp(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 0
  return r > 1 ? 1 : r
}
