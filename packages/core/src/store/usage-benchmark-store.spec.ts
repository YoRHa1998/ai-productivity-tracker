import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readBenchmark,
  startBenchmark,
  accumulateBenchmark,
  stopBenchmark,
  cancelBenchmark,
  deleteBenchmark,
  hasActiveBenchmark,
  __resetBenchmarkCacheForTest
} from './usage-benchmark-store.js'
import {
  recordUsage,
  setAiUsageEnabled,
  readAiUsage,
  __resetAiUsageCacheForTest
} from './ai-usage-store.js'
import { usageBenchmarkPath } from './paths.js'
import type { AiUsageEvent, AiUsageSource } from './ai-usage-store.js'

function evt(
  source: AiUsageSource,
  total: number,
  partial: Partial<AiUsageEvent> = {}
): AiUsageEvent {
  return {
    source,
    sessionId: partial.sessionId ?? 's1',
    model: partial.model,
    provider: partial.provider,
    at: partial.at ?? new Date().toISOString(),
    tokens: partial.tokens ?? {
      input: total,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total
    }
  }
}

describe('usage-benchmark-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-bmk-'))
    __resetBenchmarkCacheForTest()
    __resetAiUsageCacheForTest()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    __resetBenchmarkCacheForTest()
    __resetAiUsageCacheForTest()
  })

  it('默认无 active 会话,accumulate 零写盘', () => {
    expect(hasActiveBenchmark(root)).toBe(false)
    accumulateBenchmark(evt('cursor', 100), root)
    expect(existsSync(usageBenchmarkPath(root))).toBe(false)
  })

  it('多选工具启动,记录 sources / label / 初始化 totals', () => {
    const active = startBenchmark({ label: '优化前', sources: ['cursor', 'codex'] }, root)
    expect(active.sources).toEqual(['cursor', 'codex'])
    expect(active.label).toBe('优化前')
    expect(active.totals.cursor.total).toBe(0)
    expect(hasActiveBenchmark(root)).toBe(true)
  })

  it('空 sources 拒绝启动', () => {
    expect(() => startBenchmark({ sources: [] }, root)).toThrow()
    expect(hasActiveBenchmark(root)).toBe(false)
  })

  it('非法 sources 过滤后为空也拒绝', () => {
    expect(() => startBenchmark({ sources: ['foo' as unknown as AiUsageSource] }, root)).toThrow()
  })

  it('已有 active 会话时重复启动抛错', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    expect(() => startBenchmark({ sources: ['codex'] }, root)).toThrow()
  })

  it('按 source 过滤累加:选中计入,未选中忽略', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    accumulateBenchmark(evt('cursor', 100, { sessionId: 'a' }), root)
    accumulateBenchmark(evt('codex', 999, { sessionId: 'b' }), root)
    const active = readBenchmark(root).active
    expect(active?.totals.cursor.total).toBe(100)
    expect(active?.totals.cursor.turns).toBe(1)
    expect(active?.totals.codex).toBeUndefined()
  })

  it('token 细分 + turns + sessionId 去重', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    accumulateBenchmark(
      evt('cursor', 0, {
        sessionId: 's1',
        tokens: { input: 80, output: 10, cacheRead: 5, cacheCreation: 20, total: 110 }
      }),
      root
    )
    accumulateBenchmark(
      evt('cursor', 0, {
        sessionId: 's1',
        tokens: { input: 20, output: 5, cacheRead: 0, cacheCreation: 0, total: 25 }
      }),
      root
    )
    accumulateBenchmark(evt('cursor', 50, { sessionId: 's2' }), root)
    const t = readBenchmark(root).active!.totals.cursor
    expect(t.input).toBe(150)
    expect(t.output).toBe(15)
    expect(t.cacheRead).toBe(5)
    expect(t.cacheCreation).toBe(20)
    expect(t.total).toBe(185)
    expect(t.turns).toBe(3)
    expect(t.sessionIds.sort()).toEqual(['s1', 's2'])
  })

  it('结束记录:落盘历史 + grandTotal + 清空 active', () => {
    startBenchmark({ label: 'A', sources: ['cursor', 'codex'] }, root)
    accumulateBenchmark(evt('cursor', 100), root)
    accumulateBenchmark(evt('codex', 50), root)
    const session = stopBenchmark(root)
    expect(session.grandTotal.total).toBe(150)
    expect(session.grandTotal.turns).toBe(2)
    expect(session.durationMs).toBeGreaterThanOrEqual(0)
    const file = readBenchmark(root)
    expect(file.active).toBeNull()
    expect(file.sessions).toHaveLength(1)
    expect(hasActiveBenchmark(root)).toBe(false)
  })

  it('无 active 时结束抛错', () => {
    expect(() => stopBenchmark(root)).toThrow()
  })

  it('取消:丢弃 active,不入历史', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    accumulateBenchmark(evt('cursor', 100), root)
    cancelBenchmark(root)
    const file = readBenchmark(root)
    expect(file.active).toBeNull()
    expect(file.sessions).toHaveLength(0)
  })

  it('删除历史记录幂等', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    const s = stopBenchmark(root)
    deleteBenchmark(s.id, root)
    expect(readBenchmark(root).sessions).toHaveLength(0)
    // 再删不存在的 id 无副作用
    deleteBenchmark('nope', root)
    expect(readBenchmark(root).sessions).toHaveLength(0)
  })

  it('active 跨进程缓存重置后从盘恢复并继续累加', () => {
    startBenchmark({ sources: ['cursor'] }, root)
    accumulateBenchmark(evt('cursor', 100), root)
    // 模拟 daemon 重启:清空进程内缓存
    __resetBenchmarkCacheForTest()
    expect(hasActiveBenchmark(root)).toBe(true)
    accumulateBenchmark(evt('cursor', 50), root)
    expect(readBenchmark(root).active!.totals.cursor.total).toBe(150)
  })

  describe('与 recordUsage 集成', () => {
    it('全局监控关闭 + 有 active 会话:测算累加,ai-usage 不写', () => {
      setAiUsageEnabled(false, root)
      startBenchmark({ sources: ['cursor'] }, root)
      recordUsage(evt('cursor', 100), root)
      expect(readBenchmark(root).active!.totals.cursor.total).toBe(100)
      // ai-usage.json 可能因 setAiUsageEnabled 已存在,但日聚合不应写入任何用量
      expect(readAiUsage(root).daily.cursor).toBeUndefined()
    })

    it('全局监控开启 + 有 active 会话:两者都写', () => {
      setAiUsageEnabled(true, root)
      startBenchmark({ sources: ['cursor'] }, root)
      recordUsage(evt('cursor', 100), root)
      expect(readBenchmark(root).active!.totals.cursor.total).toBe(100)
      const usage = readAiUsage(root)
      expect(usage.daily.cursor).toBeDefined()
    })

    it('无 active 会话 + 全局关:recordUsage 不写测算', () => {
      setAiUsageEnabled(false, root)
      recordUsage(evt('cursor', 100), root)
      expect(existsSync(usageBenchmarkPath(root))).toBe(false)
    })
  })
})
