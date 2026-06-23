import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readAiUsage,
  recordUsage,
  setAiUsageEnabled,
  isAiUsageEnabled,
  getAiUsageView,
  buildAiUsageView,
  __resetAiUsageCacheForTest,
  type AiUsageEvent
} from './ai-usage-store.js'
import { aiUsagePath } from './paths.js'

function evt(partial: Partial<AiUsageEvent> & Pick<AiUsageEvent, 'source'>): AiUsageEvent {
  return {
    source: partial.source,
    sessionId: partial.sessionId ?? 's1',
    model: partial.model,
    provider: partial.provider,
    toolCalls: partial.toolCalls,
    at: partial.at ?? new Date().toISOString(),
    tokens: partial.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }
  }
}

describe('ai-usage-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-usage-'))
    __resetAiUsageCacheForTest()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    __resetAiUsageCacheForTest()
  })

  it('默认关闭:从未设置过开关时 enabled=false 且不写盘', () => {
    expect(isAiUsageEnabled(root)).toBe(false)
    recordUsage(
      evt({
        source: 'claude-code',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0, total: 110 }
      }),
      root
    )
    expect(existsSync(aiUsagePath(root))).toBe(false)
    const view = getAiUsageView(14, root)
    expect(view.today['claude-code'].totalTokens).toBe(0)
  })

  it('开启后 token 细分累加 + turns 计数', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    recordUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at,
        tokens: { input: 9000, output: 1000, cacheRead: 8000, cacheCreation: 2000, total: 12000 }
      }),
      root
    )
    recordUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 7 }
      }),
      root
    )
    const file = readAiUsage(root)
    const day = localKey(at)
    const bucket = file.daily['codex'][day]
    expect(bucket.input).toBe(9001)
    expect(bucket.output).toBe(1002)
    expect(bucket.cacheRead).toBe(8003)
    expect(bucket.cacheCreation).toBe(2004)
    expect(bucket.total).toBe(12007)
    expect(bucket.turns).toBe(2)
  })

  it('sessions 按当日事件重算去重', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    const tokens = { input: 10, output: 1, cacheRead: 0, cacheCreation: 0, total: 11 }
    recordUsage(evt({ source: 'cursor', sessionId: 'A', at, tokens }), root)
    recordUsage(evt({ source: 'cursor', sessionId: 'A', at, tokens }), root)
    recordUsage(evt({ source: 'cursor', sessionId: 'B', at, tokens }), root)
    const view = buildAiUsageView(readAiUsage(root), 14, new Date(at))
    expect(view.today['cursor'].turns).toBe(3)
    expect(view.today['cursor'].sessions).toBe(2)
  })

  it('缺 model / provider 维度降级:照常累计,不报错', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    recordUsage(
      evt({
        source: 'claude-code',
        at,
        tokens: { input: 5, output: 5, cacheRead: 0, cacheCreation: 0, total: 10 }
      }),
      root
    )
    const bucket = readAiUsage(root).daily['claude-code'][localKey(at)]
    expect(bucket.total).toBe(10)
    expect(Object.keys(bucket.models)).toHaveLength(0)
    expect(Object.keys(bucket.providers)).toHaveLength(0)
  })

  it('携带 model / provider 时记入细分', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    recordUsage(
      evt({
        source: 'claude-code',
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        at,
        tokens: { input: 5, output: 5, cacheRead: 0, cacheCreation: 2, total: 12 }
      }),
      root
    )
    const bucket = readAiUsage(root).daily['claude-code'][localKey(at)]
    expect(bucket.models['claude-opus-4-8']).toEqual({ total: 12, turns: 1 })
    expect(bucket.providers['anthropic']).toEqual({ total: 12 })
  })

  it('跨天分桶:不同自然日落不同桶', () => {
    setAiUsageEnabled(true, root)
    const tokens = { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
    // 用本机时区构造两个不同日期,避免 UTC/本地跨天误判
    const d1 = new Date(2026, 5, 23, 23, 30, 0)
    const d2 = new Date(2026, 5, 24, 0, 30, 0)
    recordUsage(evt({ source: 'cursor', at: d1.toISOString(), tokens }), root)
    recordUsage(evt({ source: 'cursor', at: d2.toISOString(), tokens }), root)
    const byDate = readAiUsage(root).daily['cursor']
    expect(Object.keys(byDate).sort()).toEqual(['2026-06-23', '2026-06-24'])
  })

  it('关闭开关后不再写入(采集旁路短路)', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    const tokens = { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
    recordUsage(evt({ source: 'cursor', at, tokens }), root)
    setAiUsageEnabled(false, root)
    recordUsage(evt({ source: 'cursor', at, tokens }), root)
    const bucket = readAiUsage(root).daily['cursor'][localKey(at)]
    expect(bucket.total).toBe(10)
    expect(bucket.turns).toBe(1)
  })

  it('开关持久化:重读文件仍为开启,关闭时仍可查历史', () => {
    setAiUsageEnabled(true, root)
    const at = '2026-06-23T10:00:00.000Z'
    recordUsage(
      evt({
        source: 'codex',
        at,
        tokens: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0, total: 100 }
      }),
      root
    )
    setAiUsageEnabled(false, root)
    __resetAiUsageCacheForTest()
    expect(isAiUsageEnabled(root)).toBe(false)
    const view = buildAiUsageView(readAiUsage(root), 14, new Date(at))
    expect(view.enabled).toBe(false)
    expect(view.today['codex'].totalTokens).toBe(100)
  })

  it('原子写:不留 .tmp 残留,文件可解析', () => {
    setAiUsageEnabled(true, root)
    recordUsage(
      evt({
        source: 'cursor',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 }
      }),
      root
    )
    const p = aiUsagePath(root)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    expect(parsed.version).toBe(1)
    expect(parsed.config.enabled).toBe(true)
  })

  it('series 长度 = days 且升序覆盖到今天', () => {
    setAiUsageEnabled(true, root)
    const now = new Date(2026, 5, 23, 12, 0, 0)
    const view = buildAiUsageView(readAiUsage(root), 7, now)
    expect(view.series).toHaveLength(7)
    expect(view.series[6].date).toBe('2026-06-23')
    expect(view.series[0].date).toBe('2026-06-17')
  })
})

/** 本机时区日期键(与 store.localDateKey 同口径),测试内联避免额外 import 噪音 */
function localKey(at: string): string {
  const d = new Date(at)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
