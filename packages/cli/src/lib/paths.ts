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
/**
 * 开发态/沙箱用 home 目录覆盖 env。生产链路严禁设置(会让全局 cli 找不到 runtime.json)。
 *
 * 典型用法见 `scripts/dev.mjs`:把 dev daemon 的 runtime.json / logs / hook-state
 * 全部隔离到仓库内 `.dev-home/`,同时通过 `AIPT_DATA_ROOT` 显式共享真实生产 data 目录,
 * 实现「数据共享 + daemon 不互踩」的本地开发体验。
 */
export const HOME_DIR_ENV = 'AIPT_HOME_DIR'

export function aiptHome(): string {
  const envHome = process.env[HOME_DIR_ENV]?.trim()
  if (envHome) return resolve(envHome)
  return resolve(homedir(), HOME_DIR_NAME)
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
  return join(aiptHome(), 'data')
}

/** 确保 home / logs 目录存在,首次运行触发 */
export function ensureHomeDirs(): void {
  const home = aiptHome()
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 })
  const logs = logsDir()
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true, mode: 0o700 })
}
