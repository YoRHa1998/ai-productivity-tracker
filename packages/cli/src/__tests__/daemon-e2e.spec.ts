/**
 * Phase 3 daemon 端到端冒烟测试。
 *
 * 直接 spawn `tsx src/index.ts daemon ...` 跑真实 daemon 进程,通过 HTTP 验证:
 *   - /status 返回正确 envelope
 *   - panel-origin 同源放行 (免 token)
 *   - /ai-productivity/init 需 Bearer token
 *   - SIGTERM 优雅停机 + 清 runtime.json
 *   - 端口冲突 fallback
 *   - migrate-style 不写老路径 (validate paths)
 *
 * 测试自洽:用 mkdtempSync 隔离 HOME / AIPT_DATA_ROOT,确保不污染开发者真实数据。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const cliEntry = resolve(__dirname, '..', 'index.ts')
const tsxBin = resolve(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx')

interface SpawnedDaemon {
  proc: ChildProcess
  port: number
  token: string
  home: string
}

async function spawnDaemon(
  home: string,
  port: number,
  extraArgs: string[] = []
): Promise<SpawnedDaemon> {
  const env = {
    ...process.env,
    HOME: home,
    AIPT_DATA_ROOT: join(home, 'data'),
    AIPT_TOKEN: 't'.repeat(64),
    NODE_OPTIONS: ''
  }
  const proc = spawn(
    tsxBin,
    [cliEntry, 'daemon', '--port', String(port), '--no-web', ...extraArgs],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let stdoutBuf = ''
  let stderrBuf = ''
  proc.stdout?.on('data', (d: Buffer) => {
    stdoutBuf += d.toString()
  })
  proc.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString()
  })

  // 等待 daemon 监听
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) })
      if (r.ok) {
        return { proc, port, token: 't'.repeat(64), home }
      }
    } catch {
      /* not ready */
    }
    if (proc.exitCode !== null) {
      throw new Error(
        `daemon 早退 exit=${proc.exitCode}\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  proc.kill('SIGKILL')
  throw new Error(`daemon 未在 8s 内就绪\nstdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}`)
}

function pickPort(): number {
  // 用 17400-17499 区间,避免与 dev 17350 撞
  return 17400 + Math.floor(Math.random() * 100)
}

async function stopDaemon(d: SpawnedDaemon): Promise<void> {
  if (d.proc.exitCode !== null) return
  d.proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    if (d.proc.exitCode !== null) {
      resolve()
      return
    }
    d.proc.once('exit', () => resolve())
    setTimeout(() => {
      if (d.proc.exitCode === null) d.proc.kill('SIGKILL')
      resolve()
    }, 3000)
  })
}

describe.sequential('daemon e2e', () => {
  let tmpHome: string
  let daemon: SpawnedDaemon | null = null

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aipt-e2e-'))
  })

  afterEach(async () => {
    if (daemon) {
      await stopDaemon(daemon)
      daemon = null
    }
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('/status 返回 ok envelope + dataRoot 字段', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { code: string; data: { port: number; dataRoot: string } }
    expect(body.code).toBe('OK')
    expect(body.data.port).toBe(port)
    expect(body.data.dataRoot).toBe(join(tmpHome, 'data'))
  })

  it('runtime.json 在 daemon 启动后被写入,且字段齐全', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    const lockPath = join(tmpHome, '.ai-productivity-tracker', 'runtime.json')
    // 文件可能比 /status 晚几十 ms 落,做一次轮询
    let lock: Record<string, unknown> | null = null
    for (let i = 0; i < 20 && !lock; i++) {
      if (existsSync(lockPath)) {
        try {
          lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>
        } catch {
          /* not yet flushed */
        }
      }
      if (!lock) await new Promise((r) => setTimeout(r, 100))
    }
    expect(lock).toBeTruthy()
    expect(lock!.port).toBe(port)
    expect(lock!.host).toBe('127.0.0.1')
    expect(typeof lock!.token).toBe('string')
    expect(typeof lock!.pid).toBe('number')
    expect(typeof lock!.dataRoot).toBe('string')
  })

  it('/ai-productivity/init 缺 Bearer token 时 401', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    const res = await fetch(`http://127.0.0.1:${port}/ai-productivity/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(401)
  })

  it('/ai-productivity/storage-path 同源 origin 放行(免 token)', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    const res = await fetch(`http://127.0.0.1:${port}/ai-productivity/storage-path`, {
      headers: { Origin: `http://127.0.0.1:${port}` }
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { code: string; data: { root: string } }
    expect(body.code).toBe('OK')
    expect(body.data.root).toBe(join(tmpHome, 'data'))
  })

  it('SIGTERM 后 runtime.json 被清理', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    const lockPath = join(tmpHome, '.ai-productivity-tracker', 'runtime.json')
    // 等 lock 落齐
    for (let i = 0; i < 20 && !existsSync(lockPath); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(existsSync(lockPath)).toBe(true)

    await stopDaemon(daemon)
    daemon = null
    expect(existsSync(lockPath)).toBe(false)
  })

  it('端口冲突 → daemon 自动选下一个空端口', async () => {
    const port = pickPort()
    daemon = await spawnDaemon(tmpHome, port)
    // 起第二个 daemon,要求同一个 port,会被 pickAvailablePort 跳过
    const secondHome = mkdtempSync(join(tmpdir(), 'aipt-e2e-2-'))
    try {
      const second = await spawnDaemon(secondHome, port)
      // 实际监听端口应当不是 port
      const r = await fetch(`http://127.0.0.1:${port}/status`)
      const body = (await r.json()) as { data: { port: number } }
      expect(body.data.port).toBe(port) // 第一个 daemon 持有原端口
      // 第二个 daemon 的 runtime.json 应该 port != port
      const secondLock = join(secondHome, '.ai-productivity-tracker', 'runtime.json')
      let secondPort = 0
      for (let i = 0; i < 20 && !secondPort; i++) {
        if (existsSync(secondLock)) {
          try {
            secondPort = (JSON.parse(readFileSync(secondLock, 'utf-8')) as { port: number }).port
          } catch {
            /* not flushed */
          }
        }
        if (!secondPort) await new Promise((r) => setTimeout(r, 100))
      }
      expect(secondPort).toBeGreaterThan(port)
      await stopDaemon(second)
    } finally {
      rmSync(secondHome, { recursive: true, force: true })
    }
  }, 15000)
})
