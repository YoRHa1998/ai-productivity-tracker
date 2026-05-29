import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_AGENT_BASE = 'http://127.0.0.1:17350'
/** v1.0 起 daemon 运行态写在 runtime.json,与 config.json (用户配置) 分离 */
export const AGENT_CONFIG_PATH = join(homedir(), '.ai-productivity-tracker', 'runtime.json')

interface AgentConfigShape {
  token?: string
  port?: number
}

/**
 * 读 ai-productivity-tracker daemon 的 runtime.json 拿:
 *   - Bearer token (鉴权)
 *   - port (默认 17350)
 *
 * 优先级:
 *   1) 环境变量 AIPT_DAEMON_TOKEN / AIPT_DAEMON_URL
 *   2) ~/.ai-productivity-tracker/runtime.json
 *
 * 找不到 token 时返回 null,调用方应当回退到本地 bindings.json 直写路径。
 */
export function loadAgentEndpoint(
  configFilePath: string = AGENT_CONFIG_PATH
): { baseUrl: string; token: string } | null {
  // 1) env(优先)
  const envToken = process.env.AIPT_DAEMON_TOKEN
  const envBase = process.env.AIPT_DAEMON_URL
  if (envToken && envBase) {
    return { baseUrl: envBase.replace(/\/$/, ''), token: envToken }
  }

  // 2) runtime.json
  const fromFile = tryReadEndpointFile(configFilePath, envToken, envBase)
  if (fromFile) return fromFile

  return envToken
    ? { baseUrl: envBase?.replace(/\/$/, '') ?? DEFAULT_AGENT_BASE, token: envToken }
    : null
}

function tryReadEndpointFile(
  filePath: string,
  envToken: string | undefined,
  envBase: string | undefined
): { baseUrl: string; token: string } | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as AgentConfigShape
    const token = envToken || parsed.token
    if (!token) return null
    const port = parsed.port ?? 17350
    const baseUrl = envBase?.replace(/\/$/, '') ?? `http://127.0.0.1:${port}`
    return { baseUrl, token }
  } catch {
    return null
  }
}

export interface AgentHookPayload {
  projectRoot?: string
  branch?: string
  tokens: number
  source: string
  dedupeKey?: string
  rawHookPayload?: Record<string, unknown>
}

/**
 * v1.0.0-rc.18 Cursor `beforeSubmitPrompt` 触发时上报本轮起点。
 *
 * 字段约束:`conversationId` + `generationId` 必须非空,daemon 用拼接键存进
 * cursorTurnStarts Map;projectRoot 仅用于诊断日志,daemon 不强校验。
 */
export interface AgentTurnStartPayload {
  projectRoot?: string
  conversationId: string
  generationId: string
}

/**
 * v1.0.0-rc.18 Cursor `afterAgentThought` 触发时上报本块 thinking 时长。
 *
 * daemon 在 cursorTurnStarts Map 内对应 entry.thoughtDurationMs 累加;entry 不存在
 * (e.g. daemon 刚重启错过 beforeSubmitPrompt)时 no-op,返回 200。
 */
export interface AgentTurnThoughtPayload {
  conversationId: string
  generationId: string
  durationMs: number
}

export interface AgentHookResponse {
  ok: true
  deduped: boolean
  bound: boolean
  accumulated: number
  cumulativeToken?: number
  jiraKey?: string
  iterationSeq?: number
  reason?: string
}

export type AgentHookResult =
  | { kind: 'ok'; data: AgentHookResponse }
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'network-error'; message: string }
  | { kind: 'unconfigured' }

/**
 * v1.0.0-rc.18 turn-start / turn-thought 端点的统一返回类型。
 * happy path 仅返 200,不带额外数据;失败语义与 AgentHookResult 同款。
 */
export type AgentSimpleResult =
  | { kind: 'ok' }
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'network-error'; message: string }
  | { kind: 'unconfigured' }

/** daemon turn-thought 端点 envelope.data 形状(与 server TurnThoughtResponse 对齐) */
export interface AgentTurnThoughtResponse {
  ok: true
  applied: boolean
  totalMs?: number
  reason?: string
}

/**
 * turn-thought 专属结果:在 200 happy path 上额外携带 `applied`/`totalMs`/`reason`。
 *
 * 背景:通用 `postJsonToAgent` 对任意 200 都只返 `{kind:'ok'}`,丢掉了 body 里的
 * `applied=false / reason='no_pending_turn'`(afterAgentResponse 抢先 consume 删 entry 导致
 * thinking 累加丢失的关键信号)。turn-thought 单独解析 body,让 hook-debug.log 能区分
 * 「真累加成功」与「命中 no_pending_turn 被丢」,用于坐实跨进程竞态。
 */
export type AgentTurnThoughtResult =
  | { kind: 'ok'; applied: boolean; totalMs?: number; reason?: string }
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'network-error'; message: string }
  | { kind: 'unconfigured' }

