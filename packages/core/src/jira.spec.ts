import { describe, it, expect } from 'vitest'
import { parseJiraReference } from './jira.js'

describe('parseJiraReference', () => {
  it('从浏览器 URL 提取 jiraKey 与 baseUrl', () => {
    const result = parseJiraReference('https://yourorg.atlassian.net/browse/ABC-123')
    expect(result).toEqual({
      jiraKey: 'ABC-123',
      jiraUrl: 'https://yourorg.atlassian.net/browse/ABC-123',
      baseUrl: 'https://yourorg.atlassian.net'
    })
  })

  it('支持带 query 与 hash 的 URL', () => {
    const result = parseJiraReference(
      'https://yourorg.atlassian.net/browse/ABC-123?focusedCommentId=99#comment-99'
    )
    expect(result?.jiraKey).toBe('ABC-123')
    expect(result?.baseUrl).toBe('https://yourorg.atlassian.net')
  })

  it('支持 cloud REST path 风格 issues/{key}', () => {
    const result = parseJiraReference(
      'https://yourorg.atlassian.net/jira/software/c/projects/ABC/issues/ABC-456'
    )
    expect(result?.jiraKey).toBe('ABC-456')
  })

  it('裸 issueKey 字符串直接返回 jiraKey,无 baseUrl', () => {
    const result = parseJiraReference('ABC-789')
    expect(result).toEqual({ jiraKey: 'ABC-789', jiraUrl: undefined, baseUrl: undefined })
  })

  it('非法字符串返回 null', () => {
    expect(parseJiraReference('not a jira url')).toBeNull()
    expect(parseJiraReference('')).toBeNull()
    expect(parseJiraReference('https://example.com/foo/bar')).toBeNull()
  })
})
