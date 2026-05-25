import { readFileSync } from 'node:fs'

import { loadAgentEndpoint } from './lib/agent-client.js'
import { gcSentinels, readRecentAttachSentinel, RECENT_ATTACH_WINDOW_MS } from './lib/sentinel.js'
import { isRequirementInitialized, resolveTrackingContext } from './lib/tracking-context.js'

/**
 * v2.10.0 Cursor stop / Claude Code Stop Hook 入口.
 *
 * 流程:
 *   1. 读 stdin 解析 stop hook payload(Cursor / Claude Code 各自字段)
 *   2. abort 过滤(v1.0.0-rc.11):Cursor `status` ∈ {aborted, error} → 立即静默放行,
 *      用户手动中断 ESC / API error 都不再被 followup_message 打扰.
 *      Claude Code Stop hook 文档明确 "do not fire on user interrupts",这里仅为对称兜底.
 *   3. 前置三连:分支含 issueKey、需求已 init、agent 可达;任一不满足 → 静默 exit 0 放行
 *   4. loop 防御:cursor.loop_count >= 1 或 claude.stop_hook_active === true → 放行(避免死循环)
 *   5. 查 jiraKey 维度的 recent-attach sentinel:
 *      - 文件存在且 `now - calledAt < RECENT_ATTACH_WINDOW_MS` → 放行(本轮真调过 attach_summary)
 *      - 缺失 / 超窗 → 输出方言化的 followup_message / decision:block,让 LLM 在下一轮被强制补一次
 *
 * v2.10.0 设计变更:
 *   - 老的 conv-gen 维度 sentinel(由 Cursor afterMCPExecution Hook 异步写)依赖 fire-and-forget
 *     时序与 tool_name 字段精确匹配,实测 ~/.truesight-local-agent/hook-state/ 长期为空
 *     → stop-check 永远走 inject_followup → 一次对话被强制重答两次 + 5-6 秒延迟.
 *   - 改为 agent attach-summary handler 同进程同步写 jiraKey 维度 sentinel.
 *     attach_summary HTTP 返回前 sentinel 必定落盘,stop-check 读取无 race.
 *   - 老的 `mark-tool-called` hook 已下线,argv-router 保留静默兼容防止旧 hooks.json 报错.
 *
 * 任何异常一律 fail-open: 不输出任何阻塞响应,不抛错.
 */

export const FOLLOWUP_REASON = [
  '[ai-productivity 防伪造校验] 本轮未通过 MCP 工具调用 ai_productivity_attach_summary。',
  '请立即调用一次 ai_productivity_attach_summary',
  '(oneLine + type + changeScope/discussion);调用成功后直接结束本轮,',
  '不要在答复中输出任何"已上报""总结已上报""该对话已总结上报"之类的提示文字,也不要重复总结内容。'
].join(' ')

export interface StopCheckOptions {
  /** 注入 stdin(测试用) */
  stdin?: string
  /**
   * 注入 agent endpoint(测试用).
   * - undefined: 走 loadAgentEndpoint() 默认逻辑
   * - null: 显式标记 agent 不可达 → 前置失败放行
   * - { baseUrl, token }: 仍会跑 ping 校验,除非 skipAgentReachability=true
   */
  agentEndpoint?: { baseUrl: string; token: string } | null
  /** 注入 fetch(测试用) */
  fetchImpl?: typeof fetch
  /** 测试时跳过 agent 可达性检测(直接视为可达) */
  skipAgentReachability?: boolean
  /** 注入 ~/.truesight-local-agent 根目录(测试用) */
  agentRootOverride?: string
  /** 注入当前时间(测试用,默认 Date.now()) */
  now?: () => number
}

export type StopDialect = 'cursor' | 'claude-code'

export type StopOutcomeKind =
  | 'skipped_no_stdin'
  | 'skipped_parse_failed'
  | 'skipped_aborted'
  | 'skipped_no_issue_key'
  | 'skipped_requirement_missing'
  | 'skipped_agent_unreachable'
  | 'skipped_loop_guard'
  | 'allowed_recent_attach'
  | 'inject_followup'

export interface StopCheckOutcome {
  kind: StopOutcomeKind
  dialect: StopDialect | null
  /** 写到 stdout 的 JSON 字符串;skipped/allowed 时为 null */
  output: string | null
}

