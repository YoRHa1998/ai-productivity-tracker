import { describe, expect, it } from 'vitest'

import {
  ensureBoundedJql,
  extractProjectKey,
  fetchJiraBugTotal,
  fetchJiraIssueSummary,
  inspectJiraIssueSummary,
  JiraBugFetchError,
  renderJqlTemplate
} from './jira-bug-client.js'
import type { JiraStoredConfig } from './store/jira-config-store.js'

const configured: JiraStoredConfig = {
  baseUrl: 'https://example.atlassian.net',
  apiEmail: 'me@example.com',
  apiToken: 'tok',
  bugJqlTemplate: 'issuetype = Bug'
}

const empty: JiraStoredConfig = {
  baseUrl: '',
  apiEmail: '',
  apiToken: '',
  bugJqlTemplate: ''
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('renderJqlTemplate', () => {
  it('替换 {{jiraKey}} 占位符', () => {
    expect(renderJqlTemplate('issuetype = Bug AND "Epic Link" = {{jiraKey}}', 'INSTANT-1')).toBe(
      'issuetype = Bug AND "Epic Link" = INSTANT-1'
    )
  })
})

// v2.15.2 Atlassian 新接口对 JQL 加了 bounded 硬约束,agent 端兜底自动追加 project
describe('extractProjectKey', () => {
  it('合法 jiraKey 取 - 前缀', () => {
    expect(extractProjectKey('INSTANT-5321')).toBe('INSTANT')
    expect(extractProjectKey('AB123-9')).toBe('AB123')
  })

  it('不合规 jiraKey 返回空串', () => {
    expect(extractProjectKey('')).toBe('')
    expect(extractProjectKey('foo')).toBe('')
    expect(extractProjectKey('-123')).toBe('')
    expect(extractProjectKey('lowercase-1')).toBe('')
  })
})

describe('ensureBoundedJql', () => {
  it('已含 project = X → 原样返回', () => {
    const jql = 'project = INSTANT AND issuetype = Bug'
    expect(ensureBoundedJql(jql, 'INSTANT-1')).toBe(jql)
  })

  it('已含 project IN (...) → 原样返回', () => {
    const jql = 'project in (INSTANT, OTHER) AND issuetype = Bug'
    expect(ensureBoundedJql(jql, 'INSTANT-1')).toBe(jql)
  })

  it('已含 reporter = currentUser() → 原样返回', () => {
    const jql = 'reporter = currentUser() AND issuetype = Bug'
    expect(ensureBoundedJql(jql, 'INSTANT-1')).toBe(jql)
  })

  it('已含 updated > 限制 → 原样返回', () => {
    const jql = 'updated > -7d'
    expect(ensureBoundedJql(jql, 'INSTANT-1')).toBe(jql)
  })

  it('未含 bounded 字段时按 jiraKey 前缀追加 AND project = <项目码>', () => {
    expect(ensureBoundedJql('issuetype = Bug AND "Epic Link" = INSTANT-5321', 'INSTANT-5321')).toBe(
      'issuetype = Bug AND "Epic Link" = INSTANT-5321 AND project = INSTANT'
    )
  })

  it('含 ORDER BY 时 project 插在 ORDER BY 前', () => {
    expect(
      ensureBoundedJql(
        'issuetype = Bug AND "Epic Link" = INSTANT-1 ORDER BY created DESC',
        'INSTANT-1'
      )
    ).toBe(
      'issuetype = Bug AND "Epic Link" = INSTANT-1 AND project = INSTANT ORDER BY created DESC'
    )
  })

  it('jiraKey 不合规且模板未含 bounded → 原样返回(避免拼错)', () => {
    expect(ensureBoundedJql('issuetype = Bug', 'bad-format')).toBe('issuetype = Bug')
  })

  it('jql 为空字符串 → 空字符串', () => {
    expect(ensureBoundedJql('', 'INSTANT-1')).toBe('')
    expect(ensureBoundedJql('   ', 'INSTANT-1')).toBe('')
  })

  it('bounded 字段大小写不敏感', () => {
    const jql = 'PROJECT = INSTANT AND issuetype = Bug'
    expect(ensureBoundedJql(jql, 'INSTANT-1')).toBe(jql)
  })
})

describe('fetchJiraBugTotal', () => {
  it('OK 时返回 count 字段', async () => {
    const total = await fetchJiraBugTotal(configured, 'project = INSTANT', async () =>
      jsonResponse({ count: 7 })
    )
    expect(total).toBe(7)
  })

  it('count 缺失时返回 0', async () => {
    const total = await fetchJiraBugTotal(configured, 'project = INSTANT', async () =>
      jsonResponse({})
    )
    expect(total).toBe(0)
  })

  // v2.15.1 CHANGE-2046:迁移到 POST /rest/api/3/search/approximate-count
  it('POST /rest/api/3/search/approximate-count 且 body 含 jql / Content-Type=application/json', async () => {
    let observedUrl = ''
    let observedMethod = ''
    let observedContentType = ''
    let observedBody = ''
    await fetchJiraBugTotal(
      configured,
      'project = INSTANT AND issuetype = Bug',
      async (url, init) => {
        observedUrl = url instanceof URL ? url.toString() : String(url)
        observedMethod = String(init?.method ?? '')
        const headers = init?.headers as Record<string, string> | undefined
        observedContentType = headers?.['Content-Type'] ?? ''
        observedBody = typeof init?.body === 'string' ? init.body : ''
        return jsonResponse({ count: 42 })
      }
    )
    expect(observedUrl).toContain('/rest/api/3/search/approximate-count')
    expect(observedUrl).not.toContain('jql=')
    expect(observedMethod.toUpperCase()).toBe('POST')
    expect(observedContentType).toBe('application/json')
    expect(JSON.parse(observedBody)).toEqual({ jql: 'project = INSTANT AND issuetype = Bug' })
  })
})

describe('fetchJiraIssueSummary', () => {
  it('Jira 配置完整且响应有 fields.summary 时返回 trim 后的标题', async () => {
    const summary = await fetchJiraIssueSummary(configured, 'INSTANT-5991', async () =>
      jsonResponse({ key: 'INSTANT-5991', fields: { summary: '  Real Title  ' } })
    )
    expect(summary).toBe('Real Title')
  })

  it('Jira 未配置时返回 null (不发请求)', async () => {
    let called = false
    const summary = await fetchJiraIssueSummary(empty, 'INSTANT-5991', async () => {
      called = true
      return jsonResponse({})
    })
    expect(summary).toBeNull()
    expect(called).toBe(false)
  })

  it('jiraKey 为空时返回 null', async () => {
    let called = false
    const summary = await fetchJiraIssueSummary(configured, '', async () => {
      called = true
      return jsonResponse({})
    })
    expect(summary).toBeNull()
    expect(called).toBe(false)
  })

  it('非 200 响应时返回 null, 不抛异常', async () => {
    const summary = await fetchJiraIssueSummary(
      configured,
      'INSTANT-5991',
      async () => new Response('not found', { status: 404 })
    )
    expect(summary).toBeNull()
  })

  it('网络抛错时返回 null', async () => {
    const summary = await fetchJiraIssueSummary(configured, 'INSTANT-5991', async () => {
      throw new Error('network down')
    })
    expect(summary).toBeNull()
  })

  it('fields.summary 是空白时返回 null', async () => {
    const summary = await fetchJiraIssueSummary(configured, 'INSTANT-5991', async () =>
      jsonResponse({ fields: { summary: '   ' } })
    )
    expect(summary).toBeNull()
  })

  it('请求 URL 与 Basic Auth 头组装正确', async () => {
    let observedUrl = ''
    let observedAuth = ''
    await fetchJiraIssueSummary(configured, 'INSTANT-5991', async (url, init) => {
      observedUrl = url instanceof URL ? url.toString() : String(url)
      const headers = init?.headers as Record<string, string> | undefined
      observedAuth = headers?.Authorization ?? ''
      return jsonResponse({ fields: { summary: 'X' } })
    })
    expect(observedUrl).toContain('/rest/api/3/issue/INSTANT-5991')
    expect(observedUrl).toContain('fields=summary')
    expect(observedAuth.startsWith('Basic ')).toBe(true)
    const decoded = Buffer.from(observedAuth.slice('Basic '.length), 'base64').toString('utf-8')
    expect(decoded).toBe('me@example.com:tok')
  })

  // v2.14.2 baseUrl 缺协议时 client 防御性 normalize
  it('baseUrl 缺协议时仍能拼出正确请求 URL', async () => {
    const cfg: JiraStoredConfig = { ...configured, baseUrl: 'tssoft.atlassian.net' }
    let observedUrl = ''
    const summary = await fetchJiraIssueSummary(cfg, 'INSTANT-5321', async (url) => {
      observedUrl = url instanceof URL ? url.toString() : String(url)
      return jsonResponse({ fields: { summary: 'Real Title' } })
    })
    expect(summary).toBe('Real Title')
    expect(
      observedUrl.startsWith('https://tssoft.atlassian.net/rest/api/3/issue/INSTANT-5321')
    ).toBe(true)
  })
})

describe('inspectJiraIssueSummary', () => {
  it('200 + 非空 summary → ok=true', async () => {
    const res = await inspectJiraIssueSummary(configured, 'X-1', async () =>
      jsonResponse({ fields: { summary: 'Hi' } })
    )
    expect(res).toEqual({ ok: true, summary: 'Hi' })
  })

  it('未配置 → reason=not_configured 且不发请求', async () => {
    let called = false
    const res = await inspectJiraIssueSummary(empty, 'X-1', async () => {
      called = true
      return jsonResponse({})
    })
    expect(res).toEqual({ ok: false, reason: 'not_configured' })
    expect(called).toBe(false)
  })

  it('jiraKey 为空 → reason=empty_jira_key', async () => {
    const res = await inspectJiraIssueSummary(configured, '', async () => jsonResponse({}))
    expect(res).toEqual({ ok: false, reason: 'empty_jira_key' })
  })

  it('401 → reason=unauthorized', async () => {
    const res = await inspectJiraIssueSummary(
      configured,
      'X-1',
      async () => new Response('no', { status: 401 })
    )
    expect(res).toEqual({ ok: false, reason: 'unauthorized', status: 401 })
  })

  it('403 → reason=forbidden', async () => {
    const res = await inspectJiraIssueSummary(
      configured,
      'X-1',
      async () => new Response('nope', { status: 403 })
    )
    expect(res).toEqual({ ok: false, reason: 'forbidden', status: 403 })
  })

  it('404 → reason=not_found', async () => {
    const res = await inspectJiraIssueSummary(
      configured,
      'X-1',
      async () => new Response('miss', { status: 404 })
    )
    expect(res).toEqual({ ok: false, reason: 'not_found', status: 404 })
  })

  it('500 → reason=http_error', async () => {
    const res = await inspectJiraIssueSummary(
      configured,
      'X-1',
      async () => new Response('boom', { status: 500 })
    )
    expect(res).toEqual({ ok: false, reason: 'http_error', status: 500 })
  })

  it('fetch 抛错 → reason=network_error', async () => {
    const res = await inspectJiraIssueSummary(configured, 'X-1', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(res).toEqual({ ok: false, reason: 'network_error' })
  })

  it('响应非 JSON → reason=invalid_json', async () => {
    const res = await inspectJiraIssueSummary(
      configured,
      'X-1',
      async () =>
        new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_json')
  })

  it('summary 为空白 → reason=empty_summary', async () => {
    const res = await inspectJiraIssueSummary(configured, 'X-1', async () =>
      jsonResponse({ fields: { summary: '   ' } })
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('empty_summary')
  })

  it('baseUrl 无法解析 → reason=invalid_url', async () => {
    // `http://[` 是未闭合的 IPv6 字面量,normalize 不会救场,`new URL` 必抛 TypeError
    const cfg: JiraStoredConfig = { ...configured, baseUrl: 'http://[' }
    let called = false
    const res = await inspectJiraIssueSummary(cfg, 'X-1', async () => {
      called = true
      return jsonResponse({})
    })
    expect(called).toBe(false)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('invalid_url')
  })
})

describe('fetchJiraBugTotal baseUrl 防御', () => {
  it('baseUrl 缺协议时拼出 https://.../search/approximate-count 请求', async () => {
    const cfg: JiraStoredConfig = { ...configured, baseUrl: 'tssoft.atlassian.net' }
    let observedUrl = ''
    let observedMethod = ''
    await fetchJiraBugTotal(cfg, 'project = INSTANT', async (url, init) => {
      observedUrl = url instanceof URL ? url.toString() : String(url)
      observedMethod = String(init?.method ?? '')
      return jsonResponse({ count: 3 })
    })
    expect(
      observedUrl.startsWith('https://tssoft.atlassian.net/rest/api/3/search/approximate-count')
    ).toBe(true)
    expect(observedMethod.toUpperCase()).toBe('POST')
  })

  it('baseUrl 无论如何无法解析时抛 JiraBugFetchError', async () => {
    const cfg: JiraStoredConfig = { ...configured, baseUrl: 'http://[' }
    await expect(
      fetchJiraBugTotal(cfg, 'project = X', async () => jsonResponse({ count: 0 }))
    ).rejects.toBeInstanceOf(JiraBugFetchError)
  })
})
