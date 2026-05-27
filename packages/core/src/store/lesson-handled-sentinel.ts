import {
  lessonHandledSentinelPath as hookCorePath,
  readLessonHandledSentinel as hookCoreRead,
  writeLessonHandledSentinel as hookCoreWrite,
  type LessonHandledPayload
} from '@ai-productivity-tracker/hook-core'

/**
 * v2.15.0 per-turn 经验沉淀:lesson-handled sentinel(agent 端入口).
 *
 * 设计与 recent-attach-sentinel 完全对称:
 *   - 落盘逻辑全部由 hook-core 提供(`<agentRoot>/hook-state/<JIRA-KEY>.<seq>.lesson-handled.json`),
 *     save_lessons handler 与 stop-check 共享同一份路径定位代码,杜绝目录漂移
 *   - 本模块是 agent 端的「单一调用入口」,save_lessons handler / 单测都通过这里访问 sentinel
 *   - 测试时通过设置 `TRUESIGHT_LOCAL_AGENT_ROOT` env 隔离到 tmp 目录
 *
 * 语义:文件存在 = 该 (jiraKey, seq) 经验候选已处理(用户已确认落盘 / stop hook 已提示过一次),
 * stop hook 兜底据此对同一候选最多打扰一次。不带时间窗判定。
 */

// 与 recent-attach-sentinel 共用同一个 env key;此处不重复 export,避免 store/index 聚合冲突。
const LOCAL_AGENT_ROOT_ENV = 'TRUESIGHT_LOCAL_AGENT_ROOT'

export type { LessonHandledPayload }

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
 * 同步落 lesson-handled sentinel,失败返回 null.
 * 调用方拿到 null 建议 console.warn,但不应阻塞 save_lessons 主流程.
 */
export function writeLessonHandledSentinel(
  jiraKey: string,
  seq: number,
  now: Date = new Date(),
  agentRootOverride?: string
): string | null {
  return hookCoreWrite(jiraKey, seq, now, resolveAgentRoot(agentRootOverride))
}

/** 读 sentinel(不删 / 无时间窗);用于 stop-check 与单测. */
export function readLessonHandledSentinel(
  jiraKey: string,
  seq: number,
  agentRootOverride?: string
): LessonHandledPayload | null {
  return hookCoreRead(jiraKey, seq, resolveAgentRoot(agentRootOverride))
}

/** 主要给单测断言路径用. */
export function lessonHandledSentinelPath(
  jiraKey: string,
  seq: number,
  agentRootOverride?: string
): string {
  return hookCorePath(jiraKey, seq, resolveAgentRoot(agentRootOverride))
}
