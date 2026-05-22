import { describe, expect, it, vi } from 'vitest'

import { main } from './index.js'

describe('argv-router (main)', () => {
  it('argv[2] === "hook" 时调用 hookRunner,不启动 MCP server', async () => {
    const hookRunner = vi.fn(async () => {})
    const result = await main({
      argv: ['node', 'mcp.mjs', 'hook'],
      hookRunner,
      startServer: false
    })
    expect(hookRunner).toHaveBeenCalledOnce()
    expect(result).toBe('hook')
  })

  it('argv[2] !== "hook" 时不调用 hookRunner', async () => {
    const hookRunner = vi.fn(async () => {})
    const result = await main({
      argv: ['node', 'mcp.mjs'],
      hookRunner,
      startServer: false
    })
    expect(hookRunner).not.toHaveBeenCalled()
    expect(result).toBe('mcp')
  })

  it('argv[2] === "hook" 时 hookRunner 抛错会向外冒泡(让 process.exit(1) 生效)', async () => {
    const hookRunner = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      main({ argv: ['node', 'mcp.mjs', 'hook'], hookRunner, startServer: false })
    ).rejects.toThrow('boom')
  })

  it('argv[2] === "stop-check" 时调用 stopCheckRunner', async () => {
    const stopCheckRunner = vi.fn(async () => {})
    const hookRunner = vi.fn(async () => {})
    const result = await main({
      argv: ['node', 'mcp.mjs', 'stop-check'],
      stopCheckRunner,
      hookRunner,
      startServer: false
    })
    expect(stopCheckRunner).toHaveBeenCalledOnce()
    expect(hookRunner).not.toHaveBeenCalled()
    expect(result).toBe('stop-check')
  })

  it('argv[2] === "mark-tool-called" 时调用 markToolCalledRunner(v2.10.0 兼容入口)', async () => {
    const markToolCalledRunner = vi.fn(async () => {})
    const hookRunner = vi.fn(async () => {})
    const result = await main({
      argv: ['node', 'mcp.mjs', 'mark-tool-called'],
      markToolCalledRunner,
      hookRunner,
      startServer: false
    })
    expect(markToolCalledRunner).toHaveBeenCalledOnce()
    expect(hookRunner).not.toHaveBeenCalled()
    expect(result).toBe('mark-tool-called')
  })

  it('argv[2] === "mark-tool-called" + 缺省 runner 时静默 exit(v2.10.0 deprecated 兼容)', async () => {
    const result = await main({
      argv: ['node', 'mcp.mjs', 'mark-tool-called'],
      startServer: false
    })
    expect(result).toBe('mark-tool-called')
  })
})
