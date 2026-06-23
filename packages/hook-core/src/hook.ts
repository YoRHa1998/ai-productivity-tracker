import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { cwd } from 'node:process'

import { findAipDir, bindingsPath } from './lib/paths.js'
import { withBindingsLock, type BindingsFile } from './lib/files.js'
import { extractIssueKey, getCurrentBranch } from './lib/git.js'
import {
  postHookToAgent,
  postTurnStartToAgent,
  postTurnThoughtToAgent,
  type AgentSimpleResult,
  type AgentTurnThoughtResult
} from './lib/agent-client.js'

function readStdinSync(): string {
  // Cursor / Claude 都是 spawn 子进程,stdin 是 pipe;同步读取直到 EOF
  // 如果 IDE 不传 stdin,这里 fd 0 直接 EOF,readFileSync 返回空串
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

export interface HookInput {
  // Cursor 3.3.30 实测字段(snake_case)
  conversation_id?: string
  generation_id?: string
  session_id?: string
  hook_event_name?: string
  cursor_version?: string
  workspace_roots?: string[]
  user_email?: string | null
  transcript_path?: string | null
  text?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  /**
   * v1.0.0-rc.18 Cursor `afterAgentThought` 专属字段:本次 thinking 块的累计时长。
   * 由 daemon 在 cursorTurnStarts Map 上对应 entry 累加,afterAgentResponse 消费时折算秒。
   */
  duration_ms?: number

  // Claude Code / 历史 hook / 自定义集成兜底字段
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    prompt_tokens?: number
    completion_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/**
 * 计算本回合应当累加到 cumulativeToken 的总 token 数。
 *
 * v2.7.1 口径修复:与 Claude Code transcript-watcher 的 `effectiveTokens` 对齐 ──
 * 排除 `cache_read`(cache 命中部分),保留 `cache_creation`。
 *
 * 背景:Cursor 3.3.30 实测 `input_tokens` 是「总 input」,且 `cache_read + cache_write ≈ input_tokens`,
 * 即 cache 字段是 input 内部的细分而非额外项。但 cache_read 在 Anthropic 计费维度上仅 0.1x 价格,
 * 且大上下文对话里同一 prompt 会被反复 cache 命中,直接累加会让单轮 token 虚高 5~10 倍。
 * 改为 `(input_tokens - cache_read_tokens) + output_tokens`,等价于 Claude Code 的
 * `input + output + cache_creation` 口径,跨 IDE 数字可横向比较。
 */
export function parseHookTokens(parsed: HookInput): number {
  // 1) Cursor 3.3.30 snake_case (Phase 3.0 探针实测)
  if (typeof parsed.input_tokens === 'number' || typeof parsed.output_tokens === 'number') {
    const cacheRead = Math.max(0, parsed.cache_read_tokens ?? 0)
    const effectiveInput = Math.max(0, (parsed.input_tokens ?? 0) - cacheRead)
    const output = Math.max(0, parsed.output_tokens ?? 0)
    return effectiveInput + output
  }
  // 2) 历史显式 totals
  if (typeof parsed.tokens === 'number') return Math.max(0, parsed.tokens)
  if (typeof parsed.totalTokens === 'number') return Math.max(0, parsed.totalTokens)
  // 3) Claude Code message.usage 嵌套 (transcript-watcher 也走相同口径)
  if (parsed.usage) {
    const u = parsed.usage
    if (typeof u.total_tokens === 'number') return Math.max(0, u.total_tokens)
    const cacheRead = Math.max(0, u.cache_read_input_tokens ?? 0)
    const effectiveInput = Math.max(0, (u.input_tokens ?? 0) - cacheRead)
    const output = Math.max(0, u.output_tokens ?? 0)
    const inOut = effectiveInput + output
    if (inOut > 0) return inOut
    const promptCompletion = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)
    if (promptCompletion > 0) return promptCompletion
  }
  // 4) camelCase 兜底
  const total = (parsed.inputTokens ?? 0) + (parsed.outputTokens ?? 0)
  if (total > 0) return total
  const legacy = (parsed.promptTokens ?? 0) + (parsed.completionTokens ?? 0)
  return legacy
}

export function buildDedupeKey(parsed: HookInput | null): string | undefined {
  if (!parsed) return undefined
  const conv = parsed.conversation_id || parsed.session_id
  const gen = parsed.generation_id
  if (conv && gen) return `${conv}#${gen}`
  if (conv) return `${conv}#${parsed.hook_event_name ?? 'hook'}`
  return undefined
}

export function tryParseHookInput(raw: string): HookInput | null {
  if (!raw.trim()) return null
  try {
    return JSON.parse(raw) as HookInput
  } catch {
    return null
  }
}

/**
 * 解析项目根目录。Cursor user hook 的 cwd 是 ~/.cursor/,不是项目根,
 * 必须按下面优先级查找含 .ai-productivity/ 的真实项目目录:
 *   1) Cursor 注入的 CURSOR_PROJECT_DIR / CLAUDE_PROJECT_DIR 环境变量(老约定)
 *   2) WORKSPACE_FOLDER_PATHS(v2.7.3 兜底,Cursor IDE 拉起 MCP/Hook 时实测注入,
 *      ':' 或 ';' 分隔的多工作区取首项)
 *   3) stdin JSON 里的 workspace_roots[] 数组(Cursor 官方 hook payload schema)
 *   4) cwd()(Claude Code 路径会落在项目根)
 */
export function resolveProjectRoot(input: HookInput | null): string | null {
  const candidates: string[] = []

  const env = process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR
  if (env) candidates.push(env)

  const workspaces = process.env.WORKSPACE_FOLDER_PATHS
  if (workspaces && workspaces.trim()) {
    // 仅按 ':' 切分(与 PATH 同款,Linux/macOS path-style),
    // Windows 多工作区留给将来,不在本期范围
    for (const segment of workspaces.split(':')) {
      const trimmed = segment.trim()
      if (trimmed) candidates.push(trimmed)
    }
  }

  if (input?.workspace_roots && Array.isArray(input.workspace_roots)) {
    for (const root of input.workspace_roots) {
      if (typeof root === 'string' && root) candidates.push(root)
    }
  }

  candidates.push(cwd())

  for (const candidate of candidates) {
    const aipDir = findAipDir(candidate)
    if (aipDir) return candidate
  }
  return null
}

function describeSimpleResult(label: string, result: AgentSimpleResult): string {
  if (result.kind === 'ok') return `${label}.ok`
  if (result.kind === 'unconfigured') return `${label}.fallback(agent-unconfigured)`
  if (result.kind === 'http-error') {
    return `${label}.fallback(http-${result.status}: ${result.message.slice(0, 80)})`
  }
  return `${label}.fallback(${result.kind}: ${result.message.slice(0, 80)})`
}

/**
 * turn-thought 专属:200 happy path 上区分 `applied` / `no_pending_turn`。
 * 关键观测点 —— `turn-thought.ok(dropped:no_pending_turn)` 即代表本块 thinking 被
 * afterAgentResponse 抢先 consume 后丢弃,是跨进程竞态的直接证据。
 */
function describeTurnThoughtResult(result: AgentTurnThoughtResult): string {
  if (result.kind === 'ok') {
    return result.applied
      ? `turn-thought.ok(applied totalMs=${result.totalMs ?? '?'})`
      : `turn-thought.ok(dropped:${result.reason ?? 'unknown'})`
  }
  if (result.kind === 'unconfigured') return 'turn-thought.fallback(agent-unconfigured)'
  if (result.kind === 'http-error') {
    return `turn-thought.fallback(http-${result.status}: ${result.message.slice(0, 80)})`
  }
  return `turn-thought.fallback(${result.kind}: ${result.message.slice(0, 80)})`
}

function detectSource(input: HookInput | null): string {
  if (input?.cursor_version) return 'cursor-hook'
  if (input?.hook_event_name === 'Stop' || input?.hook_event_name === 'stop') return 'claude-hook'
  return 'unknown-hook'
}

/**
 * v1.0.0-rc.18 hook 事件路由:由 Cursor `hook_event_name` 决定走哪条 daemon 子路径。
 *
 * - `beforeSubmitPrompt` / `UserPromptSubmit` → `/ai-productivity/turn-start`(记录本轮起点)
 * - `afterAgentThought` / `AgentThought` → `/ai-productivity/turn-thought`(累加 thinking 时长)
 * - 其它(含未指定 / afterAgentResponse / Stop) → 既有 `/ai-productivity/hook` 路径
 *
 * 备注:Cursor docs 描述这两类事件用 `beforeSubmitPrompt` / `afterAgentThought`;
 * Claude Code 命名映射到 Cursor 时是 `UserPromptSubmit` / `AgentThought`,daemon 全部接受。
 */
export type HookEventRoute = 'turn-start' | 'turn-thought' | 'iteration'

export function classifyHookEvent(event: string | undefined | null): HookEventRoute {
  if (!event) return 'iteration'
  if (event === 'beforeSubmitPrompt' || event === 'UserPromptSubmit') return 'turn-start'
  if (event === 'afterAgentThought' || event === 'AgentThought') return 'turn-thought'
  return 'iteration'
}

/**
 * 构造透传给 agent /ai-productivity/hook 的 rawHookPayload。
 * 关键约定:
 *   - 仅传 text_length 不传 text 全文,避免对话内容入库
 *   - cache_read/write_tokens 已含在 input_tokens 内,但仍透传到 rawPayload 便于审计
 */
export function buildRawHookPayload(parsed: HookInput | null): Record<string, unknown> | undefined {
  if (!parsed) return undefined
  return {
    model: parsed.model,
    conversation_id: parsed.conversation_id,
    generation_id: parsed.generation_id,
    cursor_version: parsed.cursor_version,
    input_tokens: parsed.input_tokens,
    output_tokens: parsed.output_tokens,
    cache_read_tokens: parsed.cache_read_tokens,
    cache_write_tokens: parsed.cache_write_tokens,
    transcript_path: parsed.transcript_path,
    text_length: typeof parsed.text === 'string' ? parsed.text.length : 0
  }
}

/**
 * DEBUG 模式下无条件写入 sentinel,用于回答"hook 到底有没有触发"。
 * 不依赖 .ai-productivity 目录(后者依赖 cwd 解析,排查 bug 时不可信)。
 */
function writeSentinelIfDebug(
  raw: string,
  parsed: HookInput | null,
  projectRoot: string | null,
  parsedTokens: number
) {
  if (process.env.AI_PRODUCTIVITY_DEBUG_HOOK !== '1') return
  const sentinelPath = resolve(homedir(), '.ai-productivity-hook-fired.log')
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    cwd: cwd(),
    env: {
      CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR ?? null,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
      CURSOR_TRANSCRIPT_PATH: process.env.CURSOR_TRANSCRIPT_PATH ?? null,
      CURSOR_VERSION: process.env.CURSOR_VERSION ?? null
    },
    resolvedProjectRoot: projectRoot,
    stdinLen: raw.length,
    stdinIsJson: parsed !== null,
    parsedKeys: parsed ? Object.keys(parsed) : [],
    hookEvent: parsed?.hook_event_name ?? null,
    transcriptPath: parsed?.transcript_path ?? null,
    workspaceRoots: parsed?.workspace_roots ?? null,
    parsedTokens,
    stdinHead: raw.length > 0 ? raw.slice(0, 2000) : ''
  }
  try {
    appendFileSync(sentinelPath, JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // 静默失败
  }
  try {
    process.stderr.write(`[ai-productivity hook-debug] sentinel ${sentinelPath} updated\n`)
  } catch {
    // 静默失败
  }
}

function writeDebugLog(aipDir: string, record: Record<string, unknown>) {
  if (process.env.AI_PRODUCTIVITY_DEBUG_HOOK !== '1') return
  try {
    appendFileSync(resolve(aipDir, 'hook-debug.log'), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // 静默失败,不干扰 IDE 主流程
  }
  try {
    const summary = {
      at: record.at,
      branch: record.branch,
      issueKey: record.issueKey,
      parsedTokens: record.parsedTokens,
      route: record.route
    }
    process.stderr.write(`[ai-productivity hook-debug] ${JSON.stringify(summary)}\n`)
  } catch {
    // 静默失败
  }
}

function fallbackWriteToBindings(
  aipDir: string,
  branch: string,
  issueKey: string,
  tokens: number,
  now: string
): void {
  withBindingsLock(bindingsPath(aipDir), (current): BindingsFile => {
    const binding = current.bindings[issueKey]
    if (binding) {
      return {
        ...current,
        bindings: {
          ...current.bindings,
          [issueKey]: {
            ...binding,
            cumulativeToken: binding.cumulativeToken + tokens,
            branch
          }
        }
      }
    }
    const pending = current.pending[issueKey]
    return {
      ...current,
      pending: {
        ...current.pending,
        [issueKey]: {
          branch,
          firstSeenAt: pending?.firstSeenAt ?? now,
          cumulativeToken: (pending?.cumulativeToken ?? 0) + tokens
        }
      }
    }
  })
}

export async function runHook() {
  const rawStdin = readStdinSync()
  const parsedInput = tryParseHookInput(rawStdin)
  const projectRoot = resolveProjectRoot(parsedInput)
  const tokens = parsedInput ? parseHookTokens(parsedInput) : 0
  const dedupeKey = buildDedupeKey(parsedInput)
  const source = detectSource(parsedInput)
  const eventRoute = classifyHookEvent(parsedInput?.hook_event_name)

  // 无论后续走哪条路径,先写 sentinel 证明 hook 到达过
  writeSentinelIfDebug(rawStdin, parsedInput, projectRoot, tokens)

  // 没找到项目根 → 该 IDE 当前会话不在被追踪仓库。
  //
  // AI 整体用量旁路(D3):静默退出**之前**,若是带 token 的 iteration 事件(afterAgentResponse /
  // Stop),仍向 daemon 上报一条「最小化用量信号」(usageOnly:true,只带 source/tokens/model/
  // sessionId,**不带正文 / 需求上下文**),供整体用量采集覆盖非仓库会话。
  // 上报容错静默:daemon 不可达 / 失败一律吞掉,绝不影响 hook 退出码与既有需求链路。
  if (!projectRoot) {
    if (eventRoute === 'iteration' && tokens > 0) {
      try {
        await postHookToAgent({
          tokens,
          source,
          dedupeKey,
          rawHookPayload: buildRawHookPayload(parsedInput),
          usageOnly: true
        })
      } catch {
        /* 整体用量上报失败不影响 hook 主流程 */
      }
    }
    return
  }

  const aipDir = findAipDir(projectRoot)
  if (!aipDir) return

  const branch = getCurrentBranch(projectRoot)
  const issueKey = branch ? extractIssueKey(branch) : null
  const now = new Date().toISOString()

  // v1.0.0-rc.18 turn-start / turn-thought 子路径:仅刷新内存 Map,不涉及 token 累加 / iteration 写盘。
  // 失败一律 fail-open(老 daemon 没该端点会返 404 / 网络异常 / 鉴权失败),debug 模式下落 hook-debug.log。
  if (eventRoute === 'turn-start') {
    const conversationId = parsedInput?.conversation_id ?? ''
    const generationId = parsedInput?.generation_id ?? ''
    let routeOutcome = 'turn-start.skipped(missing-ids)'
    if (conversationId && generationId) {
      const result = await postTurnStartToAgent({
        projectRoot,
        conversationId,
        generationId
      })
      routeOutcome = describeSimpleResult('turn-start', result)
    }
    writeDebugLog(aipDir, {
      at: now,
      cwd: cwd(),
      projectRoot,
      branch,
      issueKey,
      source,
      route: routeOutcome,
      hookEvent: parsedInput?.hook_event_name ?? null,
      parsedKeys: parsedInput ? Object.keys(parsedInput) : []
    })
    return
  }

  if (eventRoute === 'turn-thought') {
    const conversationId = parsedInput?.conversation_id ?? ''
    const generationId = parsedInput?.generation_id ?? ''
    const durationMs =
      typeof parsedInput?.duration_ms === 'number' && parsedInput.duration_ms >= 0
        ? parsedInput.duration_ms
        : 0
    let routeOutcome = 'turn-thought.skipped(missing-ids)'
    let applied: boolean | null = null
    let totalMs: number | null = null
    let reason: string | null = null
    if (conversationId && generationId) {
      const result = await postTurnThoughtToAgent({
        conversationId,
        generationId,
        durationMs
      })
      routeOutcome = describeTurnThoughtResult(result)
      if (result.kind === 'ok') {
        applied = result.applied
        totalMs = result.totalMs ?? null
        reason = result.reason ?? null
      }
    }
    writeDebugLog(aipDir, {
      at: now,
      cwd: cwd(),
      projectRoot,
      branch,
      issueKey,
      source,
      route: routeOutcome,
      hookEvent: parsedInput?.hook_event_name ?? null,
      conversationId,
      generationId,
      durationMs,
      applied,
      totalMs,
      reason
    })
    return
  }

  // 主路径: 调本机 agent /ai-productivity/hook,由 agent 统一处理 dedupe + bindings + iteration
  const agentResult = await postHookToAgent({
    projectRoot,
    branch: branch ?? undefined,
    tokens,
    source,
    dedupeKey,
    rawHookPayload: buildRawHookPayload(parsedInput)
  })

  // 兜底路径: agent 不可达 / 失败 → 只要分支含 issueKey 且本轮有 token 就直写本地 bindings.json,
  // 与历史 CLI 行为一致;v2 之后不再依赖老 platformBaseUrl/apiToken 配置作为开关。
  let route: string
  if (agentResult.kind === 'ok') {
    route = `agent.ok(${agentResult.data.deduped ? 'deduped' : agentResult.data.bound ? 'bound' : 'pending'})`
  } else if (agentResult.kind === 'unconfigured') {
    route = 'fallback.local(agent-unconfigured)'
    if (branch && issueKey && tokens > 0) {
      fallbackWriteToBindings(aipDir, branch, issueKey, tokens, now)
    }
  } else {
    route = `fallback.local(${agentResult.kind}: ${'message' in agentResult ? agentResult.message.slice(0, 80) : ''})`
    if (branch && issueKey && tokens > 0) {
      fallbackWriteToBindings(aipDir, branch, issueKey, tokens, now)
    }
  }

  writeDebugLog(aipDir, {
    at: now,
    cwd: cwd(),
    projectRoot,
    branch,
    issueKey,
    parsedTokens: tokens,
    dedupeKey,
    source,
    route,
    hookEvent: parsedInput?.hook_event_name ?? null,
    parsedKeys: parsedInput ? Object.keys(parsedInput) : [],
    transcriptPath: parsedInput?.transcript_path ?? null,
    agentResponse: agentResult.kind === 'ok' ? agentResult.data : null,
    stdin: rawStdin.length > 8000 ? `${rawStdin.slice(0, 8000)}...(truncated)` : rawStdin
  })
}