function readStdinSync(): string {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function tryParse(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function detectDialect(parsed: Record<string, unknown>): StopDialect {
  if (typeof parsed.cursor_version === 'string' && parsed.cursor_version) return 'cursor'
  if (typeof parsed.stop_hook_active === 'boolean') return 'claude-code'
  // Claude Code Stop hook payload 可能没有 cursor_version 但有 session_id / transcript_path;
  // 兜底按 session_id 字段断定
  if (typeof parsed.session_id === 'string' && !('cursor_version' in parsed)) return 'claude-code'
  // 默认按 cursor(loop_count 字段也是 cursor 独有的)
  return 'cursor'
}

/**
 * v1.0.0-rc.11: Cursor `stop` hook 在用户手动中断(ESC / Cancel)时也会触发,
 * payload `status` 字段会传 `'aborted'` / `'error'` / `'completed'` 三选一.
 *
 * - 用户中断后我们若仍输出 followup_message,Cursor 会自动 submit 这条消息当作下一轮 user prompt,
 *   LLM 被强制重新答复,直接违背用户中断意图,体验极差.
 * - 因此 abort/error 一律静默放行,把 stop-check 的存在感降为零.
 *
 * Claude Code Stop hook 文档明确 "do not fire on user interrupts",理论上不会在中断时触发,
 * 此处仅为方言对称,future-proof 防止官方未来加 UserInterrupt 之类的 hook 时回归.
 *
 * 兼容:`status` 字段缺失(老 Cursor / 测试 fixture)按 `'completed'` 处理,**不**判定为 abort,
 * 原有 sentinel 校验逻辑全保留,不会让"中断"和"老版本"混淆.
 */
function isAbortedStop(parsed: Record<string, unknown>, dialect: StopDialect): boolean {
  const status = typeof parsed.status === 'string' ? parsed.status : ''
  if (dialect === 'cursor') {
    return status === 'aborted' || status === 'error'
  }
  // Claude Code Stop hook payload 目前不含 status 字段;若未来添加,
  // 保持与 Cursor 同语义 abort/error 静默放行.
  return status === 'aborted' || status === 'error'
}

function hitLoopGuard(parsed: Record<string, unknown>, dialect: StopDialect): boolean {
  if (dialect === 'cursor') {
    const lc = typeof parsed.loop_count === 'number' ? parsed.loop_count : 0
    // loop_count=0 是首次,允许注入;>=1 表示我们已经注入过一次了,继续放行避免死循环
    return lc >= 1
  }
  // Claude Code: stop_hook_active=true 时表示 Stop 已经被 block 过一次,需放行
  return parsed.stop_hook_active === true
}

function buildOutput(dialect: StopDialect): string {
  if (dialect === 'cursor') {
    return JSON.stringify({ followup_message: FOLLOWUP_REASON })
  }
  return JSON.stringify({ decision: 'block', reason: FOLLOWUP_REASON })
}

async function pingAgent(
  endpoint: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch,
  timeoutMs = 800
): Promise<boolean> {
  if (!endpoint) return false
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, '')}/status`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        Accept: 'application/json'
      },
      signal: ctrl.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/**
 * 解析 stop hook 输入,跑前置三连 + loop 防御 + recent-attach sentinel 检查,返回结构化结果.
 * 不会主动写 stdout;调用方根据 outcome.output 决定是否打印.
 */
export async function runStopCheck(opts: StopCheckOptions = {}): Promise<StopCheckOutcome> {
  // GC 一次旧 sentinel(包括老的 conv-gen + 新的 jiraKey 文件),失败不影响主流程
  try {
    gcSentinels(opts.agentRootOverride)
  } catch {
    /* ignore */
  }

  const raw = opts.stdin ?? readStdinSync()
  const parsed = tryParse(raw)
  if (!parsed) {
    return { kind: raw ? 'skipped_parse_failed' : 'skipped_no_stdin', dialect: null, output: null }
  }

  const dialect = detectDialect(parsed)

  if (isAbortedStop(parsed, dialect)) {
    return { kind: 'skipped_aborted', dialect, output: null }
  }

  const ctx = resolveTrackingContext(parsed)
  if (!ctx) {
    return { kind: 'skipped_no_issue_key', dialect, output: null }
  }
  if (!isRequirementInitialized(ctx.issueKey, opts.agentRootOverride)) {
    return { kind: 'skipped_requirement_missing', dialect, output: null }
  }

  if (!opts.skipAgentReachability) {
    const endpoint = opts.agentEndpoint === undefined ? loadAgentEndpoint() : opts.agentEndpoint
    const fetchImpl = opts.fetchImpl ?? fetch
    const ok = await pingAgent(endpoint, fetchImpl)
    if (!ok) return { kind: 'skipped_agent_unreachable', dialect, output: null }
  }

  if (hitLoopGuard(parsed, dialect)) {
    return { kind: 'skipped_loop_guard', dialect, output: null }
  }

  const sentinel = readRecentAttachSentinel(ctx.issueKey, opts.agentRootOverride)
  if (sentinel) {
    const calledAtMs = Date.parse(sentinel.calledAt)
    const nowMs = opts.now ? opts.now() : Date.now()
    if (Number.isFinite(calledAtMs) && nowMs - calledAtMs < RECENT_ATTACH_WINDOW_MS) {
      return { kind: 'allowed_recent_attach', dialect, output: null }
    }
  }

  return { kind: 'inject_followup', dialect, output: buildOutput(dialect) }
}

/** CLI 入口:解析 stdin → 跑校验 → 必要时 print 到 stdout.异常一律 fail-open. */
export async function runStopCheckCli(opts: StopCheckOptions = {}): Promise<void> {
  try {
    const outcome = await runStopCheck(opts)
    if (outcome.output) {
      process.stdout.write(outcome.output + '\n')
    }
  } catch {
    // 完全静默,不打断 stop
  }
}