/** 调 agent /ai-productivity/hook;失败有完整可观测的 result.kind,调用方据此降级 */
export async function postHookToAgent(
  payload: AgentHookPayload,
  endpoint: { baseUrl: string; token: string } | null = loadAgentEndpoint(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<AgentHookResult> {
  if (!endpoint) return { kind: 'unconfigured' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${endpoint.baseUrl}/ai-productivity/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`,
        Accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { kind: 'http-error', status: res.status, message: text.slice(0, 500) }
    }
    const json = (await res.json()) as { code?: string; data?: AgentHookResponse; message?: string }
    if (json.code === 'OK' && json.data) {
      return { kind: 'ok', data: json.data }
    }
    return {
      kind: 'http-error',
      status: res.status,
      message: json.message ?? 'agent 返回非 OK envelope'
    }
  } catch (err) {
    return { kind: 'network-error', message: (err as Error).message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * v1.0.0-rc.18 提交 turn-start / turn-thought 的通用 POST 帮手。失败均归到
 * AgentSimpleResult,调用方仅在 stderr 输出诊断,不阻塞 IDE。
 */
async function postJsonToAgent(
  path: string,
  body: unknown,
  endpoint: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<AgentSimpleResult> {
  if (!endpoint) return { kind: 'unconfigured' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`,
        Accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { kind: 'http-error', status: res.status, message: text.slice(0, 500) }
    }
    return { kind: 'ok' }
  } catch (err) {
    return { kind: 'network-error', message: (err as Error).message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * v2.15.0 per-turn 经验沉淀兜底:stop-check 查"最新一条已 flush 非 init iteration 是否强候选"。
 *
 * daemon 端算信号(GET /ai-productivity/requirements/:jiraKey/latest-candidate),
 * 避免 hook 单文件直接 import core store。fail-open:任何失败都让调用方当作「无候选」。
 */
export interface LatestCandidateResponse {
  /** 最新一条非 init iteration 的 seq;无任何非 init iteration 时为 null */
  seq: number | null
  strongCandidate: boolean
  reasons: string[]
}

export type LatestCandidateResult =
  | { kind: 'ok'; data: LatestCandidateResponse }
  | { kind: 'http-error'; status: number; message: string }
  | { kind: 'network-error'; message: string }
  | { kind: 'unconfigured' }

export async function fetchLatestCandidate(
  jiraKey: string,
  endpoint: { baseUrl: string; token: string } | null = loadAgentEndpoint(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<LatestCandidateResult> {
  if (!endpoint) return { kind: 'unconfigured' }
  const safe = encodeURIComponent(String(jiraKey || '').trim())
  if (!safe) return { kind: 'http-error', status: 400, message: 'empty jiraKey' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(
      `${endpoint.baseUrl}/ai-productivity/requirements/${safe}/latest-candidate`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      }
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { kind: 'http-error', status: res.status, message: text.slice(0, 500) }
    }
    const json = (await res.json()) as {
      code?: string
      data?: LatestCandidateResponse
      message?: string
    }
    if (json.code === 'OK' && json.data) {
      return { kind: 'ok', data: json.data }
    }
    return {
      kind: 'http-error',
      status: res.status,
      message: json.message ?? 'agent 返回非 OK envelope'
    }
  } catch (err) {
    return { kind: 'network-error', message: (err as Error).message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}

export async function postTurnStartToAgent(
  payload: AgentTurnStartPayload,
  endpoint: { baseUrl: string; token: string } | null = loadAgentEndpoint(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<AgentSimpleResult> {
  return postJsonToAgent('/ai-productivity/turn-start', payload, endpoint, fetchImpl, timeoutMs)
}

/**
 * turn-thought 不复用 `postJsonToAgent`(它对任意 200 都只返 `{kind:'ok'}`,丢掉 body),
 * 而是自己解析 200 响应体,把 `applied`/`totalMs`/`reason` 透出来。
 *
 * 目的:让 hook-debug.log 能区分「真累加成功(applied=true)」与「命中 no_pending_turn 被丢
 * (applied=false)」,从而坐实 afterAgentResponse 抢先 consume 删 entry 导致 thinking 丢失的跨进程竞态。
 */
export async function postTurnThoughtToAgent(
  payload: AgentTurnThoughtPayload,
  endpoint: { baseUrl: string; token: string } | null = loadAgentEndpoint(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000
): Promise<AgentTurnThoughtResult> {
  if (!endpoint) return { kind: 'unconfigured' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${endpoint.baseUrl}/ai-productivity/turn-thought`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`,
        Accept: 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { kind: 'http-error', status: res.status, message: text.slice(0, 500) }
    }
    const json = (await res.json()) as {
      code?: string
      data?: AgentTurnThoughtResponse
      message?: string
    }
    if (json.code === 'OK' && json.data) {
      return {
        kind: 'ok',
        applied: json.data.applied === true,
        totalMs: json.data.totalMs,
        reason: json.data.reason
      }
    }
    return {
      kind: 'http-error',
      status: res.status,
      message: json.message ?? 'agent 返回非 OK envelope'
    }
  } catch (err) {
    return { kind: 'network-error', message: (err as Error).message ?? String(err) }
  } finally {
    clearTimeout(timer)
  }
}
