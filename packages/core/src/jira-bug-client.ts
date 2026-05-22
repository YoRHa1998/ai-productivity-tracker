import {
  isJiraConfigured,
  normalizeJiraBaseUrl,
  type JiraStoredConfig
} from './store/jira-config-store.js'

export class JiraBugFetchError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string
  ) {
    super(message)
    this.name = 'JiraBugFetchError'
  }
}

export interface JiraApproximateCountResponse {
  count?: number
}

export interface JiraIssueResponse {
  key?: string
  fields?: {
    summary?: string
  }
}

/**
 * v2.15.1 CHANGE-2046:Atlassian 已下线 GET /rest/api/3/search,返回 410。
 * 迁移到 POST /rest/api/3/search/approximate-count,body `{ jql }`,响应 `{ count }`。
 * 对外签名保持 `(config, jql) => Promise<number>` 不变,上层 handler 无感。
 * 自定义 fetchImpl 便于单测注入。
 */
export async function fetchJiraBugTotal(
  config: JiraStoredConfig,
  jql: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  if (!config.baseUrl || !config.apiToken || !config.apiEmail) {
    throw new JiraBugFetchError(0, 'Jira 配置不完整,请在面板填写 baseUrl/apiEmail/apiToken')
  }

  const normalizedBase = normalizeJiraBaseUrl(config.baseUrl)
  let url: URL
  try {
    url = new URL('/rest/api/3/search/approximate-count', normalizedBase)
  } catch {
    throw new JiraBugFetchError(
      0,
      `Jira Base URL 无效:${config.baseUrl},请检查是否包含 https:// 协议前缀`
    )
  }

  const auth = Buffer.from(`${config.apiEmail}:${config.apiToken}`).toString('base64')
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ jql })
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new JiraBugFetchError(
      response.status,
      `Jira 查询失败:${response.status} ${text.slice(0, 200)}`,
      text
    )
  }

  const data = (await response.json()) as JiraApproximateCountResponse
  return typeof data.count === 'number' ? data.count : 0
}

export function renderJqlTemplate(template: string, jiraKey: string): string {
  return (template || '').replace(/\{\{jiraKey\}\}/g, jiraKey)
}

/**
 * v2.15.2 Atlassian 新接口(`/rest/api/3/search/approximate-count` 等)对 JQL 加了
 * 「bounded query」硬约束:必须含至少一个主搜索限制字段。官方文档明确给出的 bounded 示例只有
 * `project=` / `reporter=` / `updated>` / `created>` / `assignee=` / `key in` 等典型字段;
 * `issuetype` / `"Epic Link"` 之类不在白名单内,即便业务语义上已经"圈住"了一个 epic 也会被拒。
 *
 * 这里做最小兜底:用户 JQL 模板若不含 bounded 字段,按 jiraKey 前缀(如 `INSTANT-5321` → `INSTANT`)
 * 自动追加 `AND project = <项目码>`,既满足 Atlassian 约束又不破坏用户原有语义。
 *
 * 已含 ORDER BY 的 JQL 需要把 project 插在 ORDER BY 前(JQL 语法要求 ORDER BY 必须在末尾)。
 * jiraKey 不合规(无法提取项目码)时静默放弃追加,避免拼出更糟的语法。
 */
const BOUNDED_FIELD_PATTERN =
  /\b(project|reporter|assignee|updated|created|key)\s*(=|!=|in\b|not\s+in\b|>|<|>=|<=)/i

export function extractProjectKey(jiraKey: string): string {
  const match = jiraKey.match(/^([A-Z][A-Z0-9]+)-\d+$/)
  return match ? match[1] : ''
}

