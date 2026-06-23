/**
 * `aipt install-mcp`:把 ai-productivity-tracker 这一项 MCP server 配置写到
 * IDE 的本机 MCP 配置文件:
 *
 *   - Cursor: `~/.cursor/mcp.json`(顶层 `mcpServers` 字典,entry 无 `type` 字段)
 *   - Claude Code: `~/.claude.json`(顶层 `mcpServers` 字典,entry 必填 `type: "stdio"`)
 *
 * 行为契约:
 *   - 已存在 ai-productivity (或 ai-productivity-tracker) key → 覆盖
 *   - 不存在 → 追加
 *   - 不破坏其它 MCP server 条目,也不破坏 ~/.claude.json 顶层其它字段
 *     (numStartups / theme / projects / userID / ...)
 *   - 缺省命令:`node <当前 cli.mjs 绝对路径> mcp`(直接路径,零网络,启动 <100ms;
 *     Cursor / Claude Code 的 macOS GUI 子进程也能跑通)
 *     v1.0.0-rc.3 之前默认 `npx -y @ai-productivity-tracker/cli mcp`,实测在
 *     macOS GUI 应用启 MCP 子进程时容易因为 PATH / proxy / 网络超时而失败,
 *     现已切换到绝对路径。
 *   - 用户可显式 `--command npx --args="-y,@ai-productivity-tracker/cli,mcp"`
 *     回退到 npx 模式(便于 CI / 跨机器场景共享同份 mcp.json)。
 *
 * v1.0.0-rc.16+ 修复:之前 `aipt install` 只动 Cursor 的 mcp.json,完全漏掉
 * Claude Code 的 ~/.claude.json,导致 Claude Code 用户看板永远拿不到 MCP 数据。
 * 现在 install / install-mcp 默认对两个 IDE 都写入(`--ide=cursor|claude|all`,
 * 默认 all)。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { upsertCodexMcpConfig } from '../lib/codex-mcp-config.js'

export type InstallMcpTarget = 'cursor' | 'claude' | 'codex'

export interface InstallMcpArgs {
  /**
   * 注入到哪个 IDE 的 MCP 配置文件:
   *   - 'cursor' → ~/.cursor/mcp.json (entry 不带 type 字段)
   *   - 'claude' → ~/.claude.json (entry 带 type: 'stdio')
   * 缺省 'cursor'(单 target 调用时保持与 rc.15 之前的行为一致;
   * 真正的"装两个 IDE"统一走 `runInstallMcpAll` / `aipt install`)。
   */
  target?: InstallMcpTarget
  /** 写到指定路径(测试 / 自定义 IDE 时用),缺省按 target 选 */
  configPath?: string
  /** 自定义入口命令(默认 `process.execPath`,即用绝对路径跑当前 cli.mjs) */
  command?: string
  args?: string[]
}

/**
 * `aipt install-mcp` / `aipt install` 默认调用入口:同时注入 Cursor + Claude Code。
 * 任一文件写失败不阻断另一个,聚合返回最严重的 exit code。
 */
export interface InstallMcpAllArgs {
  /** 'cursor' | 'claude' | 'codex' | 'all'(默认 'all') */
  ide?: 'cursor' | 'claude' | 'codex' | 'all'
  command?: string
  args?: string[]
}

interface McpEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  type?: string
  // Claude Code 同 server 可能带 url / headers 等其它字段(http / sse type),
  // 但我们只写 stdio,这里只声明会用到的字段。
  [k: string]: unknown
}

interface McpJson {
  mcpServers?: Record<string, McpEntry>
  [key: string]: unknown
}

export const MCP_SERVER_KEY = 'ai-productivity-tracker'
export const LEGACY_MCP_SERVER_KEYS = ['ai-productivity']

/**
 * 给 install / 看板复用的"装两个 IDE"聚合入口。
 * 任一 target 失败会打印 warn,但继续装另一个;最终 exit code 取两者最大值。
 */
export async function runInstallMcpAll(args: InstallMcpAllArgs = {}): Promise<number> {
  const ide = args.ide ?? 'all'
  let worst = 0
  if (ide === 'all' || ide === 'cursor') {
    const code = await runInstallMcp({
      target: 'cursor',
      command: args.command,
      args: args.args
    })
    if (code > worst) worst = code
  }
  if (ide === 'all' || ide === 'claude') {
    const code = await runInstallMcp({
      target: 'claude',
      command: args.command,
      args: args.args
    })
    if (code > worst) worst = code
  }
  if (ide === 'all' || ide === 'codex') {
    const code = await runInstallMcp({
      target: 'codex',
      command: args.command,
      args: args.args
    })
    if (code > worst) worst = code
  }
  return worst
}

