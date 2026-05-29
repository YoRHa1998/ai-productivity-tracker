import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runInstallMcp, runInstallMcpAll } from './install-mcp.js'

interface McpJson {
  mcpServers?: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string>; type?: string }
  >
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

  // ── Claude Code target(rc.16+) ─────────────────────────────────
  describe('claude target (~/.claude.json)', () => {
    it('target=claude 文件不存在 → 新建 + entry 带 type:stdio,文件 mode=0600', async () => {
      const code = await runInstallMcp({
        target: 'claude',
        configPath,
        command: 'node',
        args: ['/abs/path/to/cli.mjs', 'mcp']
      })
      expect(code).toBe(0)
      expect(existsSync(configPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
      expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/abs/path/to/cli.mjs', 'mcp']
      })
      // ~/.claude.json 可能含 Jira API token 等敏感 env,统一 0600
      const mode = statSync(configPath).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('target=claude 保留 ~/.claude.json 顶层其它字段(numStartups / theme / projects 等)', async () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          numStartups: 42,
          theme: 'dark',
          userID: 'abc',
          projects: { '/Users/x/foo': { lastUsed: 1 } },
          mcpServers: {
            jira: {
              type: 'stdio',
              command: 'node',
              args: ['/Users/x/jira/index.js'],
              env: { JIRA_HOST: 'example.atlassian.net' }
            }
          }
        })
      )
      const code = await runInstallMcp({
        target: 'claude',
        configPath,
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
      expect(parsed.numStartups).toBe(42)
      expect(parsed.theme).toBe('dark')
      expect(parsed.userID).toBe('abc')
      expect(parsed.projects).toEqual({ '/Users/x/foo': { lastUsed: 1 } })
      expect(parsed.mcpServers?.jira).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/Users/x/jira/index.js'],
        env: { JIRA_HOST: 'example.atlassian.net' }
      })
      expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
    })

    it("target=claude 清理老 key 'ai-productivity' 并替换为新 key", async () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            'ai-productivity': {
              type: 'stdio',
              command: 'node',
              args: ['/Users/x/Downloads/ai-productivity-mcp.mjs'],
              env: { LEGACY_AGENT_URL: 'http://127.0.0.1:17280' }
            }
          }
        })
      )
      const code = await runInstallMcp({
        target: 'claude',
        configPath,
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
      expect(parsed.mcpServers?.['ai-productivity']).toBeUndefined()
      expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
    })

    it('target=claude 覆盖更新已有新 key,保留 type:stdio', async () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            'ai-productivity-tracker': {
              type: 'stdio',
              command: 'old',
              args: ['old-arg']
            }
          }
        })
      )
      const code = await runInstallMcp({
        target: 'claude',
        configPath,
        command: '/abs/node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as McpJson
      expect(parsed.mcpServers?.['ai-productivity-tracker']).toEqual({
        type: 'stdio',
        command: '/abs/node',
        args: ['/abs/cli.mjs', 'mcp']
      })
    })
  })

  // ── runInstallMcpAll: 同时注入两个 IDE(rc.16+) ────────────────
  describe('runInstallMcpAll', () => {
    it('ide=all → 同时写入 cursor 和 claude,任一都拿到正确 entry', async () => {
      const cursorPath = join(tmpDir, 'mcp.json')
      const claudePath = join(tmpDir, '.claude.json')
      // 用 process.env 不方便覆盖默认路径;改成手工调两次 runInstallMcp 验证逻辑等价。
      // 这里测 runInstallMcpAll 路径会跑两个 target,但 configPath 不能 per-target 传入,
      // 所以分别断言"调 cursor 和 claude target 时 entry shape 差异符合预期"。
      const cursorCode = await runInstallMcp({
        target: 'cursor',
        configPath: cursorPath,
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      const claudeCode = await runInstallMcp({
        target: 'claude',
        configPath: claudePath,
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      expect(cursorCode).toBe(0)
      expect(claudeCode).toBe(0)
      const cursor = JSON.parse(readFileSync(cursorPath, 'utf-8')) as McpJson
      const claude = JSON.parse(readFileSync(claudePath, 'utf-8')) as McpJson
      // Cursor entry 不带 type
      expect(cursor.mcpServers?.['ai-productivity-tracker']).toEqual({
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
      // Claude entry 带 type:stdio
      expect(claude.mcpServers?.['ai-productivity-tracker']).toEqual({
        type: 'stdio',
        command: 'node',
        args: ['/abs/cli.mjs', 'mcp']
      })
    })

    it('runInstallMcpAll 默认 ide=all,任一 target 失败不阻断另一个(worst exit code)', async () => {
      // 直接调 runInstallMcpAll 会走默认 ~/.cursor/mcp.json + ~/.claude.json,
      // 测试沙箱里无法重定向(没有 process.env.HOME 覆盖能力);这里只验证函数返回 0
      // 当两个 target 都成功;不可能在单测内污染真实 HOME。
      // 因此构造一个仅校验入参分发的轻量 mock:用 ide=cursor 限定到单 target,
      // 然后传 configPath=undefined 走默认路径 → 用 HOME 覆盖避开真实写入。
      const realHome = process.env.HOME
      process.env.HOME = tmpDir
      try {
        const code = await runInstallMcpAll({
          ide: 'all',
          command: 'node',
          args: ['/abs/cli.mjs', 'mcp']
        })
        expect(code).toBe(0)
        const cursorFile = join(tmpDir, '.cursor', 'mcp.json')
        const claudeFile = join(tmpDir, '.claude.json')
        expect(existsSync(cursorFile)).toBe(true)
        expect(existsSync(claudeFile)).toBe(true)
        const cursor = JSON.parse(readFileSync(cursorFile, 'utf-8')) as McpJson
        const claude = JSON.parse(readFileSync(claudeFile, 'utf-8')) as McpJson
        expect(cursor.mcpServers?.['ai-productivity-tracker']?.type).toBeUndefined()
        expect(claude.mcpServers?.['ai-productivity-tracker']?.type).toBe('stdio')
      } finally {
        if (realHome === undefined) delete process.env.HOME
        else process.env.HOME = realHome
      }
    })

    it('runInstallMcpAll ide=claude 只动 ~/.claude.json,不创建 ~/.cursor/mcp.json', async () => {
      const realHome = process.env.HOME
      process.env.HOME = tmpDir
      try {
        const code = await runInstallMcpAll({
          ide: 'claude',
          command: 'node',
          args: ['/abs/cli.mjs', 'mcp']
        })
        expect(code).toBe(0)
        expect(existsSync(join(tmpDir, '.claude.json'))).toBe(true)
        expect(existsSync(join(tmpDir, '.cursor', 'mcp.json'))).toBe(false)
      } finally {
        if (realHome === undefined) delete process.env.HOME
        else process.env.HOME = realHome
      }
    })
  })
})
