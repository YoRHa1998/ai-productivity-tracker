import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { findGitRoot } from './git.js'

export const AIP_DIR_NAME = '.ai-productivity'
export const BINDINGS_FILE_NAME = 'bindings.json'

/**
 * 单分支与 jiraKey 的绑定状态. v2.0 后 jiraKey 自身作为主键,不再持有 DB 自增 id.
 * 读取时兼容老格式(含 requirementId 字段)。
 */
export interface BindingEntry {
  jiraKey: string
  branch: string
  startedAt: string
  cumulativeToken: number
  lastIterationSeq: number
  lastReportedAt: string | null
  /**
   * v2.12.0 按 source 分桶的最近一次上报时间。
   *
   * 旧字段 `lastReportedAt` 不区分 source,Cursor 和 Claude Code 共用,会在跨工具切换时
   * 互相污染(典型:用户在 Cursor 跑完一轮后过几分钟在 Claude Code 提了新问题,
   * Claude Code 这一轮的 thinkSeconds 会被算成几分钟)。本字段按 source 单独维护,
   * iteration-extras 的 fallback 路径(`turnStartedAt` 缺省)读对应 source 的桶,
   * 避免跨工具串扰。`lastReportedAt` 字段保留,做最近一次落盘的全局兜底。
   *
   * 老 binding 文件不存在此字段;读取时归一化为空对象,首次写入即建桶。
   */
  lastReportedAtBySource?: Record<string, string>
  /** 需求文件夹里 requirement.startedAt 的镜像,用于算「任务总耗时」 */
  requirementStartedAt?: string | null
  /** 上一次 hook 触发时间,用于 think_seconds 间隔近似 */
  lastHookFiredAt?: string | null
}

export interface PendingEntry {
  branch: string
  firstSeenAt: string
  cumulativeToken: number
}

export interface BindingsFile {
  version: number
  bindings: Record<string, BindingEntry>
  pending: Record<string, PendingEntry>
}

export interface UpsertInput {
  branch: string
  startedAt: string
  mergePendingTokens?: number
  /** requirement.startedAt 的镜像,缺省时回退到 input.startedAt */
  requirementStartedAt?: string
}

export function ensureAipDir(projectRoot: string): string {
  const dir = resolve(projectRoot, AIP_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function bindingsPath(projectRoot: string): string {
  return resolve(ensureAipDir(projectRoot), BINDINGS_FILE_NAME)
}

/** 把老格式 BindingEntry (含 requirementId) 归一化成 v2.0 格式;保留 jiraKey 等关键字段 */
function normalizeEntry(raw: unknown, fallbackKey: string): BindingEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<BindingEntry> & { requirementId?: unknown }
  const jiraKey = typeof r.jiraKey === 'string' && r.jiraKey ? r.jiraKey : fallbackKey
  if (!jiraKey) return null
  return {
    jiraKey,
    branch: typeof r.branch === 'string' ? r.branch : '',
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date().toISOString(),
    cumulativeToken: typeof r.cumulativeToken === 'number' ? r.cumulativeToken : 0,
    lastIterationSeq: typeof r.lastIterationSeq === 'number' ? r.lastIterationSeq : 0,
    lastReportedAt: typeof r.lastReportedAt === 'string' ? r.lastReportedAt : null,
    lastReportedAtBySource: normalizeSourceMap(r.lastReportedAtBySource),
    requirementStartedAt:
      typeof r.requirementStartedAt === 'string' ? r.requirementStartedAt : null,
    lastHookFiredAt: typeof r.lastHookFiredAt === 'string' ? r.lastHookFiredAt : null
  }
}

function normalizeSourceMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && key && typeof value === 'string' && value) {
      out[key] = value
    }
  }
  return out
}

export function readBindings(projectRoot: string): BindingsFile {
  const file = resolve(projectRoot, AIP_DIR_NAME, BINDINGS_FILE_NAME)
  if (!existsSync(file)) {
    return { version: 1, bindings: {}, pending: {} }
  }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BindingsFile>
    const bindings: Record<string, BindingEntry> = {}
    for (const [key, value] of Object.entries(parsed.bindings ?? {})) {
      const norm = normalizeEntry(value, key)
      if (norm) bindings[key] = norm
    }
    return {
      version: parsed.version ?? 1,
      bindings,
      pending: parsed.pending ?? {}
    }
  } catch {
    return { version: 1, bindings: {}, pending: {} }
  }
}

