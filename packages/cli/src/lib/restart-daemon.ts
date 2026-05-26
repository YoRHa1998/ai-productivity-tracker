/**
 * Daemon 重启工具:用于 `aipt install` / 未来 `aipt restart` 子命令在升级
 * cli 后停掉老版本 daemon,让 ensureDaemon 顺势拉起新版本。
 *
 * 背景:daemon 通过 ensureDaemon 单实例锁机制守护;但 npm 全局升级 cli 后,
 * 老 daemon 进程仍守在内存里跑旧版本的 ESM bundle,导致后续浏览器看板 /
 * MCP 调用的全是旧路由(rc.13 用户实测命中 404 → /merge-split-iterations
 * 这条 rc.14 新增端点在跑着的 rc.12 daemon 上不存在)。
 *
 * 公共 API:
 * - `inspectRunningDaemon()` 读 runtime.json + pid 存活 + HTTP /status 探活,
 *   返回 daemon 自报的 version 字符串(供调用方与当前 cli VERSION 对比)
 * - `stopRunningDaemon()` SIGTERM → 优雅停机轮询 → 超时 SIGKILL 兜底 →
 *   保险清理 runtime.json
 *
 * 这两个函数都不做版本对比 / 拉新 daemon,职责单一;调用方决定何时停 + 拉新
 * 走 ensureDaemon 自然链路。
 */

import { isPidAlive, readRuntimeLock, removeRuntimeLock, type RuntimeLock } from './runtime-lock.js'

export interface RunningDaemonInfo {
  /** lockfile 存在 + pid 存活 + http /status OK */
  running: boolean
  /** runtime.json 内容;不存在时为 null */
  lock: RuntimeLock | null
  /**
   * daemon 自报的版本号(/status.data.version),只有 running=true 时非 null;
   * lockfile 残留但进程已退时也为 null。
   */
  daemonVersion: string | null
}

/**
 * 检测当前是否有 daemon 在跑,以及它自报的版本。
 *
 * 三态判定:
 *  - 无 lockfile / pid 不存活 → `{ running: false, daemonVersion: null }`
 *  - lockfile + pid 存活但 /status 探活失败 → `{ running: false, daemonVersion: null }`
 *  - 全部 OK → `{ running: true, daemonVersion: <版本字符串> }`
 *
 * 探活超时默认 800ms(对齐 doctor 的判定阈值),够大不会误杀慢启动 daemon,
 * 又够小不会拖慢 install 流程。
 */
export async function inspectRunningDaemon(probeTimeoutMs = 800): Promise<RunningDaemonInfo> {
  const lock = readRuntimeLock()
  if (!lock) return { running: false, lock: null, daemonVersion: null }
  if (!isPidAlive(lock.pid)) return { running: false, lock, daemonVersion: null }
  try {
    const res = await fetch(`http://${lock.host}:${lock.port}/status`, {
      signal: AbortSignal.timeout(probeTimeoutMs)
    })
    if (!res.ok) return { running: false, lock, daemonVersion: null }
    const body = (await res.json().catch(() => null)) as {
      data?: { version?: string }
    } | null
    const version = body?.data?.version ?? lock.version ?? null
    return { running: true, lock, daemonVersion: version }
  } catch {
    return { running: false, lock, daemonVersion: null }
  }
}

/**
 * 停机结果 4 态:
 *  - `not-running`:没有 daemon 在跑(无 lockfile 或 pid 早已不存活)
 *  - `graceful`:SIGTERM 后在 gracefulTimeoutMs 内进程优雅退出
 *  - `forced`:SIGTERM 超时,SIGKILL 兜底后进程退出
 *  - `timeout`:SIGKILL 都没让进程退(极罕见,系统级问题),lockfile 已强清
 */
export type StopDaemonStatus = 'not-running' | 'graceful' | 'forced' | 'timeout'

export interface StopDaemonResult {
  status: StopDaemonStatus
  /** 整个停机流程耗时(ms);not-running 时为 0 */
  durationMs: number
  /** 被停掉的进程 pid;not-running 且无 lockfile 时为 0 */
  pid: number
}

export interface StopDaemonOptions {
  /** SIGTERM 后等待优雅停机的最长时间(默认 3000ms) */
  gracefulTimeoutMs?: number
  /** 轮询 pid 存活的间隔(默认 100ms) */
  pollIntervalMs?: number
  /** 测试注入:覆盖 process.kill */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** 测试注入:覆盖 pid 存活探测 */
  isAlive?: (pid: number) => boolean
  /** 测试注入:覆盖 lockfile 读取(测试默认隔离 HOME 时一般不需要传) */
  readLock?: () => RuntimeLock | null
  /** 测试注入:覆盖 sleep(让单测能即时跳过等待) */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 优雅停掉当前正在跑的 daemon。
 *
 * 真实生产路径上 daemon 自己注册了 SIGTERM handler,会:
 *  1. 关闭 HTTP 监听 + 停 transcript-watcher
 *  2. 删除 runtime.json
 *  3. process.exit(0)
 *
 * 本函数只负责"通知 + 等待 + 兜底清理",不依赖 daemon 行为完美:即使 daemon
 * 卡死也会 SIGKILL + 手动删 lockfile,保证后续 ensureDaemon 能干净起新。
 */
export async function stopRunningDaemon(
  options: StopDaemonOptions = {}
): Promise<StopDaemonResult> {
  const readLock = options.readLock ?? readRuntimeLock
  const isAlive = options.isAlive ?? isPidAlive
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const sleep = options.sleep ?? defaultSleep
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3000
  const pollIntervalMs = options.pollIntervalMs ?? 100

  const lock = readLock()
  if (!lock) {
    return { status: 'not-running', durationMs: 0, pid: 0 }
  }

  if (!isAlive(lock.pid)) {
    // pid 早已不存活但 lockfile 残留 → 顺手清掉,后续 ensureDaemon 不再误判
    safeRemoveLock()
    return { status: 'not-running', durationMs: 0, pid: lock.pid }
  }

  const start = Date.now()

  try {
    kill(lock.pid, 'SIGTERM')
  } catch {
    // 竞态:发信号瞬间进程已退 → 当成 not-running
    safeRemoveLock()
    return { status: 'not-running', durationMs: Date.now() - start, pid: lock.pid }
  }

  while (Date.now() - start < gracefulTimeoutMs) {
    await sleep(pollIntervalMs)
    if (!isAlive(lock.pid)) {
      // daemon 自己会清 runtime.json,但若同 pid 的 lock 还残留(读 / 写竞态)兜底清一次
      const remaining = readLock()
      if (remaining && remaining.pid === lock.pid) safeRemoveLock()
      return { status: 'graceful', durationMs: Date.now() - start, pid: lock.pid }
    }
  }

  // 优雅退出超时 → SIGKILL
  try {
    kill(lock.pid, 'SIGKILL')
  } catch {
    /* SIGKILL 也可能因为 pid 在两次检查之间退出而失败,忽略 */
  }
  await sleep(pollIntervalMs)
  safeRemoveLock()
  return {
    status: isAlive(lock.pid) ? 'timeout' : 'forced',
    durationMs: Date.now() - start,
    pid: lock.pid
  }
}

function safeRemoveLock(): void {
  try {
    removeRuntimeLock()
  } catch {
    /* noop */
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
