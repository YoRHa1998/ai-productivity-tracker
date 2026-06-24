/**
 * 「用量测算」store —— 秒表式窗口化 token 测算,与「整体用量」「需求维度」都正交。
 *
 * 落盘单文件 `~/.ai-productivity-tracker/data/usage-benchmark.json`:维护一个进行中的
 * 测算会话(active)与一组已完成的历史记录(sessions)。用户「开始记录 → 正常使用 AI →
 * 结束记录」圈定一段时间窗,期间流经 `recordUsage` 的归一化用量事件按「选定工具集」
 * 累加进 active 会话,供「优化前 vs 优化后」A/B 对比。
 *
 * 设计要点(见 openspec/changes/add-token-usage-benchmark/design.md):
 * - D1:独立单文件;active 持久化,daemon 重启后可恢复继续累加;tmp+rename 原子写。
 * - D2:在 `recordUsage` 内部 tee 一次 `accumulateBenchmark(event)`,按 active.sources 过滤;
 *   进程内 active 缓存保证「无测算会话」时零盘 I/O 短路。
 * - D3:`isUsageCaptureActive()`(= 整体用量开启 或 有 active 测算)放宽采集闸门,
 *   让测算独立于整体用量全局开关工作。
 * - D5b:仅累加结构化元数据(token 细分 / turns / sessionId),绝不入库对话正文。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { usageBenchmarkPath } from './paths.js'
import type { AiUsageEvent, AiUsageSource } from './ai-usage-store.js'

const BENCHMARK_SOURCES: readonly AiUsageSource[] = ['cursor', 'claude-code', 'codex']

/** 单工具在一次测算窗口内的累加值(token 细分口径与 AiUsageTokens 一致)。 */
export interface UsageBenchmarkTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 有效用量合计 = input + output + cacheCreation(不含 cacheRead) */
  total: number
  /** 对话次数(每次累加 +1) */
  turns: number
  /** 窗口内 distinct sessionId(展示「跨了几个会话」) */
  sessionIds: string[]
}

/** 跨选中工具求和的合计(便于列表/对比直接读,不含 sessionIds)。 */
export interface UsageBenchmarkGrandTotal {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  total: number
  turns: number
}

/** 进行中的测算会话。 */
export interface UsageBenchmarkActive {
  id: string
  /** 用户填的一句话标签(可空) */
  label?: string
  /** 开始时多选的工具集(至少 1 个) */
  sources: AiUsageSource[]
  startedAt: string
  /** 仅含 sources 内的工具;随事件累加 */
  totals: Record<string, UsageBenchmarkTotals>
}

/** 已完成的历史测算记录。 */
export interface UsageBenchmarkSession extends UsageBenchmarkActive {
  endedAt: string
  durationMs: number
  grandTotal: UsageBenchmarkGrandTotal
}

export interface UsageBenchmarkFile {
  version: number
  /** 进行中的测算会话;无则为 null */
  active: UsageBenchmarkActive | null
  /** 已完成记录,按 endedAt 倒序 */
  sessions: UsageBenchmarkSession[]
}

/**
 * 进程内「是否有 active 会话」缓存,按解析后的文件路径分桶(测试用不同 tmp root 互不污染)。
 * accumulateBenchmark 据此零盘 I/O 短路;start/stop/cancel 写盘后刷新对应桶。
 */
const activeCache = new Map<string, boolean>()

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function isBenchmarkSource(v: unknown): v is AiUsageSource {
  return typeof v === 'string' && (BENCHMARK_SOURCES as readonly string[]).includes(v)
}

function emptyTotals(): UsageBenchmarkTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, turns: 0, sessionIds: [] }
}

function emptyFile(): UsageBenchmarkFile {
  return { version: 1, active: null, sessions: [] }
}

function normalizeTotals(raw: unknown): UsageBenchmarkTotals {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageBenchmarkTotals>
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
    sessionIds
  }
}

function normalizeSources(raw: unknown): AiUsageSource[] {
  if (!Array.isArray(raw)) return []
  return Array.from(new Set(raw.filter(isBenchmarkSource)))
}

function normalizeTotalsMap(raw: unknown): Record<string, UsageBenchmarkTotals> {
  const out: Record<string, UsageBenchmarkTotals> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isBenchmarkSource(k)) out[k] = normalizeTotals(v)
    }
  }
  return out
}

function normalizeActive(raw: unknown): UsageBenchmarkActive | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<UsageBenchmarkActive>
  if (typeof r.id !== 'string' || !r.id) return null
  const sources = normalizeSources(r.sources)
  if (sources.length === 0) return null
  return {
    id: r.id,
    label: typeof r.label === 'string' ? r.label : undefined,
    sources,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date().toISOString(),
    totals: normalizeTotalsMap(r.totals)
  }
}

function normalizeGrandTotal(raw: unknown): UsageBenchmarkGrandTotal {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<UsageBenchmarkGrandTotal>
  return {
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheCreation: num(r.cacheCreation),
    total: num(r.total),
    turns: num(r.turns)
  }
}

function normalizeSession(raw: unknown): UsageBenchmarkSession | null {
  const active = normalizeActive(raw)
  if (!active) return null
  const r = raw as Partial<UsageBenchmarkSession>
  return {
    ...active,
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : active.startedAt,
    durationMs: num(r.durationMs),
    grandTotal: normalizeGrandTotal(r.grandTotal)
  }
}

