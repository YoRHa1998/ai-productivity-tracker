import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * v2.10.0 attach_summary 防伪造校验的 sentinel 机制(jiraKey 维度,同步写).
 *
 * 老链路(v2.8.0 ~ v2.9.x):
 *   - Cursor afterMCPExecution Hook 异步写 conv-gen 维度 sentinel,
 *     stop hook 同步读 sentinel + consume 决定是否注入 followup.
 *   - 弊端:fire-and-forget 跨进程时序不可控 + tool_name 严格相等匹配脆弱,
 *     实测 hook-state/ 长期为空,stop-check 永远走 inject_followup → 一次对话被强制重答两次.
 *
 * 新链路(v2.10.0):
 *   - agent `handleAiProductivityAttachSummary` 同进程同步写 jiraKey 维度 sentinel.
 *     attach_summary HTTP 返回前 sentinel 必定落盘,stop-check 读取无 race.
 *   - mark-tool-called hook 已下线;argv-router 仅保留静默兼容防止旧 hooks.json 报错.
 *
 * 路径布局:
 *   ~/.ai-productivity-tracker/hook-state/<JIRA-KEY>.recent-attach.json
 *
 * 跨进程语义:tmp+rename 原子覆盖;同 jiraKey 多次调用以最后一次为准.
 */

const SENTINEL_DIR_NAME = 'hook-state'
const RECENT_ATTACH_SUFFIX = '.recent-attach.json'
/**
 * v2.15.0 per-turn 经验沉淀:lesson-handled sentinel 后缀(jiraKey + seq 维度).
 *
 * 文件名形如 `<JIRA-KEY>.<seq>.lesson-handled.json`,标记"某需求某轮的经验候选已被处理过"
 * (用户已通过 save_lessons 落盘,或 stop hook 已就该候选注入过一次提示).
 * stop hook 兜底据此保证对同一 (jiraKey, seq) 候选最多打扰一次.
 */
const LESSON_HANDLED_SUFFIX = '.lesson-handled.json'
/** 兼容老链路落下来的 conv-gen 维度文件,GC 时一并清掉(防止 hook-state/ 目录残留垃圾) */
const LEGACY_SENTINEL_SUFFIX = '.attach-called.json'
const GC_MAX_AGE_MS = 7 * 24 * 3600 * 1000

/**
 * v2.13.0 attach_summary 的"最近调用"时间窗口(毫秒).
 *
 * agent 端在 handleAiProductivityAttachSummary 里同步落 sentinel,stop-check 看到
 * `now - calledAt < RECENT_ATTACH_WINDOW_MS` 即视为本轮真调过,放行;否则注入 followup.
 *
 * v2.13.0 把窗口从 10s 拉大到 90s,根因:
 *   - 老 10s 窗只覆盖"LLM 调完 attach_summary 后立刻 end_turn"的理想路径
 *   - 实测 LLM 调完 attach_summary 后,通常还会再写一段总结性正文(给用户的人类可读答复),
 *     这段输出在长对话上下文里耗时常达 20~30s,end_turn 时距 sentinel 落盘已 >10s
 *   - 旧链路下 stop-check 误判"本轮没调过 attach_summary"→ 注入 followup →
 *     LLM 被强制再答一轮,看板上单次用户提问产出 2 条 iteration(典型案例:
 *     INSTANT-5321 的 #3/#4 间隔 32s 与 #5/#6 间隔 17s,实测 calledAt → end_turn 差 21.4s)
 *   - 90s 上限覆盖绝大多数"调 attach + 输出长文字 + Cursor stop hook 冷启动 + 安全余量"
 *   - 并发风险:同 jiraKey + 90s 窗内"另一个对话恰好结束"才会撞,日常单人使用极罕见;
 *     即使撞了影响仅是"另一个对话的 followup 被吞",远比"每轮都重复上报"代价小
 */
export const RECENT_ATTACH_WINDOW_MS = 90_000

