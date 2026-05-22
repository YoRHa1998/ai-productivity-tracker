/**
 * `aipt ui open`:在浏览器打开看板地址。
 *
 * - 若 daemon 已在跑 → 复用 endpoint
 * - 否则 spawn-detached 拉起 daemon 后再打开
 * - 跨平台:macOS open / Linux xdg-open / Windows start
 */

import { spawn } from 'node:child_process'
import { platform } from 'node:process'

import { ensureDaemon } from '../lib/ensure-daemon.js'

export async function runUi(subcommand?: string): Promise<number> {
  if (subcommand && subcommand !== 'open') {
    console.error(`未知 ui 子命令: ${subcommand}。仅支持 \`ui open\`。`)
    return 1
  }

  let endpoint: { baseUrl: string; token: string }
  try {
    const result = await ensureDaemon()
    endpoint = result.endpoint
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`无法连接或启动 daemon: ${msg}`)
    return 1
  }

  const url = endpoint.baseUrl
  console.log(`Opening dashboard: ${url}`)
  openUrl(url)
  return 0
}

function openUrl(url: string): void {
  const [cmd, args] = pickOpenerCommand(url)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (err) {
    console.warn(`自动打开浏览器失败,请手动访问 ${url}`)
    console.warn((err as Error).message)
  }
}

function pickOpenerCommand(url: string): [string, string[]] {
  switch (platform) {
    case 'darwin':
      return ['open', [url]]
    case 'win32':
      // 注意:start 是 cmd 内建命令,需要用 cmd /c 包一层
      return ['cmd', ['/c', 'start', '', url]]
    default:
      return ['xdg-open', [url]]
  }
}
