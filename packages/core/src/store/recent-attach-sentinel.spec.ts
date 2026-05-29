import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LOCAL_AGENT_ROOT_ENV,
  readRecentAttachSentinel,
  RECENT_ATTACH_WINDOW_MS,
  recentAttachSentinelPath,
  writeRecentAttachSentinel
} from './recent-attach-sentinel.js'

describe('agent recent-attach-sentinel store', () => {
  let agentRoot: string
  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), 'aip-agent-recent-attach-'))
  })
  afterEach(() => rmSync(agentRoot, { recursive: true, force: true }))

  it('RECENT_ATTACH_WINDOW_MS 复用 hook-core 常量,值为 90s(v2.13.0 拉大)', () => {
    expect(RECENT_ATTACH_WINDOW_MS).toBe(90_000)
  })

  it('write → read 链路正常,落盘路径在 hook-state/<KEY>.recent-attach.json', () => {
    const now = new Date('2026-05-21T08:00:00.000Z')
    const file = writeRecentAttachSentinel('instant-1234', now, agentRoot)
    expect(file).toBe(recentAttachSentinelPath('INSTANT-1234', agentRoot))
    expect(existsSync(file!)).toBe(true)

    const payload = readRecentAttachSentinel('INSTANT-1234', agentRoot)
    expect(payload).toEqual({ jiraKey: 'INSTANT-1234', calledAt: '2026-05-21T08:00:00.000Z' })
  })

  it('write 默认 now 时落盘后 read 出来的 calledAt 是合法 ISO 字符串', () => {
    writeRecentAttachSentinel('INSTANT-200', undefined, agentRoot)
    const payload = readRecentAttachSentinel('INSTANT-200', agentRoot)
    expect(payload).not.toBeNull()
    expect(Number.isNaN(new Date(payload!.calledAt).getTime())).toBe(false)
  })

  it('文件不存在 → read 返回 null', () => {
    expect(readRecentAttachSentinel('NONE-1', agentRoot)).toBeNull()
  })

  it('JSON 损坏 → read 返回 null,不抛', () => {
    writeRecentAttachSentinel('INSTANT-300', new Date(), agentRoot)
    writeFileSync(recentAttachSentinelPath('INSTANT-300', agentRoot), 'not-json', 'utf-8')
    expect(readRecentAttachSentinel('INSTANT-300', agentRoot)).toBeNull()
  })

  it('多次 write 同 key 以最后一次为准(原子覆盖)', () => {
    writeRecentAttachSentinel('INSTANT-400', new Date('2026-05-21T01:00:00Z'), agentRoot)
    writeRecentAttachSentinel('INSTANT-400', new Date('2026-05-21T02:00:00Z'), agentRoot)
    expect(readRecentAttachSentinel('INSTANT-400', agentRoot)?.calledAt).toBe(
      '2026-05-21T02:00:00.000Z'
    )
  })

  it('非法 jiraKey(全特殊字符)→ write 返回 null,不污染目录', () => {
    expect(writeRecentAttachSentinel('!!!', new Date(), agentRoot)).toBeNull()
  })

  it('AIPT_LOCAL_AGENT_ROOT env 缺省时调用方不传 agentRoot 也能写到 env 指定目录', () => {
    const prev = process.env[LOCAL_AGENT_ROOT_ENV]
    process.env[LOCAL_AGENT_ROOT_ENV] = agentRoot
    try {
      const file = writeRecentAttachSentinel('INSTANT-900')
      expect(file).toBe(recentAttachSentinelPath('INSTANT-900'))
      expect(file).toContain(agentRoot)
      expect(readRecentAttachSentinel('INSTANT-900')?.jiraKey).toBe('INSTANT-900')
    } finally {
      if (prev !== undefined) process.env[LOCAL_AGENT_ROOT_ENV] = prev
      else delete process.env[LOCAL_AGENT_ROOT_ENV]
    }
  })

  it('显式 agentRoot 优先级高于 env', () => {
    const prev = process.env[LOCAL_AGENT_ROOT_ENV]
    process.env[LOCAL_AGENT_ROOT_ENV] = '/some/other/root'
    try {
      const file = writeRecentAttachSentinel('INSTANT-901', new Date(), agentRoot)
      expect(file).toContain(agentRoot)
      expect(file).not.toContain('/some/other/root')
    } finally {
      if (prev !== undefined) process.env[LOCAL_AGENT_ROOT_ENV] = prev
      else delete process.env[LOCAL_AGENT_ROOT_ENV]
    }
  })
})
