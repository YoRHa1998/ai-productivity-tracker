import { describe, it, expect } from 'vitest'

import {
  CODEX_MCP_SERVER_KEY,
  buildCodexMcpBlock,
  upsertCodexMcpConfig
} from './codex-mcp-config.js'

describe('buildCodexMcpBlock', () => {
  it('生成引号 key 的 mcp_servers 块,args 为字符串数组', () => {
    const block = buildCodexMcpBlock('/abs/node', ['/abs/cli.mjs', 'mcp'])
    expect(block).toContain(`[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`)
    expect(block).toContain('command = "/abs/node"')
    expect(block).toContain('args = ["/abs/cli.mjs", "mcp"]')
  })

  it('转义路径中的反斜杠与引号', () => {
    const block = buildCodexMcpBlock('C:\\node\\node.exe', ['x"y'])
    expect(block).toContain('command = "C:\\\\node\\\\node.exe"')
    expect(block).toContain('args = ["x\\"y"]')
  })
})

describe('upsertCodexMcpConfig', () => {
  it('空文件 → 新增块,hadEntry=false', () => {
    const res = upsertCodexMcpConfig('', '/node', ['/cli.mjs', 'mcp'])
    expect(res.hadEntry).toBe(false)
    expect(res.replacedLegacy).toBe(false)
    expect(res.text).toContain(`[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`)
    expect(res.text.endsWith('\n')).toBe(true)
  })

  it('保留其它 mcp_servers / model_providers / projects / features 块', () => {
    const original = [
      'model = "gpt-5.5"',
      '',
      '[model_providers.sub2api]',
      'base_url = "https://api.example.com"',
      '',
      '[projects."/Users/foo"]',
      'trust_level = "trusted"',
      '',
      '[mcp_servers."context7"]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n')

    const res = upsertCodexMcpConfig(original, '/node', ['/cli.mjs', 'mcp'])
    expect(res.text).toContain('[model_providers.sub2api]')
    expect(res.text).toContain('[projects."/Users/foo"]')
    expect(res.text).toContain('[mcp_servers."context7"]')
    expect(res.text).toContain('[features]')
    expect(res.text).toContain('hooks = true')
    expect(res.text).toContain(`[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`)
    expect(res.text).toContain('command = "/node"')
  })

  it('已存在我们的块 → 覆盖 command/args,hadEntry=true,不重复', () => {
    const original = [
      '[mcp_servers."context7"]',
      'command = "npx"',
      '',
      `[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`,
      'command = "/old/node"',
      'args = ["/old/cli.mjs", "mcp"]',
      ''
    ].join('\n')

    const res = upsertCodexMcpConfig(original, '/new/node', ['/new/cli.mjs', 'mcp'])
    expect(res.hadEntry).toBe(true)
    expect(res.text).toContain('command = "/new/node"')
    expect(res.text).not.toContain('/old/node')
    expect(res.text).not.toContain('/old/cli.mjs')
    // 仅出现一次我们的块
    const occurrences = res.text.split(`[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`).length - 1
    expect(occurrences).toBe(1)
    // context7 保留
    expect(res.text).toContain('[mcp_servers."context7"]')
  })

  it('清理 legacy key(ai-productivity)→ replacedLegacy=true', () => {
    const original = [
      '[mcp_servers."ai-productivity"]',
      'command = "/old/node"',
      'args = ["/old.mjs", "mcp"]',
      ''
    ].join('\n')
    const res = upsertCodexMcpConfig(original, '/node', ['/cli.mjs', 'mcp'])
    expect(res.replacedLegacy).toBe(true)
    expect(res.text).not.toContain('[mcp_servers."ai-productivity"]')
    expect(res.text).toContain(`[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`)
  })

  it('我们的块在文件中间(后面还有别的表)→ 正确切除整块不误删后续表', () => {
    const original = [
      `[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`,
      'command = "/old/node"',
      'args = ["/old.mjs", "mcp"]',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n')
    const res = upsertCodexMcpConfig(original, '/node', ['/cli.mjs', 'mcp'])
    expect(res.text).toContain('[features]')
    expect(res.text).toContain('hooks = true')
    expect(res.text).not.toContain('/old/node')
  })
})
