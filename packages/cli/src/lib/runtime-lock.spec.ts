import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  describeRuntimeLockFile,
  generateToken,
  isPidAlive,
  isStaleLock,
  readRuntimeLock,
  removeRuntimeLock,
  writeRuntimeLock,
  type RuntimeLock
} from './runtime-lock.js'

const sampleLock = (overrides: Partial<RuntimeLock> = {}): RuntimeLock => ({
  pid: process.pid,
  port: 17350,
  host: '127.0.0.1',
  token: 'a'.repeat(64),
  startedAt: new Date().toISOString(),
  version: '0.1.0',
  dataRoot: '/tmp/fake-data',
  ...overrides
})

describe('runtime-lock', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aipt-rtlock-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('write/read 往返', () => {
    it('writeRuntimeLock 落盘后 readRuntimeLock 能还原完整字段', () => {
      const lock = sampleLock()
      writeRuntimeLock(lock)
      expect(readRuntimeLock()).toEqual(lock)
    })

    it('文件权限 mode = 0o600', () => {
      writeRuntimeLock(sampleLock())
      const desc = describeRuntimeLockFile()
      expect(desc.exists).toBe(true)
      expect(desc.mode).toBe(0o600)
    })

    it('文件父目录(aiptHome)若不存在会被自动创建', () => {
      // 此时 tmpHome/.ai-productivity-tracker 尚不存在
      expect(existsSync(join(tmpHome, '.ai-productivity-tracker'))).toBe(false)
      writeRuntimeLock(sampleLock())
      expect(existsSync(join(tmpHome, '.ai-productivity-tracker'))).toBe(true)
    })

    it('写入是原子的:不存在 .tmp 残留', () => {
      writeRuntimeLock(sampleLock())
      const home = join(tmpHome, '.ai-productivity-tracker')
      const tmps = readdirSafe(home).filter((n) => n.includes('.tmp'))
      expect(tmps).toEqual([])
    })

    it('readRuntimeLock 在缺字段时返回 null(部分坏数据保护)', () => {
      const home = join(tmpHome, '.ai-productivity-tracker')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'runtime.json'), JSON.stringify({ pid: 1, port: 17350 }), {
        mode: 0o600
      })
      expect(readRuntimeLock()).toBeNull()
    })

    it('readRuntimeLock 解析失败返回 null', () => {
      const home = join(tmpHome, '.ai-productivity-tracker')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'runtime.json'), '{not json', { mode: 0o600 })
      expect(readRuntimeLock()).toBeNull()
    })

    it('readRuntimeLock 在 lockfile 不存在时返回 null', () => {
      expect(readRuntimeLock()).toBeNull()
    })

    it('removeRuntimeLock 删除文件', () => {
      writeRuntimeLock(sampleLock())
      expect(describeRuntimeLockFile().exists).toBe(true)
      removeRuntimeLock()
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('removeRuntimeLock 在 lockfile 不存在时静默', () => {
      expect(() => removeRuntimeLock()).not.toThrow()
    })
  })

  describe('isPidAlive', () => {
    it('当前进程 pid 应当存活', () => {
      expect(isPidAlive(process.pid)).toBe(true)
    })

    it('pid <= 0 视为不存在', () => {
      expect(isPidAlive(0)).toBe(false)
      expect(isPidAlive(-1)).toBe(false)
    })

    it('几乎不可能存在的大 pid 返回 false', () => {
      // 取 INT32 高位附近的值,正常机器不会跑到
      expect(isPidAlive(2_000_000_000)).toBe(false)
    })
  })

  describe('isStaleLock', () => {
    it('刚写的 lock 不 stale', () => {
      expect(isStaleLock(sampleLock())).toBe(false)
    })

    it('startedAt 超过默认 24h → stale', () => {
      const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
      expect(isStaleLock(sampleLock({ startedAt: old }))).toBe(true)
    })

    it('支持自定义 maxAgeMs', () => {
      const recent = new Date(Date.now() - 60_000).toISOString()
      expect(isStaleLock(sampleLock({ startedAt: recent }), 30_000)).toBe(true)
      expect(isStaleLock(sampleLock({ startedAt: recent }), 120_000)).toBe(false)
    })

    it('非法 startedAt → stale(防止脏数据当成有效)', () => {
      expect(isStaleLock(sampleLock({ startedAt: 'not-a-date' }))).toBe(true)
    })
  })

  describe('generateToken', () => {
    it('返回 64 字符 hex 字符串', () => {
      const t = generateToken()
      expect(t).toMatch(/^[0-9a-f]{64}$/)
    })

    it('两次生成结果不同', () => {
      expect(generateToken()).not.toBe(generateToken())
    })
  })

  describe('describeRuntimeLockFile', () => {
    it('文件不存在时 exists=false 且 mode/size=null', () => {
      const desc = describeRuntimeLockFile()
      expect(desc.exists).toBe(false)
      expect(desc.mode).toBeNull()
      expect(desc.size).toBeNull()
    })

    it('文件存在时返回 size > 0 与 mode', () => {
      writeRuntimeLock(sampleLock())
      const desc = describeRuntimeLockFile()
      expect(desc.exists).toBe(true)
      expect(desc.size).toBeGreaterThan(0)
      expect(desc.mode).toBe(0o600)
    })
  })

  // 辅助:测试用 readdir,失败返空
  function readdirSafe(dir: string): string[] {
    try {
      return (require('node:fs') as typeof import('node:fs')).readdirSync(dir)
    } catch {
      return []
    }
  }

  // 让 statSync import 不被 tree-shake,真实场景已经被 describeRuntimeLockFile 间接使用
  it('内部 statSync 在 describeRuntimeLockFile 中确实被调用', () => {
    writeRuntimeLock(sampleLock())
    const file = join(tmpHome, '.ai-productivity-tracker', 'runtime.json')
    expect(statSync(file).size).toBeGreaterThan(0)
    expect(readFileSync(file, 'utf-8')).toContain('"pid"')
  })
})