/**
 * v2.10.0 attach_summary 写入的 sentinel payload.
 *
 * 与老的 conv-gen 维度 SentinelPayload 不同:
 *   - 老:Cursor afterMCPExecution Hook 异步写,key=conv+gen,跨进程时序不可控
 *   - 新:agent attach-summary handler 同进程同步写,key=jiraKey,落盘时已具备一切上下文
 *
 * stop-check 解析 jiraKey 后通过 `readRecentAttachSentinel` 读出来,看 calledAt 时间窗.
 */
export interface RecentAttachPayload {
  jiraKey: string
  /** ISO8601 字符串;stop-check 判定 `Date.now() - new Date(calledAt).getTime() < RECENT_ATTACH_WINDOW_MS` */
  calledAt: string
}

function sanitizeJiraKeyForFilename(jiraKey: string): string {
  return String(jiraKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 120)
}

export function sentinelDir(rootOverride?: string): string {
  const base = rootOverride ?? join(homedir(), '.ai-productivity-tracker')
  return join(base, SENTINEL_DIR_NAME)
}

/**
 * 计算 `<jiraKey>.recent-attach.json` 的绝对路径.
 *
 * agent attach-summary handler 与 stop-check 共享同一份路径定位代码,避免目录漂移.
 */
export function recentAttachSentinelPath(jiraKey: string, rootOverride?: string): string {
  const safe = sanitizeJiraKeyForFilename(jiraKey) || '_invalid'
  return join(sentinelDir(rootOverride), `${safe}${RECENT_ATTACH_SUFFIX}`)
}

/**
 * 原子写入 jiraKey 维度 sentinel.
 *
 * - 同 jiraKey 多次调用以最后一次为准(覆盖式)
 * - tmp + rename 原子覆盖;rename 失败降级为直接覆盖写
 * - 失败返回 null,不抛(由调用方记 console.warn,主流程不阻塞)
 */
export function writeRecentAttachSentinel(
  jiraKey: string,
  now: Date = new Date(),
  rootOverride?: string
): string | null {
  const safe = sanitizeJiraKeyForFilename(jiraKey)
  if (!safe) return null
  try {
    const dir = sentinelDir(rootOverride)
    mkdirSync(dir, { recursive: true })
    const finalPath = recentAttachSentinelPath(safe, rootOverride)
    const tmpPath = `${finalPath}.tmp`
    const payload: RecentAttachPayload = { jiraKey: safe, calledAt: now.toISOString() }
    const body = JSON.stringify(payload, null, 2) + '\n'
    writeFileSync(tmpPath, body, 'utf-8')
    try {
      renameSync(tmpPath, finalPath)
    } catch {
      writeFileSync(finalPath, body, 'utf-8')
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
    return finalPath
  } catch {
    return null
  }
}

/**
 * 读取 jiraKey 维度 sentinel(不删).
 *
 * - 文件不存在 / JSON 损坏 / 字段缺失 → null
 * - 解析成功但 calledAt 不是合法字符串 → null
 *
 * 调用方(stop-check)拿到 payload 后自己判断 `Date.now() - new Date(calledAt).getTime() < RECENT_ATTACH_WINDOW_MS`,
 * 我们刻意不在本函数内做时间窗判定 — 让单测能直接断言时间字段,逻辑分离更清晰.
 */
export function readRecentAttachSentinel(
  jiraKey: string,
  rootOverride?: string
): RecentAttachPayload | null {
  const safe = sanitizeJiraKeyForFilename(jiraKey)
  if (!safe) return null
  const file = recentAttachSentinelPath(safe, rootOverride)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RecentAttachPayload>
    if (!parsed || typeof parsed.calledAt !== 'string') return null
    return {
      jiraKey: typeof parsed.jiraKey === 'string' ? parsed.jiraKey : safe,
      calledAt: parsed.calledAt
    }
  } catch {
    return null
  }
}

/**
 * v2.15.0 lesson-handled sentinel payload(jiraKey + seq 维度).
 *
 * 标记"该需求该轮的经验候选已处理",不带时间窗判定(只看存在与否).
 */
export interface LessonHandledPayload {
  jiraKey: string
  seq: number
  /** ISO8601;仅用于排障 / GC,不参与是否放行的判定 */
  handledAt: string
}

function isValidSeq(seq: number): boolean {
  return Number.isInteger(seq) && seq > 0
}