export function readBenchmark(root?: string): UsageBenchmarkFile {
  const file = usageBenchmarkPath(root)
  if (!existsSync(file)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<UsageBenchmarkFile>
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map((s) => normalizeSession(s))
          .filter((s): s is UsageBenchmarkSession => s !== null)
      : []
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      active: normalizeActive(parsed.active),
      sessions
    }
  } catch {
    return emptyFile()
  }
}

function writeBenchmark(file: UsageBenchmarkFile, root?: string): void {
  const path = usageBenchmarkPath(root)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  activeCache.set(path, file.active !== null)
}

/**
 * 是否存在进行中的测算会话(带进程内缓存,首读恢复)。
 * accumulateBenchmark 据此零盘 I/O 短路。
 */
export function hasActiveBenchmark(root?: string): boolean {
  const key = usageBenchmarkPath(root)
  const cached = activeCache.get(key)
  if (cached !== undefined) return cached
  const present = readBenchmark(root).active !== null
  activeCache.set(key, present)
  return present
}

function genBenchmarkId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 8)
  return `bmk-${stamp}-${rand}`
}

export interface StartBenchmarkInput {
  label?: string
  sources: AiUsageSource[]
}

/**
 * 启动一个测算会话。sources 必须非空且合法;已有 active 会话时抛错(不静默覆盖)。
 */
export function startBenchmark(input: StartBenchmarkInput, root?: string): UsageBenchmarkActive {
  const file = readBenchmark(root)
  if (file.active) {
    throw new Error('已有进行中的测算会话,请先结束或取消')
  }
  const sources = normalizeSources(input?.sources)
  if (sources.length === 0) {
    throw new Error('至少选择一个 AI 工具')
  }
  const now = new Date()
  const totals: Record<string, UsageBenchmarkTotals> = {}
  for (const s of sources) totals[s] = emptyTotals()
  const active: UsageBenchmarkActive = {
    id: genBenchmarkId(now),
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined,
    sources,
    startedAt: now.toISOString(),
    totals
  }
  file.active = active
  writeBenchmark(file, root)
  return active
}

/**
 * 把一条归一化用量事件累加进当前 active 会话(若 event.source ∈ active.sources)。
 *
 * - 无 active 会话时读进程内缓存零盘 I/O 返回;命中时累加 token 细分 + turns+1 + sessionId 去重。
 * - 调用点幂等由上游保证(watcher offset / hook dedupeKey),故无需自建去重。
 */
export function accumulateBenchmark(event: AiUsageEvent, root?: string): void {
  if (!hasActiveBenchmark(root)) return
  if (!event || !isBenchmarkSource(event.source)) return

  const file = readBenchmark(root)
  const active = file.active
  if (!active) return
  if (!active.sources.includes(event.source)) return

  const bucket = active.totals[event.source] ?? emptyTotals()
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
  if (event.sessionId && !bucket.sessionIds.includes(event.sessionId)) {
    bucket.sessionIds.push(event.sessionId)
  }
  active.totals[event.source] = bucket

  writeBenchmark(file, root)
}

function computeGrandTotal(active: UsageBenchmarkActive): UsageBenchmarkGrandTotal {
  const g: UsageBenchmarkGrandTotal = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
    turns: 0
  }
  for (const s of active.sources) {
    const t = active.totals[s]
    if (!t) continue
    g.input += t.input
    g.output += t.output
    g.cacheRead += t.cacheRead
    g.cacheCreation += t.cacheCreation
    g.total += t.total
    g.turns += t.turns
  }
  return g
}

/**
 * 结束当前测算会话,定格为一条历史记录(倒序 push)。无 active 会话时抛错。
 */
export function stopBenchmark(root?: string): UsageBenchmarkSession {
  const file = readBenchmark(root)
  const active = file.active
  if (!active) {
    throw new Error('没有进行中的测算会话')
  }
  const endedAt = new Date()
  const startedMs = Date.parse(active.startedAt)
  const durationMs = Number.isFinite(startedMs) ? Math.max(0, endedAt.getTime() - startedMs) : 0
  const session: UsageBenchmarkSession = {
    ...active,
    endedAt: endedAt.toISOString(),
    durationMs,
    grandTotal: computeGrandTotal(active)
  }
  file.active = null
  file.sessions.unshift(session)
  writeBenchmark(file, root)
  return session
}

/**
 * 取消当前测算会话(丢弃,不入历史)。无 active 会话时为幂等无操作。
 */
export function cancelBenchmark(root?: string): void {
  const file = readBenchmark(root)
  if (!file.active) return
  file.active = null
  writeBenchmark(file, root)
}

/**
 * 删除一条历史测算记录(按 id)。不存在则幂等无操作。
 */
export function deleteBenchmark(id: string, root?: string): void {
  const file = readBenchmark(root)
  const next = file.sessions.filter((s) => s.id !== id)
  if (next.length === file.sessions.length) return
  file.sessions = next
  writeBenchmark(file, root)
}

/** 仅供测试:清空进程内 active 缓存。 */
export function __resetBenchmarkCacheForTest(): void {
  activeCache.clear()
}
