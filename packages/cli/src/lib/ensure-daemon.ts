/**
 * 单实例 daemon 拉起 / 重用策略(PRD §3.4)。
 *
 * 调用方(mcp / hook / ui open)调 `ensureDaemon()` 时:
 *   1. 读 runtime.json
 *   2. 锁里的 pid 存活 + http 探活 OK → 直接复用
 *   3. 否则 spawn-detached 一个新 daemon,写 lockfile,等就绪
 *
 * spawn 子进程的 entry 是当前进程的入口(`process.argv[1]`),通过 `daemon` 子命令复用 cli。
 * stdio 全部 detach,避免父进程退出时连累 daemon。
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

import { aiptHome, logsDir, ensureHomeDirs } from './paths.js'
import {
  generateToken,
  isPidAlive,
  isStaleLock,
  readRuntimeLock,
  type RuntimeLock
} from './runtime-lock.js'
import { stopRunningDaemon } from './restart-daemon.js'
import { DEFAULT_PORT } from './pick-port.js'

export interface EnsureDaemonOptions {
  /** 强制忽略已存在 lock 并新起 daemon(配合 `--force-restart`) */
  forceRestart?: boolean
  /** 等待 daemon 就绪的最长时间(ms),默认 5000 */
  readyTimeoutMs?: number
  /** 自定义 cli 入口绝对路径(测试用) */
  cliEntry?: string
}

export interface EnsureDaemonResult {
  /** 'reused' = 复用已有 daemon;'spawned' = 本次新起;'unchanged' = 已有 daemon 不健康但 forceRestart=false 时不动 */
  kind: 'reused' | 'spawned'
  endpoint: { baseUrl: string; token: string }
  pid: number
  port: number
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  ensureHomeDirs()

  const timeout = options.readyTimeoutMs ?? 5000
  const cliEntry = options.cliEntry ?? resolveCliEntry()

  const existing = readRuntimeLock()
  if (!options.forceRestart && existing && (await isHealthyLock(existing))) {
    return {
      kind: 'reused',
      endpoint: { baseUrl: `http://${existing.host}:${existing.port}`, token: existing.token },
      pid: existing.pid,
      port: existing.port
    }
  }

  // 走到这里 = 不复用(无 lock / lock 不健康 / forceRestart)。
  //
  // 关键修复:若 runtime.json 记录的旧 daemon **进程仍存活**,必须先回收它再起新的。
  // 最典型的场景是 isStaleLock 按 24h 龄把「还活着、还在服务、端口还占着」的 daemon
  // 判成不健康——若此时只 spawn 新 daemon 而不杀旧的,会连环踩两个坑:
  //   ① 旧端口仍被占 → 新 daemon 的 pickAvailablePort 漂移到下一个端口(每次 +1);
  //   ② 旧进程被 init 收养成孤儿长期挂着,日积月累堆出一片占用 17350+ 的僵尸 daemon,
  //      甚至漂到 vite dev 端口(17351)上,害得本地看板命中老代码、报「响应非 JSON」。
  // stopRunningDaemon 会 SIGTERM → 轮询 → 超时 SIGKILL 兜底,并清掉 runtime.json;
  // 它返回后旧端口已释放,新 daemon 即可稳定复用 DEFAULT_PORT,不再逐次漂移。
  if (existing && isPidAlive(existing.pid)) {
    await stopRunningDaemon()
  }

  // 拉起新 daemon。token 与 port 在 daemon 进程内分配并写 runtime.json。
  const token = generateToken()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIPT_TOKEN: token,
    AIPT_HOST: '127.0.0.1'
  }

  const outFd = openSync(join(logsDir(), 'daemon-out.log'), 'a', 0o600)
  const errFd = openSync(join(logsDir(), 'daemon-err.log'), 'a', 0o600)

  const child = spawn(process.execPath, [cliEntry, 'daemon', '--auto'], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env,
    windowsHide: true,
    cwd: aiptHome()
  })
  child.unref()

  // 轮询 runtime.json 直到 pid/port/token 全部落齐 + 探活 OK
  const startWait = Date.now()
  while (Date.now() - startWait < timeout) {
    await sleep(120)
    const lock = readRuntimeLock()
    if (lock && lock.pid === child.pid && (await isHealthyLock(lock))) {
      return {
        kind: 'spawned',
        endpoint: { baseUrl: `http://${lock.host}:${lock.port}`, token: lock.token },
        pid: lock.pid,
        port: lock.port
      }
    }
    // 子进程立即退出
    if (child.exitCode !== null) {
      throw new Error(`daemon 启动失败 (exit ${child.exitCode}),请查看 ${logsDir()}/daemon-err.log`)
    }
  }
  throw new Error(
    `daemon 在 ${timeout}ms 内未就绪。请检查 ${logsDir()}/daemon-err.log 或手动跑 \`ai-productivity-tracker daemon\` 排错。`
  )
}

async function isHealthyLock(lock: RuntimeLock): Promise<boolean> {
  if (!isPidAlive(lock.pid)) return false
  if (isStaleLock(lock)) return false
  return ping(`http://${lock.host}:${lock.port}/status`, 800)
}

async function ping(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 解析当前 cli 入口的绝对路径(供 spawn 子进程作为 entry)。
 *
 * - 生产态(esbuild bundle):`process.argv[1]` 形如 `/usr/local/.../cli.mjs`
 * - tsx dev 态:`process.argv[1]` 形如 `<repo>/packages/cli/src/index.ts`
 */
function resolveCliEntry(): string {
  const arg1 = process.argv[1]
  if (!arg1) {
    throw new Error('无法解析当前 cli 入口路径(process.argv[1] 为空)')
  }
  return arg1
}

export { DEFAULT_PORT }
