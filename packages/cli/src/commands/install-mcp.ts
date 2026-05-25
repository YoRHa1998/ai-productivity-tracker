/**
 * `aipt install-mcp`:把 ai-productivity-tracker 这一项 MCP server 配置写到
 * `~/.cursor/mcp.json`。
 *
 * 策略:
 *   - 已存在 ai-productivity (或 ai-productivity-tracker) key → 覆盖
 *   - 不存在 → 追加
 *   - 不破坏其它 MCP server 条目
 *   - **缺省命令:`node <当前 cli.mjs 绝对路径> mcp`**(直接路径,零网络,
 *     启动 <100ms;Cursor / Claude Code 的 macOS GUI 子进程也能跑通)
 *     v1.0.0-rc.3 之前默认 `npx -y @ai-productivity-tracker/cli mcp`,实测在
 *     macOS GUI 应用启 MCP 子进程时容易因为 PATH / proxy / 网络超时而失败,
 *     现已切换到绝对路径。
 *   - 用户可显式 `--command npx --args="-y,@ai-productivity-tracker/cli,mcp"`
 *     回退到 npx 模式(便于 CI / 跨机器场景共享同份 mcp.json)。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface InstallMcpArgs {
  /** 写到指定路径(测试 / 自定义 IDE 时用),缺省为 ~/.cursor/mcp.json */
  configPath?: string
  /** 自定义入口命令(默认 `node`,即用绝对路径跑当前 cli.mjs) */
  command?: string
  args?: string[]
}

interface McpJson {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  [key: string]: unknown
}

export const MCP_SERVER_KEY = 'ai-productivity-tracker'
export const LEGACY_MCP_SERVER_KEYS = ['ai-productivity']

export async function runInstallMcp(args: InstallMcpArgs = {}): Promise<number> {
  const file = args.configPath ?? defaultCursorMcpJson()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let data: McpJson = {}
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf-8')) as McpJson
    } catch {
      console.error(`无法解析 ${file},终止以免破坏配置。请手动修复后重试。`)
      return 1
    }
  }
  // 数组也是 typeof object,这里显式拒绝并重建,避免后续把 server 写成数组项
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    data.mcpServers = {}
  }

  const command = args.command ?? 'node'
  const cmdArgs = args.args ?? [resolveCliEntry(), 'mcp']

  // 删除老 key("ai-productivity"),避免一台机器两条配置同时存在
  let replacedLegacy = false
  for (const legacyKey of LEGACY_MCP_SERVER_KEYS) {
    if (data.mcpServers[legacyKey]) {
      delete data.mcpServers[legacyKey]
      replacedLegacy = true
    }
  }

  const hadEntry = MCP_SERVER_KEY in data.mcpServers
  data.mcpServers[MCP_SERVER_KEY] = {
    command,
    args: cmdArgs
  }

  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')

  const verb = hadEntry ? '已更新' : '已新增'
  console.log(`${verb} MCP 配置: ${file}`)
  console.log(`  ${MCP_SERVER_KEY}: ${command} ${cmdArgs.join(' ')}`)
  if (replacedLegacy) {
    console.log(`  (顺手清除了老 key: ${LEGACY_MCP_SERVER_KEYS.join(', ')})`)
  }
  console.log('')
  console.log('重启 IDE (Cursor / Claude Code 等) 让 MCP 配置生效。')
  return 0
}

function defaultCursorMcpJson(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

/**
 * 当前 cli.mjs 的绝对路径(用于 MCP 配置内 args[0])。
 *
 * - 生产态 esbuild bundle:process.argv[1] = `<npm global>/.../cli/dist/cli.mjs`
 * - tsx dev 态:process.argv[1] = `<repo>/packages/cli/src/index.ts`
 *
 * 配套 cli/src/index.ts 已删除 isDirectRun symlink 判断,argv[1] 永远指向真实入口。
 */
function resolveCliEntry(): string {
  const arg1 = process.argv[1]
  if (!arg1) throw new Error('无法解析当前 cli 入口路径(process.argv[1] 为空)')
  return arg1
}
