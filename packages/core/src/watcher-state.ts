import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WatcherFileState {
  offset: number
  mtimeMs: number
}

export interface WatcherState {
  version: number
  files: Record<string, WatcherFileState>
}

const DEFAULT_STATE: WatcherState = { version: 1, files: {} }

export function loadWatcherState(statePath: string): WatcherState {
  if (!existsSync(statePath)) return { ...DEFAULT_STATE, files: {} }
  try {
    const raw = readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WatcherState>
    return {
      version: parsed.version ?? 1,
      files: parsed.files ?? {}
    }
  } catch {
    return { ...DEFAULT_STATE, files: {} }
  }
}

export function saveWatcherState(statePath: string, state: WatcherState): void {
  const dir = dirname(statePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, statePath)
}