function writeBindingsAtomic(file: string, data: BindingsFile): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function upsertBinding(
  projectRoot: string,
  jiraKey: string,
  input: UpsertInput
): BindingEntry {
  const file = bindingsPath(projectRoot)
  const current = readBindings(projectRoot)

  const existing = current.bindings[jiraKey]
  const pending = current.pending[jiraKey]

  const carryFromPending = input.mergePendingTokens ?? pending?.cumulativeToken ?? 0

  const entry: BindingEntry = {
    jiraKey,
    branch: input.branch,
    startedAt: existing?.startedAt ?? input.startedAt,
    cumulativeToken: (existing?.cumulativeToken ?? 0) + carryFromPending,
    lastIterationSeq: existing?.lastIterationSeq ?? 0,
    lastReportedAt: existing?.lastReportedAt ?? null,
    lastReportedAtBySource: existing?.lastReportedAtBySource ?? {},
    // requirementStartedAt 一旦写入就视为「首次 init 时间」,后续 upsert 不再覆盖,
    // 避免 hook 链路里 binding 已有时间被 init handler 重写,导致 elapsedMinutes 漂移
    requirementStartedAt:
      existing?.requirementStartedAt ?? input.requirementStartedAt ?? input.startedAt,
    lastHookFiredAt: existing?.lastHookFiredAt ?? null
  }

  const { [jiraKey]: _drop, ...restPending } = current.pending
  const next: BindingsFile = {
    version: 1,
    bindings: { ...current.bindings, [jiraKey]: entry },
    pending: restPending
  }
  writeBindingsAtomic(file, next)
  return entry
}

/**
 * v2.7.2 init 路径专用:把同 jiraKey 的 binding 视为「全新一轮追踪」整体重置。
 *
 * 背景:`upsertBinding(existing)` 路径会保留 `cumulativeToken`、`startedAt`、
 * `requirementStartedAt`、`lastIterationSeq`、`lastReportedAt`、`lastHookFiredAt`,
 * 这在「分支后续 hook 累加」语义下合理,但用户在面板「开始追踪」按钮触发的 init
 * 语义是「从 0 开始」 — 若同分支之前已追踪过(无论历史 iteration 是否被手动清除),
 * 老 binding 会让首条新 iteration 的 cumulativeToken / 累计耗时 带上历史包袱。
 *
 * 本函数:
 * - 若 `bindings[issueKey]` 存在 → 覆盖为「全新一轮」状态(cumulativeToken=0、
 *   startedAt/requirementStartedAt=now、lastIterationSeq=0、lastReportedAt/lastHookFiredAt=null、
 *   branch=新分支),其余字段(jiraKey)保持
 * - 若不存在 → bindings 不动,完全交给后续 `upsertBinding` 走「新建」分支
 * - 无论是否存在,**都删除 `pending[issueKey]`**,防 init 后 upsert 把老 pending 累加回来
 *
 * 仅 init 入口(`handleAiProductivityInit`)调用;hook 累加路径(`appendTokenUsage` /
 * `upsertBinding(existing)`)不受影响,保持「分支后续上报继续累加」语义。
 */
export function resetBindingForNewInit(
  projectRoot: string,
  issueKey: string,
  branch: string,
  now: string
): void {
  const file = bindingsPath(projectRoot)
  const current = readBindings(projectRoot)

  const existing = current.bindings[issueKey]
  const { [issueKey]: _droppedPending, ...restPending } = current.pending

  const nextBindings: Record<string, BindingEntry> = { ...current.bindings }
  if (existing) {
    nextBindings[issueKey] = {
      jiraKey: existing.jiraKey,
      branch,
      startedAt: now,
      cumulativeToken: 0,
      lastIterationSeq: 0,
      lastReportedAt: null,
      // v2.12.0 init 重置时一并清空 source 分桶,避免老桶污染首条新 iteration
      lastReportedAtBySource: {},
      requirementStartedAt: now,
      lastHookFiredAt: null
    }
  }

  const next: BindingsFile = {
    version: 1,
    bindings: nextBindings,
    pending: restPending
  }
  writeBindingsAtomic(file, next)
}

