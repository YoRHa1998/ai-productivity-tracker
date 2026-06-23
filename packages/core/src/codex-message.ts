/**
 * Codex CLI 会话 jsonl 行解析器。
 *
 * Codex 把每次会话写到 `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`,
 * 每行形如 `{ timestamp, type, payload }`。与 Claude Code transcript 的差异:
 *
 * - `session_meta`(首行,每会话一次):携带 `payload.id`(sessionId)/`payload.cwd`/
 *   `payload.git.branch`。**cwd 与 git branch 只在这一行出现**,不像 Claude 每条 assistant
 *   行都带,因此 watcher 必须缓存 `sessionId → { cwd, gitBranch }`。
 * - `turn_context`(每轮起点):携带 `payload.turn_id`/`payload.model`/`payload.cwd`。
 * - `event_msg`:`payload.type` 区分子类型:
 *   - `task_started`:本轮开始
 *   - `user_message`:用户 prompt(本轮真实起点 timestamp)
 *   - `token_count`:`payload.info.total_token_usage` 是**累计单调递增**的 token 用量
 *   - `task_complete`:**本轮结束信号**(watcher flush 时机)
 * - `response_item`:消息 / 工具调用原文,本工具不消费。
 *
 * 设计与 `claude-message.ts` 对齐:解析失败一律返回 null,不抛。
 */

export interface CodexSessionMeta {
  sessionId: string
  cwd: string
  gitBranch: string | null
  timestamp: string
}

export interface CodexTurnContext {
  turnId: string
  model: string
  cwd: string
  timestamp: string
}

export interface CodexTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface CodexTokenCount {
  /** 截至本行的累计用量(单调递增) */
  total: CodexTokenUsage
  timestamp: string
}

/**
 * event_msg 的轮边界子类型。token_count 单独由 parseCodexTokenCount 处理。
 */
export type CodexTurnBoundaryKind = 'task_started' | 'user_message' | 'task_complete'

export interface CodexTurnBoundary {
  kind: CodexTurnBoundaryKind
  /** task_started / task_complete 带 turn_id;user_message 通常无,留空串 */
  turnId: string
  timestamp: string
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseObj(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object') return null
    return obj as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Codex 累计 token 的「有效用量」口径,对齐 claude-message.effectiveTokens:
 * 仅算实际新增 token(input + output),排除 cached_input(≈ Claude 的 cache_read,
 * 计费仅 0.1x 且同一 prompt 一轮内会被反复计入,逐条累加会严重虚高)。
 *
 * 返回值是「累计有效用量」;watcher 在轮边界做相邻差得到本轮增量,天然防重复计数。
 */
export function effectiveCodexTokens(usage: CodexTokenUsage): number {
  return Math.max(0, usage.inputTokens - usage.cachedInputTokens + usage.outputTokens)
}

export function parseCodexSessionMeta(raw: string): CodexSessionMeta | null {
  const obj = parseObj(raw)
  if (!obj || obj.type !== 'session_meta') return null

  const payload = obj.payload as Record<string, unknown> | undefined
  if (!payload) return null

  const sessionId = str(payload.id)
  const cwd = str(payload.cwd)
  if (!sessionId || !cwd) return null

  const git = payload.git as Record<string, unknown> | undefined
  const gitBranchRaw = git ? str(git.branch) : ''
  const gitBranch = gitBranchRaw && gitBranchRaw !== 'HEAD' ? gitBranchRaw : null

  return {
    sessionId,
    cwd,
    gitBranch,
    timestamp: str(obj.timestamp) || str(payload.timestamp) || new Date().toISOString()
  }
}

export function parseCodexTurnContext(raw: string): CodexTurnContext | null {
  const obj = parseObj(raw)
  if (!obj || obj.type !== 'turn_context') return null

  const payload = obj.payload as Record<string, unknown> | undefined
  if (!payload) return null

  return {
    turnId: str(payload.turn_id),
    model: str(payload.model) || 'unknown',
    cwd: str(payload.cwd),
    timestamp: str(obj.timestamp) || new Date().toISOString()
  }
}

export function parseCodexTokenCount(raw: string): CodexTokenCount | null {
  const obj = parseObj(raw)
  if (!obj || obj.type !== 'event_msg') return null

  const payload = obj.payload as Record<string, unknown> | undefined
  if (!payload || payload.type !== 'token_count') return null

  const info = payload.info as Record<string, unknown> | undefined
  if (!info) return null

  const total = info.total_token_usage as Record<string, unknown> | undefined
  if (!total) return null

  const usage: CodexTokenUsage = {
    inputTokens: num(total.input_tokens),
    cachedInputTokens: num(total.cached_input_tokens),
    outputTokens: num(total.output_tokens),
    totalTokens: num(total.total_tokens)
  }

  return {
    total: usage,
    timestamp: str(obj.timestamp) || new Date().toISOString()
  }
}

export function parseCodexTurnBoundary(raw: string): CodexTurnBoundary | null {
  const obj = parseObj(raw)
  if (!obj || obj.type !== 'event_msg') return null

  const payload = obj.payload as Record<string, unknown> | undefined
  if (!payload) return null

  const subtype = str(payload.type)
  if (subtype !== 'task_started' && subtype !== 'user_message' && subtype !== 'task_complete') {
    return null
  }

  return {
    kind: subtype,
    turnId: str(payload.turn_id),
    timestamp: str(obj.timestamp) || new Date().toISOString()
  }
}
