import {
  RECENT_ATTACH_WINDOW_MS as HOOK_CORE_WINDOW_MS,
  readRecentAttachSentinel as hookCoreRead,
  recentAttachSentinelPath as hookCorePath,
  writeRecentAttachSentinel as hookCoreWrite,
  type RecentAttachPayload
} from '@ai-productivity-tracker/hook-core'

/**
 * v2.10.0 attach_summary 的"最近调用"sentinel(agent 端入口).
 *
 * 设计:
 *   - 落盘逻辑全部由 hook-core 提供(`<agentRoot>/hook-state/<JIRA-KEY>.recent-attach.json`),
 *     agent 与 stop-check 共享同一份路径定位代码,杜绝目录漂移
 *   - 本模块是 agent 端的「单一调用入口」,attach-summary handler / 单测都通过这里访问 sentinel,
 *     未来若需要在 agent 侧加额外语义(例如 jiraKey 别名 / 监控埋点)也只动这一份
 *   - 测试时通过设置 `AIPT_LOCAL_AGENT_ROOT` env 隔离到 tmp 目录,
 *     避免污染真实 `~/.ai-productivity-tracker/hook-state/`
 *
 * 时间窗口判定逻辑放在 stop-check 那边,本模块刻意不耦合.
 */

export const RECENT_ATTACH_WINDOW_MS = HOOK_CORE_WINDOW_MS

export const LOCAL_AGENT_ROOT_ENV = 'AIPT_LOCAL_AGENT_ROOT'

export type { RecentAttachPayload }

function defaultAgentRootFromEnv(): string | undefined {
  const raw = process.env[LOCAL_AGENT_ROOT_ENV]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveAgentRoot(override?: string): string | undefined {
  return override ?? defaultAgentRootFromEnv()
}

/**
 * 同步落 sentinel,失败返回 null.
 * 调用方拿到 null 后建议 console.warn,但不应阻塞 attach-summary 主流程.
 */
export function writeRecentAttachSentinel(
  jiraKey: string,
  now: Date = new Date(),
  agentRootOverride?: string
): string | null {
  return hookCoreWrite(jiraKey, now, resolveAgentRoot(agentRootOverride))
}

/** 读 sentinel(不删 / 无时间窗判定);用于 stop-check 与单测. */
export function readRecentAttachSentinel(
  jiraKey: string,
  agentRootOverride?: string
): RecentAttachPayload | null {
  return hookCoreRead(jiraKey, resolveAgentRoot(agentRootOverride))
}

/** 主要给单测断言路径用. */
export function recentAttachSentinelPath(jiraKey: string, agentRootOverride?: string): string {
  return hookCorePath(jiraKey, resolveAgentRoot(agentRootOverride))
}
