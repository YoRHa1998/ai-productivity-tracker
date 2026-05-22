/**
 * `@ai-productivity-tracker/cli` 主入口 — argv-router。
 *
 * 单 bin 多角色:第一个 arg 决定行为分支(详见 PRD §3.3)。
 *
 *   ai-productivity-tracker <command> [options]
 *
 * 当被 esbuild bundle 后,产物 dist/cli.mjs 同时承担:
 *   - IDE 的 MCP server(`mcp`)
 *   - 后台 HTTP daemon(`daemon`)
 *   - Cursor / Claude IDE hook(`hook` / `stop-check`)
 *   - 各类管理子命令(`install` / `migrate` / `doctor` / `ui` / ...)
 */

import { runDaemon, type DaemonArgs } from './commands/daemon.js'
import { runDoctor } from './commands/doctor.js'
import { runHelp } from './commands/help.js'
import { runHookCommand } from './commands/hook.js'
import { runInstall, type InstallArgs, type InstallTargetIde } from './commands/install.js'
import { runInstallMcp } from './commands/install-mcp.js'
import { runMcp } from './commands/mcp.js'
import { runMigrate, type MigrateArgs } from './commands/migrate.js'
import { runStopCheckCommand } from './commands/stop-check.js'
import { runUi } from './commands/ui.js'
import { runVersion } from './commands/version.js'

export type ExitCode = number

export async function main(argv: string[] = process.argv): Promise<ExitCode> {
  const command = argv[2]?.trim()
  const rest = argv.slice(3)

  switch (command) {
    case undefined:
    case '':
    case '-h':
    case '--help':
    case 'help':
      return runHelp()

    case '-v':
    case '--version':
    case 'version':
      return runVersion()

    case 'mcp':
      return runMcp()

    case 'daemon':
    case 'serve':
      return runDaemon(parseDaemonArgs(rest))

    case 'hook':
      return runHookCommand()

    case 'stop-check':
      return runStopCheckCommand()

    case 'mark-tool-called':
      // v2.10.0 起下线;保留静默兼容防止老 hooks.json 报错(同源仓库的 argv-router)
      return 0

    case 'ui':
      return runUi(rest[0])

    case 'install':
      return runInstall(parseInstallArgs(rest))

    case 'install-mcp':
      return runInstallMcp({})

    case 'migrate':
      return runMigrate(parseMigrateArgs(rest))

    case 'doctor':
      return runDoctor()

    default:
      console.error(`未知命令: ${command}\n用 \`ai-productivity-tracker --help\` 查看可用命令。`)
      return 1
  }
}

// ────────────────────────────────────────────────────────────────────
// Arg parsers (轻量手写,不引外部库以减小 bundle 体积)
// ────────────────────────────────────────────────────────────────────

function parseDaemonArgs(rest: string[]): DaemonArgs {
  const args: DaemonArgs = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--port') {
      const next = rest[++i]
      if (next) args.port = parseInt(next, 10)
    } else if (a === '--host') {
      args.host = rest[++i]
    } else if (a === '--token') {
      args.token = rest[++i]
    } else if (a === '--no-web') {
      args.noWeb = true
    } else if (a === '--auto') {
      args.auto = true
    }
  }
  return args
}

function parseInstallArgs(rest: string[]): InstallArgs {
  const args: InstallArgs = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--ide=')) {
      const v = a.slice('--ide='.length) as InstallTargetIde
      if (v === 'cursor' || v === 'claude' || v === 'all') args.ide = v
    } else if (a === '--ide') {
      const v = rest[++i] as InstallTargetIde | undefined
      if (v === 'cursor' || v === 'claude' || v === 'all') args.ide = v
    } else if (a === '--debug') {
      args.debug = true
    } else if (a === '--hook-entry') {
      args.hookEntry = rest[++i]
    }
  }
  return args
}

function parseMigrateArgs(rest: string[]): MigrateArgs {
  const args: MigrateArgs = {}
  for (const a of rest) {
    if (a === '--force' || a === '-f') args.force = true
  }
  return args
}

// 直接被 node 调用时启动 main;被 import 时不自动执行(测试场景)。
const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('fatal:', err)
      process.exit(1)
    }
  )
}
