/**
 * `aipt mcp`:启动 stdio MCP server。
 *
 * 启动顺序:
 *   1. ensureDaemon():检测 / 拉起单例 daemon
 *   2. 把 endpoint(baseUrl + token)塞进 env,供 @ai-productivity-tracker/mcp 读取
 *   3. 调 startMcpServer() 进入 stdio 阻塞
 *
 * 失败时(daemon 起不来 / 探活超时)stderr 打印明确指引,然后 exit 1 让 IDE 看到 MCP 不可用。
 */

import { startMcpServer } from '@ai-productivity-tracker/mcp'

import { ensureDaemon } from '../lib/ensure-daemon.js'

export async function runMcp(): Promise<number> {
  let endpoint: { baseUrl: string; token: string }
  try {
    const result = await ensureDaemon()
    endpoint = result.endpoint
    if (result.kind === 'spawned') {
      console.error(
        `[ai-productivity-tracker] daemon spawned on ${endpoint.baseUrl} (pid=${result.pid})`
      )
    } else {
      console.error(
        `[ai-productivity-tracker] reusing daemon ${endpoint.baseUrl} (pid=${result.pid})`
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ai-productivity-tracker] mcp 启动失败:${msg}`)
    return 1
  }

  // 注入到 env 供 @ai-productivity-tracker/mcp 的 startMcpServer 读取
  process.env.AIPT_DAEMON_URL = endpoint.baseUrl
  process.env.AIPT_DAEMON_TOKEN = endpoint.token

  try {
    await startMcpServer()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ai-productivity-tracker] mcp server 异常退出:${msg}`)
    return 1
  }
  return 0
}
