import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_AGENT_BASE = 'http://127.0.0.1:17350'
/** v1.0 起 daemon 运行态写在 runtime.json,与 config.json (用户配置) 分离 */
export const AGENT_CONFIG_PATH = join(homedir(), '.ai-productivity-tracker', 'runtime.json')
/** v1.0 向后兼容:老 truesight-agent 用户的 config.json,优先级低于新 runtime.json */
export const LEGACY_AGENT_CONFIG_PATH = join(homedir(), '.truesight-local-agent', 'config.json')

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
 *   3) (向后兼容)环境变量 TRUESIGHT_AGENT_TOKEN / TRUESIGHT_AGENT_BASE_URL
 *   4) (向后兼容)~/.truesight-local-agent/config.json
 *
 * 找不到 token 时返回 null,调用方应当回退到本地 bindings.json 直写路径。
 */
export function loadAgentEndpoint(
  configFilePath: string = AGENT_CONFIG_PATH
): { baseUrl: string; token: string } | null {
  // 1) 新 env(优先)
  const envToken = process.env.AIPT_DAEMON_TOKEN ?? process.env.TRUESIGHT_AGENT_TOKEN
  const envBase = process.env.AIPT_DAEMON_URL ?? process.env.TRUESIGHT_AGENT_BASE_URL
  if (envToken && envBase) {
    return { baseUrl: envBase.replace(/\/$/, ''), token: envToken }
  }

  // 2) 新 runtime.json
  const fromFile = tryReadEndpointFile(configFilePath, envToken, envBase)
  if (fromFile) return fromFile

  // 3) 老 config.json fallback(便于老 truesight-agent 用户平滑共存)
  if (configFilePath === AGENT_CONFIG_PATH) {
    const legacy = tryReadEndpointFile(LEGACY_AGENT_CONFIG_PATH, envToken, envBase)
    if (legacy) return legacy
  }

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
