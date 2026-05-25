import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_PORT, isPortAvailable, pickAvailablePort } from './pick-port.js'

describe('pick-port', () => {
  const heldServers: Server[] = []

  afterEach(async () => {
    while (heldServers.length) {
      const srv = heldServers.pop()!
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
  })

  async function holdPort(port: number): Promise<void> {
    const srv = createServer()
    heldServers.push(srv)
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => resolve())
    })
  }

  it('DEFAULT_PORT 取值与 PRD 一致', () => {
    expect(DEFAULT_PORT).toBe(17350)
  })

  it('isPortAvailable 在空端口上返回 true', async () => {
    // 用 ephemeral 端口先占,关闭后再探
    const srv = createServer()
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    expect(port).toBeGreaterThan(0)
    expect(await isPortAvailable(port)).toBe(true)
  })

  it('isPortAvailable 在被占端口上返回 false', async () => {
    const srv = createServer()
    heldServers.push(srv)
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    expect(port).toBeGreaterThan(0)
    expect(await isPortAvailable(port)).toBe(false)
  })

  it('pickAvailablePort 优先返回 preferred 端口', async () => {
    // 找一个未占的端口当 preferred
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const preferred = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect(await pickAvailablePort(preferred)).toBe(preferred)
  })

  it('pickAvailablePort 在 preferred 占用时递增 1 直到找到空端口', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const base = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    await holdPort(base)
    const got = await pickAvailablePort(base)
    expect(got).toBeGreaterThan(base)
    expect(got).toBeLessThanOrEqual(base + 20)
  })
})