export async function runInstallMcp(args: InstallMcpArgs = {}): Promise<number> {
  const target: InstallMcpTarget = args.target ?? 'cursor'
  const file = args.configPath ?? defaultMcpJsonForTarget(target)
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Codex 的 MCP 配置是 TOML,走外科式文本 upsert,不与 JSON 路径共用逻辑。
  if (target === 'codex') {
    return runInstallMcpCodex(file, args)
  }

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

  // 用 process.execPath(当前 node 二进制的绝对路径)而不是 'node':
  // macOS GUI 应用(Cursor / Claude Code)从 launchd 启动时 PATH 只有
  // /usr/bin:/bin:/usr/sbin:/sbin,nvm/volta/fnm 等装的 node 不在里面,
  // `command: 'node'` 会被 IDE 启 MCP 子进程时报 ENOENT。
  const command = args.command ?? process.execPath
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
  const entry: McpEntry = {
    command,
    args: cmdArgs
  }
  // Claude Code 官方 schema 要求每个 server 带 `type`,缺失时启动会跳过该 entry。
  // Cursor 不需要也不识别该字段,显式区分写入。
  if (target === 'claude') {
    entry.type = 'stdio'
  }
  data.mcpServers[MCP_SERVER_KEY] = entry

  const payload = JSON.stringify(data, null, 2) + '\n'
  // ~/.claude.json 默认 mode=0600(私有,可能含 Jira API token 等敏感 env),
  // ~/.cursor/mcp.json 由 Cursor 创建时默认 0644。
  // 写时统一指定 mode,Node 已存在文件时也会沿用新 mode(rewrite 覆盖)。
  const fileMode = target === 'claude' ? 0o600 : 0o644
  writeFileSync(file, payload, { mode: fileMode })

  const verb = hadEntry ? '已更新' : '已新增'
  const ideLabel = target === 'claude' ? 'Claude Code' : 'Cursor'
  console.log(`${verb} ${ideLabel} MCP 配置: ${file}`)
  console.log(`  ${MCP_SERVER_KEY}: ${command} ${cmdArgs.join(' ')}`)
  if (replacedLegacy) {
    console.log(`  (顺手清除了老 key: ${LEGACY_MCP_SERVER_KEYS.join(', ')})`)
  }
  return 0
}

/**
 * Codex 专用:把我们的 mcp_servers 块 upsert 进 ~/.codex/config.toml(TOML)。
 *
 * - 写前备份 `${file}.bak`(config.toml 是用户手维护的敏感文件)
 * - 只动我们这一个 `[mcp_servers."ai-productivity-tracker"]` 块,其余字节原样保留
 * - 与 Cursor/Claude 一样零 env:`aipt mcp` 自读 runtime.json 拿 token
 */
function runInstallMcpCodex(file: string, args: InstallMcpArgs): number {
  const command = args.command ?? process.execPath
  const cmdArgs = args.args ?? [resolveCliEntry(), 'mcp']

  let original = ''
  if (existsSync(file)) {
    try {
      original = readFileSync(file, 'utf-8')
    } catch {
      console.error(`无法读取 ${file},终止以免破坏配置。请手动修复后重试。`)
      return 1
    }
    // 写前备份,误改可手动还原
    try {
      copyFileSync(file, `${file}.bak`)
    } catch {
      // 备份失败不阻断(目录权限等),但提示用户
      console.warn(`  (备份 ${file}.bak 失败,继续写入)`)
    }
  }

  const { text, hadEntry, replacedLegacy } = upsertCodexMcpConfig(original, command, cmdArgs)
  // config.toml 默认 0600(可能含 provider token 等敏感信息)
  writeFileSync(file, text, { mode: 0o600 })

  const verb = hadEntry ? '已更新' : '已新增'
  console.log(`${verb} Codex MCP 配置: ${file}`)
  console.log(`  ${MCP_SERVER_KEY}: ${command} ${cmdArgs.join(' ')}`)
  if (replacedLegacy) {
    console.log(`  (顺手清除了老 key: ${LEGACY_MCP_SERVER_KEYS.join(', ')})`)
  }
  return 0
}

export function defaultMcpJsonForTarget(target: InstallMcpTarget): string {
  if (target === 'claude') {
    // Claude Code(claude-code CLI)统一把 mcpServers 放在 ~/.claude.json 顶层。
    // 注意不是 ~/.claude/ 目录里(那个目录管 skills / settings / sessions 等)。
    return join(homedir(), '.claude.json')
  }
  if (target === 'codex') {
    return join(homedir(), '.codex', 'config.toml')
  }
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
