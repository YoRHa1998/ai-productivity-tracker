import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureRequirementDir, requirementDir } from './paths.js'
import type { ConversationSummary, IterationSource } from './iteration-store.js'

// 复刻 iteration-store 的两个轻量级 normalizer:
//   - 用 type-only import 引类型,避免与 iteration-store 形成运行时循环依赖
//     (iteration-store.appendIteration 会再 import 本模块的 consume API)
//   - normalize 失败统一回退到安全值 (null / 'unknown'),不抛
const ONE_LINE_MAX = 120
const CHANGE_SCOPE_MAX = 120
const DISCUSSION_MAX = 300
const VALID_SOURCES: readonly IterationSource[] = ['cursor', 'claude-code', 'codex', 'unknown']

function truncate(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function normalizeSummary(raw: unknown): ConversationSummary | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    return {
      oneLine: truncate(text, ONE_LINE_MAX),
      type: 'communication',
      discussion: text.length > DISCUSSION_MAX ? text.slice(0, DISCUSSION_MAX) : text
    }
  }
  if (typeof raw !== 'object') return null
  const r = raw as Partial<ConversationSummary>
  const oneLine = typeof r.oneLine === 'string' ? r.oneLine.trim() : ''
  if (!oneLine) return null
  const type: ConversationSummary['type'] = r.type === 'coding' ? 'coding' : 'communication'
  const changeScope = typeof r.changeScope === 'string' ? r.changeScope.trim() : ''
  const discussion = typeof r.discussion === 'string' ? r.discussion.trim() : ''
  return {
    oneLine: truncate(oneLine, ONE_LINE_MAX),
    type,
    ...(changeScope ? { changeScope: truncate(changeScope, CHANGE_SCOPE_MAX) } : {}),
    ...(discussion ? { discussion: truncate(discussion, DISCUSSION_MAX) } : {})
  }
}

function normalizeSource(raw: unknown): IterationSource {
  if (typeof raw !== 'string') return 'unknown'
  return (VALID_SOURCES as readonly string[]).includes(raw) ? (raw as IterationSource) : 'unknown'
}

export const PENDING_SUMMARY_FILE = 'pending-summary.json'

/**
 * v2.7.0 attach_summary 的中间态存储.
 *
 * 设计目标:让"对话总结"与"AI 答复后由 hook/watcher 落盘的 iteration"自然对齐.
 *
 * - attach_summary 调用时只把 ConversationSummary 写入 pending-summary.json,
 *   不再直接改写"最新一条非 init iteration"(那会写到上一轮,导致用户视觉上的"本轮"永远空)
 * - 下次 appendIteration(非 init kind)在构造 entry 时调用 consume(),
 *   把 pending 内容回填到新 entry.conversationSummary 与可能的 source 上,然后删除 pending 文件
 * - 若 hook/watcher 暂未触发,pending 一直保留;新的 attach_summary 调用直接覆盖
 *
 * 跨进程语义:文件级 atomic tmp+rename 写入 + 同步 unlink 消费;
 * 极端情况下 attach 与 hook 并发竞争最坏只会丢失一次回填(下次 attach 仍会覆盖到来 iteration).
 */
export interface PendingSummary {
  version: 1
  summary: ConversationSummary
  source?: IterationSource
  createdAt: string
}

function pendingPath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), PENDING_SUMMARY_FILE)
}

/** 读取但不消费;主要给单测 / 诊断用 */
export function peekPendingSummary(jiraKey: string, root?: string): PendingSummary | null {
  const file = pendingPath(jiraKey, root)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PendingSummary>
    if (parsed?.version !== 1) return null
    const normalized = normalizeSummary(parsed.summary)
    if (!normalized) return null
    const source = parsed.source ? normalizeSource(parsed.source) : undefined
    return {
      version: 1,
      summary: normalized,
      ...(source && source !== 'unknown' ? { source } : {}),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : ''
    }
  } catch {
    return null
  }
}

/**
 * 原子写入 pending-summary;同一 jiraKey 多次调用以最后一次为准.
 * 入参 summary 已被 attach handler 的 resolve 校验过,但这里再走一次 normalize 防御异常.
 */
export function writePendingSummary(
  jiraKey: string,
  summary: ConversationSummary,
  source: IterationSource | undefined,
  root?: string
): PendingSummary | null {
  const normalized = normalizeSummary(summary)
  if (!normalized) return null
  ensureRequirementDir(jiraKey, root)
  const file = pendingPath(jiraKey, root)
  const tmp = `${file}.tmp`
  const normalizedSource = source && source !== 'unknown' ? normalizeSource(source) : undefined
  const payload: PendingSummary = {
    version: 1,
    summary: normalized,
    ...(normalizedSource && normalizedSource !== 'unknown' ? { source: normalizedSource } : {}),
    createdAt: new Date().toISOString()
  }
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
  return payload
}

/**
 * 读取并删除 pending-summary.
 * - 不存在 / 解析失败 -> 返回 null
 * - 删除失败时仍返回内容(下一次 hook 会再消费一次,等价 idempotent;视觉上没有损失)
 */
export function consumePendingSummary(jiraKey: string, root?: string): PendingSummary | null {
  const file = pendingPath(jiraKey, root)
  const payload = peekPendingSummary(jiraKey, root)
  if (!payload) {
    if (existsSync(file)) {
      try {
        unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
    return null
  }
  try {
    unlinkSync(file)
  } catch {
    // 文件可能已被并发删除,忽略
  }
  return payload
}

/** 清理 pending-summary,无返回;主要给单测 / 兜底场景 */
export function clearPendingSummary(jiraKey: string, root?: string): void {
  const file = pendingPath(jiraKey, root)
  if (existsSync(file)) {
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}
