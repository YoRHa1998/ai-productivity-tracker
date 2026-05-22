import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  gcSentinels,
  RECENT_ATTACH_WINDOW_MS,
  readRecentAttachSentinel,
  recentAttachSentinelPath,
  sentinelDir,
  writeRecentAttachSentinel
} from './sentinel.js'

describe('sentinelDir', () => {
  it('rootOverride 注入时拼出 hook-state 子目录', () => {
    expect(sentinelDir('/tmp/foo')).toBe('/tmp/foo/hook-state')
  })
})

describe('recentAttachSentinel(v2.10.0 jiraKey 维度)', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'aip-recent-attach-'))
  })
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  it('RECENT_ATTACH_WINDOW_MS 为 90 秒(v2.13.0 锁定常量,防误改)', () => {
    expect(RECENT_ATTACH_WINDOW_MS).toBe(90_000)
  })

  it('recentAttachSentinelPath 大写 jiraKey,拼到 hook-state/<KEY>.recent-attach.json', () => {
    expect(recentAttachSentinelPath('instant-1234', tmpRoot)).toBe(
      join(tmpRoot, 'hook-state', 'INSTANT-1234.recent-attach.json')
    )
  })

  it('writeRecentAttachSentinel 落盘 + readRecentAttachSentinel 能读出 jiraKey/calledAt', () => {
    const at = new Date('2026-05-21T03:00:00.000Z')
    const file = writeRecentAttachSentinel('INSTANT-200', at, tmpRoot)
    expect(file).toBe(join(tmpRoot, 'hook-state', 'INSTANT-200.recent-attach.json'))
    const payload = readRecentAttachSentinel('INSTANT-200', tmpRoot)
    expect(payload).toEqual({ jiraKey: 'INSTANT-200', calledAt: '2026-05-21T03:00:00.000Z' })
  })

  it('write 默认用 new Date()(校验 calledAt 是合法 ISO 字符串)', () => {
    writeRecentAttachSentinel('INSTANT-300', undefined, tmpRoot)
    const payload = readRecentAttachSentinel('INSTANT-300', tmpRoot)
    expect(payload).not.toBeNull()
    expect(typeof payload!.calledAt).toBe('string')
    expect(Number.isNaN(new Date(payload!.calledAt).getTime())).toBe(false)
  })

  it('多次 write 同 jiraKey 以最后一次为准(覆盖式)', () => {
    writeRecentAttachSentinel('INSTANT-400', new Date('2026-05-21T01:00:00Z'), tmpRoot)
    writeRecentAttachSentinel('INSTANT-400', new Date('2026-05-21T02:00:00Z'), tmpRoot)
    expect(readRecentAttachSentinel('INSTANT-400', tmpRoot)?.calledAt).toBe(
      '2026-05-21T02:00:00.000Z'
    )
  })

  it('文件不存在 → read 返回 null', () => {
    expect(readRecentAttachSentinel('NOPE-1', tmpRoot)).toBeNull()
  })

  it('JSON 损坏 → read 返回 null,不抛', () => {
    writeRecentAttachSentinel('INSTANT-500', new Date(), tmpRoot)
    writeFileSync(recentAttachSentinelPath('INSTANT-500', tmpRoot), '{not json', 'utf-8')
    expect(readRecentAttachSentinel('INSTANT-500', tmpRoot)).toBeNull()
  })

  it('jiraKey 字段缺失时 read 用文件名兜底', () => {
    writeRecentAttachSentinel('INSTANT-600', new Date('2026-05-21T03:00:00Z'), tmpRoot)
    writeFileSync(
      recentAttachSentinelPath('INSTANT-600', tmpRoot),
      JSON.stringify({ calledAt: '2026-05-21T03:00:00Z' }),
      'utf-8'
    )
    const payload = readRecentAttachSentinel('INSTANT-600', tmpRoot)
    expect(payload?.jiraKey).toBe('INSTANT-600')
  })

  it('非法 jiraKey(纯特殊字符) → write 返回 null,read 返回 null', () => {
    expect(writeRecentAttachSentinel('!@#', new Date(), tmpRoot)).toBeNull()
    expect(readRecentAttachSentinel('!@#', tmpRoot)).toBeNull()
  })

  it('write 失败时返回 null(目录路径被文件占位 → mkdirSync 报错时仍 try/catch 兜底)', () => {
    // 在 tmpRoot 上放一个同名文件,模拟 sentinelDir 创建失败
    const blocked = join(tmpRoot, 'hook-state')
    writeFileSync(blocked, 'placeholder', 'utf-8')
    expect(writeRecentAttachSentinel('INSTANT-700', new Date(), tmpRoot)).toBeNull()
  })
})

describe('gcSentinels — recent-attach 与老 attach-called 文件都参与 GC', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'aip-recent-attach-gc-'))
  })
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  it('超过 maxAgeMs 的 .recent-attach.json 也被清理', async () => {
    writeRecentAttachSentinel('INSTANT-800', new Date(), tmpRoot)
    const filePath = recentAttachSentinelPath('INSTANT-800', tmpRoot)
    const past = Date.now() - 100 * 24 * 3600 * 1000
    const { utimesSync } = await import('node:fs')
    utimesSync(filePath, new Date(past), new Date(past))
    expect(gcSentinels(tmpRoot)).toBe(1)
    expect(existsSync(filePath)).toBe(false)
  })

  it('老链路残留的 .attach-called.json 也被 GC 清理(用户升级后被动清空)', async () => {
    const dir = sentinelDir(tmpRoot)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const legacyPath = join(dir, 'old-conv-gen.attach-called.json')
    writeFileSync(legacyPath, JSON.stringify({ calledAt: 'x' }), 'utf-8')
    const past = Date.now() - 100 * 24 * 3600 * 1000
    const { utimesSync } = await import('node:fs')
    utimesSync(legacyPath, new Date(past), new Date(past))
    expect(gcSentinels(tmpRoot)).toBe(1)
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('目录不存在时返回 0,不报错', () => {
    expect(gcSentinels(join(tmpRoot, 'no-such-dir'))).toBe(0)
  })
})
