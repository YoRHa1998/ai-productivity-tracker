/**
 * Daemon 单实例锁 + 进程协调凭证 `~/.ai-productivity-tracker/runtime.json`。
 *
 * Schema(PRD §10.2):
 *   { pid, port, host, token, startedAt, version, dataRoot }
 *
 * 并发安全策略:
 * - 写入:tmp + rename 原子覆盖
 * - 互斥:利用 OS 内核的 file lock(通过 mode='wx' + 失败重试模拟,跨平台兼容)
 * - 探活:`process.kill(pid, 0)` 不会真发信号,只检查 pid 是否存在 + 当前用户有权限
 */

import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { ensureHomeDirs, runtimeJsonPath } from './paths.js'

export interface RuntimeLock {
  pid: number
  port: number
  host: string
  token: string
  startedAt: string
  version: string
  dataRoot: string
}

const FILE_MODE = 0o600

export function readRuntimeLock(): RuntimeLock | null {
  const file = runtimeJsonPath()
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RuntimeLock>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.token === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.version === 'string' &&
      typeof parsed.dataRoot === 'string'
    ) {
      return parsed as RuntimeLock
    }
    return null
  } catch {
    return null
  }
}

export function writeRuntimeLock(lock: RuntimeLock): void {
  ensureHomeDirs()
  const file = runtimeJsonPath()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', { mode: FILE_MODE })
  try {
    renameSync(tmp, file)
  } catch {
    // 极少数 FS rename 跨设备失败,降级直接写
    writeFileSync(file, JSON.stringify(lock, null, 2) + '\n', { mode: FILE_MODE })
    try {
      unlinkSync(tmp)
    } catch {
      /* noop */
    }
  }
}

export function removeRuntimeLock(): void {
  const file = runtimeJsonPath()
  if (existsSync(file)) {
    try {
      unlinkSync(file)
    } catch {
      /* noop */
    }
  }
}

/** pid 是否还在跑;0 信号不会真送但会触发 ESRCH / EPERM 区分 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM 表示 pid 存在但无权限发信号,仍视为存活(可能是 root 拉起的)
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** lockfile 是否过老(默认 24h);用于清理孤儿 lock */
export function isStaleLock(lock: RuntimeLock, maxAgeMs = 24 * 3600 * 1000): boolean {
  try {
    const startMs = Date.parse(lock.startedAt)
    if (Number.isNaN(startMs)) return true
    return Date.now() - startMs > maxAgeMs
  } catch {
    return true
  }
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/** 仅供测试/手动检视:lockfile 的真实存在性 + 权限位 */
export function describeRuntimeLockFile(): {
  exists: boolean
  mode: number | null
  size: number | null
} {
  const file = runtimeJsonPath()
  if (!existsSync(file)) return { exists: false, mode: null, size: null }
  try {
    const st = statSync(file)
    return { exists: true, mode: st.mode & 0o777, size: st.size }
  } catch {
    return { exists: true, mode: null, size: null }
  }
}
