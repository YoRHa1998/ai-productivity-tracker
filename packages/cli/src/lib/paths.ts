/**
 * AI Productivity Tracker 在用户机器上的标准路径布局。
 *
 *   ~/.ai-productivity-tracker/
 *   ├── config.json        # 用户配置(可选,持久化偏好如端口/数据根)
 *   ├── runtime.json       # daemon 进程协调凭证(pid/port/token)
 *   ├── logs/              # daemon 日志
 *   ├── hook-state/        # sentinel 时间窗文件
 *   └── data/              # 业务数据根 (=@ai-productivity-tracker/core 数据落盘位置)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const HOME_DIR_NAME = '.ai-productivity-tracker'
export const LEGACY_HOME_DIR_NAME = '.truesight-local-agent'

export function aiptHome(): string {
  return resolve(homedir(), HOME_DIR_NAME)
}

export function legacyAiptHome(): string {
  return resolve(homedir(), LEGACY_HOME_DIR_NAME)
}

export function runtimeJsonPath(): string {
  return join(aiptHome(), 'runtime.json')
}

export function configJsonPath(): string {
  return join(aiptHome(), 'config.json')
}

export function logsDir(): string {
  return join(aiptHome(), 'logs')
}

export function dataRoot(): string {
  const envRoot = process.env.AIPT_DATA_ROOT?.trim()
  if (envRoot) return resolve(envRoot)
  const legacyEnvRoot = process.env.TRUESIGHT_AIP_ROOT?.trim()
  if (legacyEnvRoot) return resolve(legacyEnvRoot)
  return join(aiptHome(), 'data')
}

export function legacyDataRoot(): string {
  return join(legacyAiptHome(), 'ai-productivity')
}

/** 确保 home / logs 目录存在,首次运行触发 */
export function ensureHomeDirs(): void {
  const home = aiptHome()
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
  const logs = logsDir()
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true, mode: 0o700 })
}
