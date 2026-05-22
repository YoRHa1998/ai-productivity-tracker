export const JIRA_ISSUE_KEY_REGEX = /([A-Z][A-Z0-9]+-\d+)/

export interface JiraReference {
  jiraKey: string
  jiraUrl?: string
  baseUrl?: string
}

export function parseJiraReference(input: string): JiraReference | null {
  if (!input || typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null

  if (!/^https?:\/\//.test(trimmed)) {
    const m = JIRA_ISSUE_KEY_REGEX.exec(trimmed)
    if (!m) return null
    if (m[0] !== trimmed) return null
    return { jiraKey: m[1] }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const keyMatch = JIRA_ISSUE_KEY_REGEX.exec(url.pathname)
  if (!keyMatch) return null

  return {
    jiraKey: keyMatch[1],
    jiraUrl: trimmed,
    baseUrl: `${url.protocol}//${url.host}`
  }
}