export interface AppendTokenResult {
  bound: boolean
  issueKey: string
  binding: BindingEntry | null
  pendingAccumulated: number
  previousReportedAt: string | null
}

/**
 * v2.12.0 source 参数说明:
 *
 * - 调用方应传入数据来源标识(典型值:`'cursor-hook'` / `'claude-hook'` / `'claude-code'`)
 * - 返回的 `previousReportedAt` 按 `binding.lastReportedAtBySource[source]` 取桶,缺省时
 *   退化到全局 `lastReportedAt`,避免老 binding 文件升级时 thinkSeconds 突变成 0
 * - 写入时同时刷新 `lastReportedAt`(全局)和 `lastReportedAtBySource[source]`(分桶),
 *   保证跨工具切换时彼此桶不串扰
 * - source 缺省 / 空串视为通用桶 `'default'`,行为与老版本一致
 */
export function appendTokenUsage(
  projectRoot: string,
  branchName: string,
  issueKey: string,
  tokens: number,
  timestamp: string,
  source?: string
): AppendTokenResult {
  const sourceKey = source && source.trim() ? source : 'default'
  if (tokens <= 0) {
    const cur = readBindings(projectRoot)
    const existing = cur.bindings[issueKey] ?? null
    const pending = cur.pending[issueKey]?.cumulativeToken ?? 0
    const sourceBucket = existing?.lastReportedAtBySource?.[sourceKey] ?? null
    return {
      bound: Boolean(existing),
      issueKey,
      binding: existing,
      pendingAccumulated: pending,
      previousReportedAt: sourceBucket ?? existing?.lastReportedAt ?? null
    }
  }

  const file = bindingsPath(projectRoot)
  const current = readBindings(projectRoot)

  const existing = current.bindings[issueKey]
  if (existing) {
    const sourceBucket = existing.lastReportedAtBySource?.[sourceKey] ?? null
    const previousReportedAt = sourceBucket ?? existing.lastReportedAt ?? null
    const updated: BindingEntry = {
      ...existing,
      cumulativeToken: existing.cumulativeToken + tokens,
      branch: branchName,
      lastReportedAt: timestamp,
      lastReportedAtBySource: {
        ...(existing.lastReportedAtBySource ?? {}),
        [sourceKey]: timestamp
      },
      lastHookFiredAt: timestamp
    }
    const next: BindingsFile = {
      ...current,
      bindings: { ...current.bindings, [issueKey]: updated }
    }
    writeBindingsAtomic(file, next)
    return { bound: true, issueKey, binding: updated, pendingAccumulated: 0, previousReportedAt }
  }

  const pending = current.pending[issueKey]
  const accumulated = (pending?.cumulativeToken ?? 0) + tokens
  const next: BindingsFile = {
    ...current,
    pending: {
      ...current.pending,
      [issueKey]: {
        branch: branchName,
        firstSeenAt: pending?.firstSeenAt ?? timestamp,
        cumulativeToken: accumulated
      }
    }
  }
  writeBindingsAtomic(file, next)
  return {
    bound: false,
    issueKey,
    binding: null,
    pendingAccumulated: accumulated,
    previousReportedAt: null
  }
}

/**
 * v2.5.1 给定 cwd 解析"最近活跃的需求绑定"。流程:
 * 1. cwd → gitRoot(沿父目录向上找 .git)
 * 2. 读 <gitRoot>/.ai-productivity/bindings.json
 * 3. 取所有 binding,按 lastReportedAt → startedAt 顺序倒序选最新一条
 *
 * 用于 attach_summary 在 jiraKey/branch 都缺时兜底,避免"刚开始追踪后首次对话上报失败"。
 * cwd 不在 git 仓库或无 binding 时返回 null。
 */
export function resolveActiveBindingByCwd(cwd: string): BindingEntry | null {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : ''
  if (!trimmed) return null
  const gitRoot = findGitRoot(trimmed)
  if (!gitRoot) return null
  const data = readBindings(gitRoot)
  const entries = Object.values(data.bindings)
  if (entries.length === 0) return null
  return (
    entries.slice().sort((a, b) => {
      const aKey = a.lastReportedAt ?? a.startedAt ?? ''
      const bKey = b.lastReportedAt ?? b.startedAt ?? ''
      return bKey.localeCompare(aKey)
    })[0] ?? null
  )
}
