/**
 * `aipt install-mcp`:把 ai-productivity-tracker 这一项 MCP server 配置写到
 * `~/.cursor/mcp.json`。
 *
 * 策略:
 *   - 已存在 ai-productivity (或 ai-productivity-tracker) key → 覆盖
 *   - 不存在 → 追加
 *   - 不破坏其它 MCP server 条目
 *   - 缺省命令:`npx -y @ai-productivity-tracker/cli mcp`(无 npx 网络可用时,
 *     在 doctor 命令里再提示用绝对路径)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface InstallMcpArgs {
  /** 写到指定路径(测试 / 自定义 IDE 时用),缺省为 ~/.cursor/mcp.json */
  configPath?: string
  /** 自定义入口命令(默认 `npx -y @ai-productivity-tracker/cli mcp`) */
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

  const command = args.command ?? 'npx'
  const cmdArgs = args.args ?? ['-y', '@ai-productivity-tracker/cli', 'mcp']

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
