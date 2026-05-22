/**
 * 用户主配置 `~/.ai-productivity-tracker/config.json` 读写。
 *
 * 仅做轻量校验,不抛错,缺字段全部使用默认值。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { configJsonPath, ensureHomeDirs } from './paths.js'

export interface UserConfig {
  port?: number
  host?: string
  allowedOrigins?: string[]
  dataRoot?: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRotateDays?: number
  watcher?: {
    enabled?: boolean
    claudeProjectsDir?: string
    staleTurnFlushMs?: number
  }
}

export function readUserConfig(): UserConfig {
  const file = configJsonPath()
  if (!existsSync(file)) return {}
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as UserConfig
  } catch {
    return {}
  }
}

export function writeUserConfig(patch: UserConfig): UserConfig {
  ensureHomeDirs()
  const current = readUserConfig()
  const merged: UserConfig = {
    ...current,
    ...patch,
    watcher: { ...(current.watcher ?? {}), ...(patch.watcher ?? {}) }
  }
  writeFileSync(configJsonPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  return merged
}