export function ensureBoundedJql(jql: string, jiraKey: string): string {
  const trimmed = (jql ?? '').trim()
  if (!trimmed) return ''
  if (BOUNDED_FIELD_PATTERN.test(trimmed)) return trimmed
  const project = extractProjectKey(jiraKey)
  if (!project) return trimmed
  const orderByMatch = trimmed.match(/\border\s+by\b/i)
  if (orderByMatch) {
    const idx = orderByMatch.index ?? -1
    if (idx >= 0) {
      const head = trimmed.slice(0, idx).trimEnd()
      const tail = trimmed.slice(idx)
      return `${head} AND project = ${project} ${tail}`
    }
  }
  return `${trimmed} AND project = ${project}`
}

/**
 * v2.14.2 inspectJiraIssueSummary 返回带 reason 的可判别结果;
 * 调用方(sync-jira-title handler)可按 reason 输出有意义的错误文案,
 * 不再让用户对着"无法从 Jira 拉取..."猜根因。
 *
 * reason 含义:
 * - not_configured  : Jira 凭证未配置/不完整
 * - empty_jira_key  : 调用方传入空 jiraKey
 * - invalid_url     : baseUrl 即使补齐协议后仍无法被 `new URL` 解析
 * - unauthorized    : Jira 返回 401
 * - forbidden       : Jira 返回 403
 * - not_found       : Jira 返回 404(issue 不存在或凭证无权)
 * - http_error      : 其它非 2xx
 * - network_error   : fetch 抛错(DNS / 超时 / 证书等)
 * - invalid_json    : 响应不是合法 JSON
 * - empty_summary   : 拉到了 issue 但 fields.summary 为空白
 */
export type JiraIssueSummaryReason =
  | 'not_configured'
  | 'empty_jira_key'
  | 'invalid_url'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'http_error'
  | 'network_error'
  | 'invalid_json'
  | 'empty_summary'

export type JiraIssueSummaryResult =
  | { ok: true; summary: string }
  | { ok: false; reason: JiraIssueSummaryReason; status?: number }

export async function inspectJiraIssueSummary(
  config: JiraStoredConfig,
  jiraKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<JiraIssueSummaryResult> {
  if (!isJiraConfigured(config)) return { ok: false, reason: 'not_configured' }
  if (!jiraKey) return { ok: false, reason: 'empty_jira_key' }

  const normalizedBase = normalizeJiraBaseUrl(config.baseUrl)
  let url: URL
  try {
    url = new URL(`/rest/api/3/issue/${encodeURIComponent(jiraKey)}`, normalizedBase)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  url.searchParams.set('fields', 'summary')

  const auth = Buffer.from(`${config.apiEmail}:${config.apiToken}`).toString('base64')

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      }
    })
  } catch {
    return { ok: false, reason: 'network_error' }
  }

  if (!response.ok) {
    if (response.status === 401) return { ok: false, reason: 'unauthorized', status: 401 }
    if (response.status === 403) return { ok: false, reason: 'forbidden', status: 403 }
    if (response.status === 404) return { ok: false, reason: 'not_found', status: 404 }
    return { ok: false, reason: 'http_error', status: response.status }
  }

  let data: JiraIssueResponse
  try {
    data = (await response.json()) as JiraIssueResponse
  } catch {
    return { ok: false, reason: 'invalid_json', status: response.status }
  }

  const summary = data?.fields?.summary
  if (typeof summary !== 'string')
    return { ok: false, reason: 'empty_summary', status: response.status }
  const trimmed = summary.trim()
  if (!trimmed.length) return { ok: false, reason: 'empty_summary', status: response.status }
  return { ok: true, summary: trimmed }
}

/**
 * 兼容包装:init 流程沿用 `Promise<string | null>` 签名,失败统一回退 null。
 * 新增的 sync-jira-title handler 直接调 `inspectJiraIssueSummary` 拿到细分 reason。
 */
export async function fetchJiraIssueSummary(
  config: JiraStoredConfig,
  jiraKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const result = await inspectJiraIssueSummary(config, jiraKey, fetchImpl)
  return result.ok ? result.summary : null
}
