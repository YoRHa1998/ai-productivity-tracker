import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { ensureRoot, jiraConfigPath } from './paths.js'

export interface JiraStoredConfig {
  baseUrl: string
  apiToken: string
  apiEmail: string
  bugJqlTemplate: string
}

export const DEFAULT_BUG_JQL_TEMPLATE = 'issuetype = Bug AND "Epic Link" = {{jiraKey}}'

/**
 * v2.14.2 修复用户在 Settings 表单填 `tssoft.atlassian.net`（缺 https:// 协议）
 * 导致 `new URL(path, baseUrl)` 抛 TypeError、所有 Jira REST 调用静默失败的 bug。
 *
 * 规则:
 * - trim 首尾空白
 * - 若不以 http:// / https:// 开头(大小写不敏感),自动补 https://
 * - 去掉尾部 / 让 `new URL(path, base)` 行为可预期
 * - 空串保持空串(不要写默认值,否则 isJiraConfigured 会误判已配置)
 */
export function normalizeJiraBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

export function readJiraConfig(root?: string): JiraStoredConfig {
  const file = jiraConfigPath(root)
  const empty: JiraStoredConfig = {
    baseUrl: '',
    apiToken: '',
    apiEmail: '',
    bugJqlTemplate: DEFAULT_BUG_JQL_TEMPLATE
  }
  if (!existsSync(file)) return empty
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<JiraStoredConfig>
    return {
      baseUrl: normalizeJiraBaseUrl(parsed.baseUrl ?? ''),
      apiToken: parsed.apiToken ?? '',
      apiEmail: parsed.apiEmail ?? '',
      bugJqlTemplate: parsed.bugJqlTemplate ?? DEFAULT_BUG_JQL_TEMPLATE
    }
  } catch {
    return empty
  }
}

export function isJiraConfigured(cfg: JiraStoredConfig): boolean {
  return Boolean(cfg.baseUrl && cfg.apiToken && cfg.apiEmail)
}

export function writeJiraConfig(patch: Partial<JiraStoredConfig>, root?: string): JiraStoredConfig {
  ensureRoot(root)
  const current = readJiraConfig(root)
  const nextBaseUrl =
    patch.baseUrl !== undefined ? normalizeJiraBaseUrl(patch.baseUrl) : current.baseUrl
  const next: JiraStoredConfig = {
    baseUrl: nextBaseUrl,
    apiToken: patch.apiToken ?? current.apiToken,
    apiEmail: patch.apiEmail ?? current.apiEmail,
    bugJqlTemplate: patch.bugJqlTemplate ?? current.bugJqlTemplate ?? DEFAULT_BUG_JQL_TEMPLATE
  }
  const file = jiraConfigPath(root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
  return next
}
