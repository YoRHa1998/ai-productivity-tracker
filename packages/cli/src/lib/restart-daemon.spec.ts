import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  inspectRunningDaemon,
  stopRunningDaemon,
  type StopDaemonOptions
} from './restart-daemon.js'
import { describeRuntimeLockFile, writeRuntimeLock, type RuntimeLock } from './runtime-lock.js'

const sampleLock = (overrides: Partial<RuntimeLock> = {}): RuntimeLock => ({
  pid: process.pid,
  port: 17350,
  host: '127.0.0.1',
  token: 'a'.repeat(64),
  startedAt: new Date().toISOString(),
  version: '1.0.0-rc.13',
  dataRoot: '/tmp/fake-data',
  ...overrides
})

/** sleep stub:立即 resolve,让 stopRunningDaemon 单测无等待 */
const instantSleep = (): Promise<void> => Promise.resolve()

describe('restart-daemon', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aipt-restart-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    rmSync(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  describe('inspectRunningDaemon', () => {
    it('lockfile 不存在 → running=false, lock=null', async () => {
      const info = await inspectRunningDaemon()
      expect(info.running).toBe(false)
      expect(info.lock).toBeNull()
      expect(info.daemonVersion).toBeNull()
    })

    it('lockfile pid 不存活 → running=false, lock 非空但 daemonVersion=null', async () => {
      // 取一个绝对不会存在的大 pid
      writeRuntimeLock(sampleLock({ pid: 2_000_000_000 }))
      const info = await inspectRunningDaemon()
      expect(info.running).toBe(false)
      expect(info.lock?.pid).toBe(2_000_000_000)
      expect(info.daemonVersion).toBeNull()
    })

    it('lockfile pid 存活 + http /status 探活失败 → running=false', async () => {
      // 注:port 16(reserved),fetch 必拒
      writeRuntimeLock(sampleLock({ port: 16 }))
      const info = await inspectRunningDaemon(200)
      expect(info.running).toBe(false)
      expect(info.lock).not.toBeNull()
      expect(info.daemonVersion).toBeNull()
    })

    it('http /status 返回 200 + version → running=true 且 daemonVersion 来自响应 data.version', async () => {
      writeRuntimeLock(sampleLock())
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'OK',
            message: '',
            data: { version: '1.0.0-rc.99' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      const info = await inspectRunningDaemon()
      expect(info.running).toBe(true)
      expect(info.daemonVersion).toBe('1.0.0-rc.99')
      fetchMock.mockRestore()
    })

    it('http /status 200 但响应不带 version → fallback 到 lock.version', async () => {
      writeRuntimeLock(sampleLock({ version: '1.0.0-rc.13' }))
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: 'OK', message: '', data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      const info = await inspectRunningDaemon()
      expect(info.running).toBe(true)
      expect(info.daemonVersion).toBe('1.0.0-rc.13')
      fetchMock.mockRestore()
    })
  })

  describe('stopRunningDaemon', () => {
    function withMockedLockDir(): void {
      // 先 ensure 家目录存在,避免 readRuntimeLock 没文件
      mkdirSync(join(tmpHome, '.ai-productivity-tracker'), { recursive: true })
    }

    it('lockfile 不存在 → status=not-running', async () => {
      const result = await stopRunningDaemon({ sleep: instantSleep })
      expect(result.status).toBe('not-running')
      expect(result.pid).toBe(0)
    })

    it('lockfile 存在但 pid 不存活 → 顺手清 lockfile + status=not-running', async () => {
      writeRuntimeLock(sampleLock({ pid: 2_000_000_000 }))
      expect(describeRuntimeLockFile().exists).toBe(true)
      const result = await stopRunningDaemon({
        isAlive: () => false,
        sleep: instantSleep
      })
      expect(result.status).toBe('not-running')
      expect(result.pid).toBe(2_000_000_000)
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('SIGTERM 后进程在 graceful 窗口内退出 → status=graceful + lockfile 被清', async () => {
      withMockedLockDir()
      writeRuntimeLock(sampleLock({ pid: 99999 }))

      // 模拟 daemon:第一次 isAlive 检查时仍存活,SIGTERM 后下一次轮询就死
      let aliveCalls = 0
      const isAlive = (): boolean => {
        aliveCalls += 1
        // 首次检查(进入函数时)返 true,之后返 false
        return aliveCalls === 1
      }
      const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = []
      const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
        killCalls.push({ pid, signal })
        // 模拟 daemon SIGTERM handler:立即清掉 lockfile
        if (signal === 'SIGTERM') {
          // 模拟 daemon 自己 removeRuntimeLock
          rmSync(join(tmpHome, '.ai-productivity-tracker', 'runtime.json'), { force: true })
        }
      }

      const result = await stopRunningDaemon({
        isAlive,
        kill,
        sleep: instantSleep,
        gracefulTimeoutMs: 1000,
        pollIntervalMs: 10
      })

      expect(result.status).toBe('graceful')
      expect(result.pid).toBe(99999)
      expect(killCalls.length).toBe(1)
      expect(killCalls[0]).toEqual({ pid: 99999, signal: 'SIGTERM' })
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('SIGTERM 超时未退 → SIGKILL 兜底 + status=forced + 强清 lockfile', async () => {
      writeRuntimeLock(sampleLock({ pid: 88888 }))

      // 始终存活,直到收到 SIGKILL 后才"死"
      let killed = false
      const isAlive = (): boolean => !killed
      const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = []
      const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
        killCalls.push({ pid, signal })
        if (signal === 'SIGKILL') killed = true
      }

      const result = await stopRunningDaemon({
        isAlive,
        kill,
        sleep: instantSleep,
        gracefulTimeoutMs: 50,
        pollIntervalMs: 10
      })

      expect(result.status).toBe('forced')
      expect(result.pid).toBe(88888)
      // 至少一个 SIGTERM + 一个 SIGKILL
      expect(killCalls.some((c) => c.signal === 'SIGTERM')).toBe(true)
      expect(killCalls.some((c) => c.signal === 'SIGKILL')).toBe(true)
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('SIGKILL 后仍存活 → status=timeout(极罕见系统态)', async () => {
      writeRuntimeLock(sampleLock({ pid: 77777 }))

      const isAlive = (): boolean => true // 永远不死(模拟卡死的 ZOMBIE)
      const kill = (): void => {}

      const result = await stopRunningDaemon({
        isAlive,
        kill,
        sleep: instantSleep,
        gracefulTimeoutMs: 30,
        pollIntervalMs: 10
      })

      expect(result.status).toBe('timeout')
      // lockfile 应被强清(让后续 ensureDaemon 不被卡 pid 卡死)
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('kill 抛错(进程在发信号前已退) → 视为 not-running 并清 lockfile', async () => {
      writeRuntimeLock(sampleLock({ pid: 66666 }))

      const isAlive = (): boolean => true
      const kill = (): void => {
        throw new Error('ESRCH')
      }

      const result = await stopRunningDaemon({
        isAlive,
        kill,
        sleep: instantSleep
      })

      expect(result.status).toBe('not-running')
      expect(result.pid).toBe(66666)
      expect(describeRuntimeLockFile().exists).toBe(false)
    })

    it('readLock 注入:支持自定义 lockfile 来源(为 aipt restart 子命令铺路)', async () => {
      const customLock = sampleLock({ pid: 55555 })
      const opts: StopDaemonOptions = {
        readLock: () => customLock,
        isAlive: () => false,
        sleep: instantSleep
      }
      const result = await stopRunningDaemon(opts)
      expect(result.pid).toBe(55555)
      // 注:此时是用的 default removeRuntimeLock(指向 tmpHome,无文件),不抛错即可
      expect(result.status).toBe('not-running')
    })
  })

  it('集成路径:已退出的 lockfile 残留 → inspect 报 running=false + stop 协作清理', async () => {
    writeRuntimeLock(sampleLock({ pid: 2_000_000_001 }))
    const info = await inspectRunningDaemon()
    expect(info.running).toBe(false)
    expect(info.lock).not.toBeNull()

    const stop = await stopRunningDaemon({ sleep: instantSleep })
    expect(stop.status).toBe('not-running')
    expect(describeRuntimeLockFile().exists).toBe(false)
  })
})