/**
 * 计算 `<jiraKey>.<seq>.lesson-handled.json` 的绝对路径.
 *
 * save_lessons handler(经用户确认落盘)与 stop-check 兜底共享同一份路径定位,避免目录漂移.
 */
export function lessonHandledSentinelPath(
  jiraKey: string,
  seq: number,
  rootOverride?: string
): string {
  const safe = sanitizeJiraKeyForFilename(jiraKey) || '_invalid'
  const safeSeq = isValidSeq(seq) ? seq : 0
  return join(sentinelDir(rootOverride), `${safe}.${safeSeq}${LESSON_HANDLED_SUFFIX}`)
}

/**
 * 原子写入 lesson-handled sentinel(同 (jiraKey, seq) 覆盖式;tmp + rename).
 * 失败返回 null,不抛(调用方 fail-open,不阻塞主流程).
 */
export function writeLessonHandledSentinel(
  jiraKey: string,
  seq: number,
  now: Date = new Date(),
  rootOverride?: string
): string | null {
  const safe = sanitizeJiraKeyForFilename(jiraKey)
  if (!safe || !isValidSeq(seq)) return null
  try {
    const dir = sentinelDir(rootOverride)
    mkdirSync(dir, { recursive: true })
    const finalPath = lessonHandledSentinelPath(safe, seq, rootOverride)
    const tmpPath = `${finalPath}.tmp`
    const payload: LessonHandledPayload = { jiraKey: safe, seq, handledAt: now.toISOString() }
    const body = JSON.stringify(payload, null, 2) + '\n'
    writeFileSync(tmpPath, body, 'utf-8')
    try {
      renameSync(tmpPath, finalPath)
    } catch {
      writeFileSync(finalPath, body, 'utf-8')
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
    return finalPath
  } catch {
    return null
  }
}

/**
 * 读 lesson-handled sentinel(不删 / 无时间窗).文件存在且 JSON 合法 → payload;否则 null.
 * stop-check 据此判断该 (jiraKey, seq) 候选是否已处理过.
 */
export function readLessonHandledSentinel(
  jiraKey: string,
  seq: number,
  rootOverride?: string
): LessonHandledPayload | null {
  const safe = sanitizeJiraKeyForFilename(jiraKey)
  if (!safe || !isValidSeq(seq)) return null
  const file = lessonHandledSentinelPath(safe, seq, rootOverride)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LessonHandledPayload>
    if (!parsed || typeof parsed.handledAt !== 'string') return null
    return {
      jiraKey: typeof parsed.jiraKey === 'string' ? parsed.jiraKey : safe,
      seq: typeof parsed.seq === 'number' ? parsed.seq : seq,
      handledAt: parsed.handledAt
    }
  } catch {
    return null
  }
}

/**
 * 清理孤儿 sentinel(>maxAgeMs).在每次 stop-check 启动时调用一次,避免目录无限增长.
 * 任何 I/O 错误一律吞掉,不影响主流程.
 *
 * 同时清理:
 *   - v2.10.0 `<jiraKey>.recent-attach.json`(正常窗口只有 10s,流程中根本来不及触发 GC,
 *     这里主要兜底 agent 异常退出留下的孤儿)
 *   - v2.8.0 ~ v2.9.x 老链路 `.attach-called.json`(用户升级后历史残留,被动清空)
 */
export function gcSentinels(
  rootOverride?: string,
  now: number = Date.now(),
  maxAgeMs: number = GC_MAX_AGE_MS
): number {
  const dir = sentinelDir(rootOverride)
  if (!existsSync(dir)) return 0
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (
        !name.endsWith(RECENT_ATTACH_SUFFIX) &&
        !name.endsWith(LESSON_HANDLED_SUFFIX) &&
        !name.endsWith(LEGACY_SENTINEL_SUFFIX)
      )
        continue
      const full = join(dir, name)
      try {
        const stat = statSync(full)
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(full)
          removed += 1
        }
      } catch {
        // 单个文件错误不影响继续
      }
    }
  } catch {
    // 读目录失败直接返回
  }
  return removed
}
