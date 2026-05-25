import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runInstallMcp } from './install-mcp.js'

interface McpJson {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  [k: string]: unknown
}

describe('install-mcp', () => {
  let tmpDir: string
  let configPath: string
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aipt-install-mcp-'))
    configPath = join(tmpDir, 'mcp.json')
    logSpy.mockClear()
    errSpy.mockClear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('文件不存在 → 自动新建 + 写入新 key(默认 node + cli 绝对路径)', async () => {
    const code = await runInstallMcp({
      configPath,
      // 显式 args 避免依赖 process.argv[1](vitest 下指向 vitest worker)
      command: 'node',
      args: ['/abs/path/to/cli.mjs', 'mcp']
    })
    expect(code).toBe(0)
    expect(existsSync(configPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
      command: 'node',
      args: ['/abs/path/to/cli.mjs', 'mcp']
    })
  })

  it('文件已含老 key "ai-productivity" → 删除并替换为新 key', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'ai-productivity': {
            command: 'node',
            args: ['/Users/x/Downloads/ai-productivity-mcp.mjs']
          }
        }
      })
    )
    const code = await runInstallMcp({ configPath })
    expect(code).toBe(0)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.mcpServers?.['ai-productivity']).toBeUndefined()
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toBeDefined()
  })

  it('不破坏其它无关 MCP server 条目', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'other-server': { command: 'node', args: ['./other.mjs'] }
        }
      })
    )
    await runInstallMcp({ configPath })
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.mcpServers?.['other-server']).toEqual({
      command: 'node',
      args: ['./other.mjs']
    })
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toBeDefined()
  })

  it('保留同文件中非 mcpServers 的字段', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {},
        customField: 'preserve-me',
        another: { nested: true }
      })
    )
    await runInstallMcp({ configPath })
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.customField).toBe('preserve-me')
    expect(parsed.another).toEqual({ nested: true })
  })

  it('文件已含新 key → 覆盖更新(command/args)', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'ai-productivity-tracker': {
            command: 'old-command',
            args: ['old-arg']
          }
        }
      })
    )
    await runInstallMcp({ configPath, command: 'aipt', args: ['mcp'] })
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
      command: 'aipt',
      args: ['mcp']
    })
  })

  it('JSON 损坏 → 报错并退 1,不破坏原文件', async () => {
    writeFileSync(configPath, '{not json')
    const code = await runInstallMcp({ configPath })
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalled()
    expect(readFileSync(configPath, 'utf-8')).toBe('{not json')
  })

  it('支持自定义 command/args 覆盖默认 npx 调用', async () => {
    await runInstallMcp({
      configPath,
      command: '/usr/local/bin/aipt',
      args: ['mcp']
    })
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
      command: '/usr/local/bin/aipt',
      args: ['mcp']
    })
  })

  it('文件已存在但 mcpServers 字段类型错(数组而非对象) → 重建为对象', async () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: [] }))
    const code = await runInstallMcp({ configPath })
    expect(code).toBe(0)
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
    // 数组也是 typeof object → 我们认为兼容,会按对象 spread 写入
    // 关键断言:'ai-productivity-tracker' 一定存在
    expect(parsed.mcpServers?.['ai-productivity-tracker']).toBeDefined()
  })
})
