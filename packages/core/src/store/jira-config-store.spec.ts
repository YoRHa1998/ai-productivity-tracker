import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_BUG_JQL_TEMPLATE,
  isJiraConfigured,
  normalizeJiraBaseUrl,
  readJiraConfig,
  writeJiraConfig
} from './jira-config-store.js'
import { jiraConfigPath } from './paths.js'

describe('jira-config-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-jira-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('缺失时返回空字段 + 默认 template', () => {
    const c = readJiraConfig(root)
    expect(c.baseUrl).toBe('')
    expect(c.apiToken).toBe('')
    expect(c.apiEmail).toBe('')
    expect(c.bugJqlTemplate).toBe(DEFAULT_BUG_JQL_TEMPLATE)
    expect(isJiraConfigured(c)).toBe(false)
  })

  it('writeJiraConfig 后 isJiraConfigured 为 true', () => {
    const c = writeJiraConfig(
      { baseUrl: 'https://x.atlassian.net', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    expect(isJiraConfigured(c)).toBe(true)
    const reloaded = readJiraConfig(root)
    expect(reloaded.baseUrl).toBe('https://x.atlassian.net')
  })

  it('writeJiraConfig 部分 patch 保留原值', () => {
    writeJiraConfig(
      { baseUrl: 'https://x.atlassian.net', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    const c = writeJiraConfig({ bugJqlTemplate: 'project = {{jiraKey}}' }, root)
    expect(c.bugJqlTemplate).toBe('project = {{jiraKey}}')
    expect(c.baseUrl).toBe('https://x.atlassian.net')
    expect(c.apiToken).toBe('tk')
  })

  // v2.14.2 baseUrl normalize
  it('writeJiraConfig 缺协议时自动补 https://', () => {
    const c = writeJiraConfig(
      { baseUrl: 'tssoft.atlassian.net', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    expect(c.baseUrl).toBe('https://tssoft.atlassian.net')
    expect(readJiraConfig(root).baseUrl).toBe('https://tssoft.atlassian.net')
  })

  it('writeJiraConfig 去掉 baseUrl 尾部斜杠', () => {
    const c = writeJiraConfig(
      { baseUrl: 'https://x.atlassian.net///', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    expect(c.baseUrl).toBe('https://x.atlassian.net')
  })

  it('writeJiraConfig trim baseUrl 首尾空白', () => {
    const c = writeJiraConfig(
      { baseUrl: '  https://x.atlassian.net  ', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    expect(c.baseUrl).toBe('https://x.atlassian.net')
  })

  it('writeJiraConfig 空串 baseUrl 保持空(不被默认 https:// 误填)', () => {
    writeJiraConfig({ baseUrl: 'tssoft.atlassian.net', apiEmail: 'a@b.com', apiToken: 'tk' }, root)
    const c = writeJiraConfig({ baseUrl: '' }, root)
    expect(c.baseUrl).toBe('')
    expect(isJiraConfigured(c)).toBe(false)
  })

  it('readJiraConfig 兜底清洗已落盘的脏 baseUrl', () => {
    const file = jiraConfigPath(root)
    writeFileSync(
      file,
      JSON.stringify({
        baseUrl: 'tssoft.atlassian.net/',
        apiEmail: 'a@b.com',
        apiToken: 'tk',
        bugJqlTemplate: DEFAULT_BUG_JQL_TEMPLATE
      }),
      'utf-8'
    )
    const c = readJiraConfig(root)
    expect(c.baseUrl).toBe('https://tssoft.atlassian.net')
  })

  it('writeJiraConfig 保留 http:// 协议(不强制升级到 https)', () => {
    const c = writeJiraConfig(
      { baseUrl: 'http://localhost:8080/', apiEmail: 'a@b.com', apiToken: 'tk' },
      root
    )
    expect(c.baseUrl).toBe('http://localhost:8080')
  })
})

describe('normalizeJiraBaseUrl', () => {
  it('空字符串保持空字符串', () => {
    expect(normalizeJiraBaseUrl('')).toBe('')
    expect(normalizeJiraBaseUrl('   ')).toBe('')
  })

  it('缺协议时补 https://', () => {
    expect(normalizeJiraBaseUrl('tssoft.atlassian.net')).toBe('https://tssoft.atlassian.net')
    expect(normalizeJiraBaseUrl('yourorg.atlassian.net/')).toBe('https://yourorg.atlassian.net')
  })

  it('保留已有协议且大小写不敏感', () => {
    expect(normalizeJiraBaseUrl('HTTPS://x.atlassian.net')).toBe('HTTPS://x.atlassian.net')
    expect(normalizeJiraBaseUrl('http://localhost')).toBe('http://localhost')
  })

  it('去掉尾部所有斜杠', () => {
    expect(normalizeJiraBaseUrl('https://x.atlassian.net///')).toBe('https://x.atlassian.net')
  })
})
