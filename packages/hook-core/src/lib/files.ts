import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { resolve } from 'node:path'

export type BindingEntry = {
  jiraKey: string
  branch: string
  startedAt: string
  cumulativeToken: number
  lastIterationSeq: number
  lastReportedAt: string | null
  requirementStartedAt?: string | null
  lastHookFiredAt?: string | null
}

export type PendingEntry = {
  branch: string
  firstSeenAt: string
  cumulativeToken: number
}

export type BindingsFile = {
  version: number
  bindings: Record<string, BindingEntry>
  pending: Record<string, PendingEntry>
}

export function readBindings(bindingsFilePath: string): BindingsFile {
  if (!existsSync(bindingsFilePath)) {
    return { version: 1, bindings: {}, pending: {} }
  }

  try {
    const raw = readFileSync(bindingsFilePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<BindingsFile>
    return {
      version: parsed.version ?? 1,
      bindings: parsed.bindings ?? {},
      pending: parsed.pending ?? {}
    }
  } catch {
    return { version: 1, bindings: {}, pending: {} }
  }
}

function acquireLock(lockPath: string, timeoutMs = 3000): number {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = openSync(lockPath, 'wx')
      return fd
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        const age = Date.now() - start
        if (age > timeoutMs) {
          break
        }
        const endWait = Date.now() + 50
        while (Date.now() < endWait) {
          // busy wait 50ms
        }
        continue
      }
      throw err
    }
  }

  try {
    unlinkSync(lockPath)
  } catch {
    // ignore
  }
  const fd = openSync(lockPath, 'wx')
  return fd
}

function releaseLock(fd: number, lockPath: string) {
  try {
    closeSync(fd)
  } catch {
    // ignore
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // ignore
  }
}

export function withBindingsLock<T>(
  bindingsFilePath: string,
  fn: (current: BindingsFile) => BindingsFile | { next: BindingsFile; result: T }
): T | BindingsFile {
  const lockPath = `${bindingsFilePath}.lock`
  const fd = acquireLock(lockPath)
  try {
    const current = readBindings(bindingsFilePath)
    const output = fn(current)
    const next = 'next' in output ? output.next : output
    const tmp = `${bindingsFilePath}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
    renameSync(tmp, bindingsFilePath)
    return 'next' in output ? output.result : output
  } finally {
    releaseLock(fd, lockPath)
  }
}

export function resolveFromAip(aipDir: string, file: string): string {
  return resolve(aipDir, file)
}
