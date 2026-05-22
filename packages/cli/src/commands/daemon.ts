/**
 * `aipt daemon`:前台启动 HTTP daemon。
 *
 * - 端口 / token 选择优先级:CLI args → AIPT_* env → config.json → runtime.json(复用上次) → 自动分配
 * - 启动后写 runtime.json
 * - SIGINT / SIGTERM 优雅停机:清 runtime.json + stop watcher + close server
 * - `--auto` 模式表示是被 ensureDaemon spawn-detached 拉起的子进程,不打印额外提示
 */

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle, type ServerConfig } from '@ai-productivity-tracker/server'

import { VERSION } from '../version.js'
import { readUserConfig } from '../lib/config.js'
import { aiptHome, dataRoot, ensureHomeDirs, logsDir } from '../lib/paths.js'
import { DEFAULT_PORT, pickAvailablePort } from '../lib/pick-port.js'
import {
  generateToken,
  readRuntimeLock,
  removeRuntimeLock,
  writeRuntimeLock
} from '../lib/runtime-lock.js'

export interface DaemonArgs {
  port?: number
  host?: string
  token?: string
  noWeb?: boolean
  auto?: boolean
}

export async function runDaemon(args: DaemonArgs = {}): Promise<number> {
  ensureHomeDirs()

  // 让 daemon 进程内部读到正确版本(其它包通过 env 读取)
  process.env.AIPT_VERSION = VERSION

  const config = await resolveServerConfig(args)
  if (!args.auto) {
    console.log(`Starting ai-productivity-tracker daemon (v${VERSION})`)
    console.log(`  host: ${config.host}`)
    console.log(`  port: ${config.port}`)
    console.log(`  dataRoot: ${config.dataRoot}`)
    console.log(`  webRoot: ${config.webRoot ?? '(disabled)'}`)
    console.log(`  logsDir: ${logsDir()}`)
  }

  let handle: DaemonHandle
  try {
    handle = await startDaemon(config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`daemon 启动失败: ${msg}`)
    return 1
  }

  // 写 runtime.json,供 mcp / hook / 看板浏览器复用
  writeRuntimeLock({
    pid: process.pid,
    port: handle.port,
    host: handle.host,
    token: config.token,
    startedAt: new Date().toISOString(),
    version: VERSION,
    dataRoot: config.dataRoot ?? dataRoot()
  })

  if (!args.auto) {
    console.log('')
    console.log(`Dashboard ready: http://${handle.host}:${handle.port}`)
    console.log('Stop with Ctrl+C.')
  }

  const shutdown = async (signal: string): Promise<void> => {
    if (!args.auto) console.log(`\nReceived ${signal}, shutting down...`)
    try {
      await handle.stop()
    } finally {
      removeRuntimeLock()
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // 前台 hang 住,不返回
  return new Promise<number>(() => {
    /* never resolves */
  })
}

async function resolveServerConfig(args: DaemonArgs): Promise<ServerConfig & { token: string }> {
  const user = readUserConfig()
  const existingLock = readRuntimeLock()

  // 端口选择:CLI > env > config.json > runtime.json(上次) > pick-port
  const preferred =
    args.port ?? parseEnvPort('AIPT_PORT') ?? user.port ?? existingLock?.port ?? DEFAULT_PORT
  const port = await pickAvailablePort(preferred)

  const host = args.host ?? process.env.AIPT_HOST ?? user.host ?? '127.0.0.1'

  // token 选择:CLI > env > 上次锁(复用) > 新生成
  const token =
    args.token ?? process.env.AIPT_TOKEN?.trim() ?? existingLock?.token ?? generateToken()

  const allowedOrigins = user.allowedOrigins ?? []
  const root = user.dataRoot ?? dataRoot()
  const webRoot = args.noWeb ? undefined : resolveDefaultWebRoot()

  return {
    port,
    host,
    token,
    allowedOrigins,
    dataRoot: root,
    webRoot
  }
}

function parseEnvPort(envName: string): number | undefined {
  const raw = process.env[envName]
  if (!raw) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined
}

/**
 * 解析看板 SPA 静态资源根目录。
 *
 * - 生产态(esbuild bundle):cli.mjs 同级的 web/ 目录,即 `<dist>/web/`
 * - tsx dev 态:相对源代码位置 `<repo>/packages/cli/dist/web/`(由 ui 包 vite build 产出)
 *
 * 找不到时返回 undefined,daemon 退化为 API-only(测试 / 极简部署场景)。
 */
function resolveDefaultWebRoot(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url)
    const dir = dirname(here)
    const candidates = [
      // 生产态:dist/web/ 与 dist/cli.mjs 同级
      `${dir}/web`,
      // tsx dev 态:src/commands/ → packages/cli/dist/web/
      `${dir}/../../dist/web`
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return undefined
  } catch {
    return undefined
  }
}

export { resolveServerConfig, resolveDefaultWebRoot, aiptHome }
