/**
 * 极简日志:命令行场景输出到 stdout/stderr;daemon detached 场景输出到 logs/daemon.log。
 *
 * 不引入 winston / pino 等日志库以减少 bundle 体积;按需要扩展为按日滚动。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export function consoleLogger(prefix = ''): Logger {
  const p = prefix ? `[${prefix}] ` : ''
  return {
    info: (msg) => console.log(`${p}${msg}`),
    warn: (msg) => console.warn(`${p}${msg}`),
    error: (msg) => console.error(`${p}${msg}`)
  }
}

export function fileLogger(filePath: string, prefix = ''): Logger {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = prefix ? `[${prefix}] ` : ''
  const write = (level: string, msg: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${p}${msg}\n`
    try {
      appendFileSync(filePath, line, { mode: 0o600 })
    } catch {
      // 日志写盘失败不阻塞主流程
    }
  }
  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg)
  }
}
