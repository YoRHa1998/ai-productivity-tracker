import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { AgentClient } from './agent-client.js'
import { registerAiProductivityTools } from './tools.js'

declare const __VERSION__: string
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev'

/** v1.0 起优先读 AIPT_* env;同时保留 TRUESIGHT_* 老 env 兼容,空字符串与未设置等价 */
function readEnvWithLegacy(primary: string, legacy: string, fallback?: string): string {
  const main = process.env[primary]?.trim()
  if (main) return main
  const legacyVal = process.env[legacy]?.trim()
  if (legacyVal) return legacyVal
  if (fallback !== undefined) return fallback
  console.error(`[ai-productivity-mcp] 缺少必需环境变量 ${primary}(或 legacy ${legacy})`)
  process.exit(1)
}

export interface MainDeps {
  /**
   * 注入用,默认动态 import 真实 hook-core 的 runHook。
   * 测试场景或 mock 时可以传入替身,避免真的读 stdin / 调网络。
   */
  hookRunner?: () => Promise<void>
  /** v2.8.0 stop-check 入口替身 */
  stopCheckRunner?: () => Promise<void>
  /**
   * v2.10.0 起 mark-tool-called 已下线,argv 仍可命中此分支但默认实现静默 exit 0;
   * 测试可注入替身验证 argv 路由命中.
   */
  markToolCalledRunner?: () => Promise<void>
  /** 注入参数,默认走 process.argv */
  argv?: string[]
  /** 是否实际启动 stdio MCP server,测试可以传 false */
  startServer?: boolean
}

export async function startMcpServer(): Promise<void> {
  const baseUrl = readEnvWithLegacy(
    'AIPT_DAEMON_URL',
    'TRUESIGHT_AGENT_URL',
    'http://127.0.0.1:17350'
  )
  const token = readEnvWithLegacy('AIPT_DAEMON_TOKEN', 'TRUESIGHT_AGENT_TOKEN')

  const client = new AgentClient({ baseUrl, token })
  const server = new McpServer(
    { name: 'ai-productivity-mcp', version: VERSION },
    {
      instructions:
        '通过本地 ai-productivity-tracker daemon 创建 / 查询 AI 提效追踪需求。开始一个新 Jira 需求时调用 ai_productivity_init;若想了解当前分支的追踪状态调用 ai_productivity_status。'
    }
  )

  registerAiProductivityTools(server, client)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[ai-productivity-mcp] running (v${VERSION}) -> ${baseUrl}`)
}

export type MainOutcome = 'hook' | 'stop-check' | 'mark-tool-called' | 'mcp'

/**
 * 入口分发:同一份 .mjs 同时承担多个角色,通过 argv[2] 切换:
 *   - hook            → afterAgentResponse / Stop hook 的 token 累计 + iteration 落盘
 *   - stop-check      → v2.8.0 防伪造校验:扫描 sentinel,缺失时输出 followup_message / decision:block
 *   - mark-tool-called → @deprecated v2.10.0 已下线;argv 仍兼容(老 hooks.json 还指向它)
 *                        默认静默 exit 0,不再写 sentinel(改由 agent attach-summary handler 同步写)
 *   - 其他            → 启动 stdio MCP server(IDE 拉起)
 */
export async function main(deps: MainDeps = {}): Promise<MainOutcome> {
  const argv = deps.argv ?? process.argv
  if (argv[2] === 'hook') {
    const run =
      deps.hookRunner ??
      (async () => {
        const mod = await import('@ai-productivity-tracker/hook-core')
        await mod.runHook()
      })
    await run()
    return 'hook'
  }
  if (argv[2] === 'stop-check') {
    const run =
      deps.stopCheckRunner ??
      (async () => {
        const mod = await import('@ai-productivity-tracker/hook-core')
        await mod.runStopCheckCli()
      })
    await run()
    return 'stop-check'
  }
  if (argv[2] === 'mark-tool-called') {
    // v2.10.0 deprecated:老 hooks.json 仍指向此入口,保留静默兼容防止报错。
    // 用户点一次 Settings「一键注入 Skill」会自动从 hooks.json 删除该条目。
    const run =
      deps.markToolCalledRunner ??
      (async () => {
        /* no-op */
      })
    await run()
    return 'mark-tool-called'
  }
  if (deps.startServer === false) return 'mcp'
  await startMcpServer()
  return 'mcp'
}

// v1.0 起 mcp 不再独立运行;统一由 @ai-productivity-tracker/cli 的 argv-router 调度。
// 老的 isDirectRun 自启动入口删除,避免被 cli 包 esbuild bundle 时内联触发副作用。
