export type AssistantStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'pause_turn'
  | 'max_tokens'
  | 'stop_sequence'

const VALID_STOP_REASONS: readonly AssistantStopReason[] = [
  'end_turn',
  'tool_use',
  'pause_turn',
  'max_tokens',
  'stop_sequence'
]

/**
 * v2.6.0 触发 watcher flush 的 stop_reason 集合。
 * tool_use / null 视为「轮中间消息」,仅累加 buffer。
 */
export const TERMINAL_STOP_REASONS: readonly AssistantStopReason[] = [
  'end_turn',
  'pause_turn',
  'max_tokens',
  'stop_sequence'
]

export interface ParsedTokens {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  total: number
}

export interface ParsedAssistantMessage {
  cwd: string
  gitBranch: string | null
  sessionId: string
  uuid: string
  timestamp: string
  model: string
  /**
   * v2.9.4 新增:Claude API 响应的 message.id(形如 `msg_01SbiUFey9vLGi5zKGBTfZE2`)。
   *
   * Claude Code 自 2.x 起会把同一次 API 响应的 `thinking` 块与 `text` 块拆成多条
   * jsonl 行写入 transcript,**每条都带完整的 usage 与 stop_reason=end_turn**,
   * 但共享同一个 `message.id`。watcher 以此作为主去重键,避免一次 API 调用被算成
   * 多个 iteration、token 被双倍累加。
   *
   * 老 Claude Code 客户端或异常行可能没有 `message.id`,此时归 `''`,watcher 退化
   * 到 usage 指纹兜底策略。
   */
  apiMessageId: string
  /**
   * v2.6.0 新增:Claude API stop_reason,用于 watcher 按轮聚合落盘。
   * 未知值或缺失归 null(Claude Code 早期版本可能没写)。
   */
  stopReason: AssistantStopReason | null
  tokens: ParsedTokens
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseStopReason(v: unknown): AssistantStopReason | null {
  if (typeof v !== 'string') return null
  return (VALID_STOP_REASONS as readonly string[]).includes(v) ? (v as AssistantStopReason) : null
}

/**
 * v2.6.0 token 累计算法:仅累加「这次 API 调用实际新增的 token」。
 *
 * cache_read 在 Claude API 计费维度上仅 0.1x 价格,且同一 prompt 会在一轮内多次出现,
 * 逐条累加会严重虚高。本工具取 input + output + cache_creation,与 Claude UI 显示的
 * token 数字更接近。
 *
 * 注意:`tokens.total` 字段保留原语义(四个之和)用于 rawPayload 留痕,watcher 内
 * 累加用此函数。
 */
export function effectiveTokens(t: ParsedTokens): number {
  return t.input + t.output + t.cacheCreation
}

export function parseClaudeJsonlLine(raw: string): ParsedAssistantMessage | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }

  if (obj.type !== 'assistant') return null

  const message = obj.message as Record<string, unknown> | undefined
  if (!message || message.role !== 'assistant') return null

  const usage = message.usage as Record<string, unknown> | undefined
  if (!usage) return null

  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheCreation = num(usage.cache_creation_input_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const total = input + output + cacheCreation + cacheRead
  if (total <= 0) return null

  const cwd = str(obj.cwd)
  if (!cwd) return null

  const gitBranchRaw = str(obj.gitBranch)
  const gitBranch = gitBranchRaw && gitBranchRaw !== 'HEAD' ? gitBranchRaw : null

  return {
    cwd,
    gitBranch,
    sessionId: str(obj.sessionId),
    uuid: str(obj.uuid),
    timestamp: str(obj.timestamp) || new Date().toISOString(),
    model: str(message.model) || 'unknown',
    apiMessageId: str(message.id),
    stopReason: parseStopReason(message.stop_reason),
    tokens: { input, output, cacheCreation, cacheRead, total }
  }
}

/**
 * v2.11.1 Claude Code transcript 里的「一轮真正结束」信号。
 *
 * Claude Code 新版本下,LLM 经常以 MCP tool 调用收尾(最后一条 assistant 的 stop_reason
 * 始终是 `tool_use`),v2.6.0 watcher 按 terminal stop_reason 判定的 flush 时机永远不触发。
 * 解决方案:把 `type=system subtype=stop_hook_summary` 这条 Claude Code 在每轮 Stop Hook
 * 跑完后必写的系统行作为补充 flush 触发器。
 *
 * Stop Hook 跑完触发的 system 行实测带有与 assistant 行同源的 `cwd`/`gitBranch`/`sessionId`/
 * `uuid`/`timestamp` 字段,routeStopHookSummary 据此找到同 sessionId 的 turnBuffer 主动 flush。
 */
export interface ParsedStopHookSummary {
  cwd: string
  gitBranch: string | null
  sessionId: string
  uuid: string
  timestamp: string
}

/**
 * v2.12.0 Claude Code transcript 里的「本轮用户 prompt」信号。
 *
 * Claude Code 每轮对话开头会写入一条 `type=user` 行,带 ISO timestamp + sessionId + cwd。
 * watcher 据此把「用户提交 prompt 到 AI 完成响应」作为本轮真实 turn 时长(`thinkSeconds`),
 * 不再用「上一轮 iteration 落盘 → 本轮落盘」的近似口径(会被用户阅读/输入时间污染)。
 *
 * 注意:Claude Code 偶尔会注入 tool_result 等 user-role 中间行,这些不算用户新 prompt,
 * 但 watcher 端用「最近一次 user 行 timestamp」作为本轮起点,即使误命中 tool_result,
 * 也只是把起点稍微推后,不会反向虚高数字。本解析器不在 message.content 上做更细分。
 */
export interface ParsedUserMessage {
  cwd: string
  gitBranch: string | null
  sessionId: string
  uuid: string
  timestamp: string
}

export function parseClaudeUserMessage(raw: string): ParsedUserMessage | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }

  if (obj.type !== 'user') return null

  const message = obj.message as Record<string, unknown> | undefined
  if (!message || message.role !== 'user') return null

  const cwd = str(obj.cwd)
  if (!cwd) return null

  const gitBranchRaw = str(obj.gitBranch)
  const gitBranch = gitBranchRaw && gitBranchRaw !== 'HEAD' ? gitBranchRaw : null

  return {
    cwd,
    gitBranch,
    sessionId: str(obj.sessionId),
    uuid: str(obj.uuid),
    timestamp: str(obj.timestamp) || new Date().toISOString()
  }
}

export function parseClaudeStopHookSummary(raw: string): ParsedStopHookSummary | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }

  if (obj.type !== 'system') return null
  if (obj.subtype !== 'stop_hook_summary') return null

  const cwd = str(obj.cwd)
  if (!cwd) return null

  const gitBranchRaw = str(obj.gitBranch)
  const gitBranch = gitBranchRaw && gitBranchRaw !== 'HEAD' ? gitBranchRaw : null

  return {
    cwd,
    gitBranch,
    sessionId: str(obj.sessionId),
    uuid: str(obj.uuid),
    timestamp: str(obj.timestamp) || new Date().toISOString()
  }
}
