import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accumulateSessionUsage,
  readSessionUsage,
  pruneSessions,
  querySessions,
  truncateTitle,
  RETENTION_DAYS,
  TITLE_MAX_LEN,
  type SessionUsageFile,
  type SessionUsageRecord
} from './session-usage-store.js'
import { recordUsage, setAiUsageEnabled, __resetAiUsageCacheForTest } from './ai-usage-store.js'
import type { AiUsageEvent } from './ai-usage-store.js'
import { sessionUsagePath } from './paths.js'

function evt(partial: Partial<AiUsageEvent> & Pick<AiUsageEvent, 'source'>): AiUsageEvent {
  return {
    source: partial.source,
    sessionId: partial.sessionId ?? 's1',
    model: partial.model,
    provider: partial.provider,
    toolCalls: partial.toolCalls,
    title: partial.title,
    jiraKey: partial.jiraKey,
    at: partial.at ?? new Date().toISOString(),
    tokens: partial.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }
  }
}

function rec(
  partial: Partial<SessionUsageRecord> & Pick<SessionUsageRecord, 'lastAt'>
): SessionUsageRecord {
  return {
    source: partial.source ?? 'cursor',
    sessionId: partial.sessionId ?? 'sid',
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheCreation: partial.cacheCreation ?? 0,
    total: partial.total ?? 0,
    turns: partial.turns ?? 0,
    toolCalls: partial.toolCalls ?? 0,
    model: partial.model,
    title: partial.title,
    jiraKey: partial.jiraKey,
    firstAt: partial.firstAt ?? partial.lastAt,
    lastAt: partial.lastAt
  }
}

describe('session-usage-store: accumulate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('按会话累加 token 细分 / turns / toolCalls,刷新时间窗(含跨日)', () => {
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at: '2026-06-23T10:00:00.000Z',
        toolCalls: 2,
        tokens: { input: 100, output: 10, cacheRead: 5, cacheCreation: 20, total: 130 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at: '2026-06-24T09:00:00.000Z',
        toolCalls: 3,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 7 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['codex:sess-a']
    expect(r.input).toBe(101)
    expect(r.output).toBe(12)
    expect(r.cacheRead).toBe(8)
    expect(r.cacheCreation).toBe(24)
    expect(r.total).toBe(137)
    expect(r.turns).toBe(2)
    expect(r.toolCalls).toBe(5)
    expect(r.firstAt).toBe('2026-06-23T10:00:00.000Z')
    expect(r.lastAt).toBe('2026-06-24T09:00:00.000Z')
  })

  it('空 sessionId 直接跳过,不创建记录', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: '',
        tokens: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
      }),
      root
    )
    expect(existsSync(sessionUsagePath(root))).toBe(false)
    expect(Object.keys(readSessionUsage(root).sessions)).toHaveLength(0)
  })

  it('source 前缀消歧:同 sessionId 跨工具不串号', () => {
    const tokens = { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
    accumulateSessionUsage(evt({ source: 'cursor', sessionId: 'dup', tokens }), root)
    accumulateSessionUsage(evt({ source: 'codex', sessionId: 'dup', tokens }), root)
    const sessions = readSessionUsage(root).sessions
    expect(Object.keys(sessions).sort()).toEqual(['codex:dup', 'cursor:dup'])
  })

  it('total 缺失时按 input+output+cacheCreation 兜底(剔除 cacheRead)', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        tokens: { input: 5, output: 5, cacheRead: 100, cacheCreation: 2, total: 0 }
      }),
      root
    )
    expect(readSessionUsage(root).sessions['cursor:s'].total).toBe(12)
  })

  it('title 仅首次写入,后续轮不覆盖;model / jiraKey 非空覆盖', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '第一句话',
        model: 'm1',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '后续轮的话',
        model: 'm2',
        jiraKey: 'INSTANT-1',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['cursor:s']
    expect(r.title).toBe('第一句话')
    expect(r.model).toBe('m2')
    expect(r.jiraKey).toBe('INSTANT-1')
  })

  it('原子写:不留 .tmp 残留', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const p = sessionUsagePath(root)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
  })
})

describe('session-usage-store: prune', () => {
  it('删除 lastAt 早于保留天数的会话', () => {
    const now = new Date('2026-06-24T00:00:00.000Z')
    const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 86400_000).toISOString()
    const fresh = new Date(now.getTime() - 1 * 86400_000).toISOString()
    const file: SessionUsageFile = {
      version: 1,
      sessions: {
        'cursor:old': rec({ sessionId: 'old', lastAt: old }),
        'cursor:fresh': rec({ sessionId: 'fresh', lastAt: fresh })
      }
    }
    pruneSessions(file, now)
    expect(Object.keys(file.sessions)).toEqual(['cursor:fresh'])
  })

  it('超条数上限按最近 lastAt 保留', () => {
    const now = new Date('2026-06-24T00:00:00.000Z')
    const sessions: Record<string, SessionUsageRecord> = {}
    for (let i = 0; i < 5; i++) {
      const lastAt = new Date(now.getTime() - i * 60_000).toISOString()
      sessions[`cursor:s${i}`] = rec({ sessionId: `s${i}`, lastAt })
    }
    const file: SessionUsageFile = { version: 1, sessions }
    pruneSessions(file, now, RETENTION_DAYS, 3)
    expect(Object.keys(file.sessions).sort()).toEqual(['cursor:s0', 'cursor:s1', 'cursor:s2'])
  })
})

describe('session-usage-store: query', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-q-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed() {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'big',
        at: '2026-06-20T10:00:00.000Z',
        tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, total: 1000 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'mid',
        at: '2026-06-22T10:00:00.000Z',
        tokens: { input: 500, output: 0, cacheRead: 0, cacheCreation: 0, total: 500 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'small',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0, total: 50 }
      }),
      root
    )
  }

  it('默认按 total 倒序', () => {
    seed()
    const rows = querySessions({}, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['big', 'mid', 'small'])
    expect(rows[0].totalTokens).toBe(1000)
  })

  it('dir=asc 反转;sort=lastAt 按最近活跃', () => {
    seed()
    expect(querySessions({ dir: 'asc' }, root).map((r) => r.sessionId)).toEqual([
      'small',
      'mid',
      'big'
    ])
    expect(querySessions({ sort: 'lastAt' }, root).map((r) => r.sessionId)).toEqual([
      'small',
      'mid',
      'big'
    ])
  })

  it('source 过滤', () => {
    seed()
    const rows = querySessions({ source: 'cursor' }, root)
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['big', 'small'])
  })

  it('from/to 时间窗过滤', () => {
    seed()
    const rows = querySessions(
      { from: '2026-06-21T00:00:00.000Z', to: '2026-06-23T00:00:00.000Z' },
      root
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['mid'])
  })

  it('limit 截断', () => {
    seed()
    expect(querySessions({ limit: 1 }, root).map((r) => r.sessionId)).toEqual(['big'])
  })
})

describe('recordUsage 集成会话维度', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-rec-'))
    __resetAiUsageCacheForTest()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    __resetAiUsageCacheForTest()
  })

  it('enabled 时写会话维度,带 title/jiraKey 落库', () => {
    setAiUsageEnabled(true, root)
    recordUsage(
      evt({
        source: 'claude-code',
        sessionId: 'sx',
        title: '帮我写个函数',
        jiraKey: 'INSTANT-9',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['claude-code:sx']
    expect(r.total).toBe(15)
    expect(r.title).toBe('帮我写个函数')
    expect(r.jiraKey).toBe('INSTANT-9')
  })

  it('disabled 时不写会话维度', () => {
    setAiUsageEnabled(false, root)
    recordUsage(
      evt({
        source: 'cursor',
        sessionId: 'sx',
        tokens: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
      }),
      root
    )
    expect(existsSync(sessionUsagePath(root))).toBe(false)
  })
})

describe('truncateTitle', () => {
  it('超长截断到上限', () => {
    const long = 'a'.repeat(TITLE_MAX_LEN + 50)
    expect(truncateTitle(long).length).toBe(TITLE_MAX_LEN)
    expect(truncateTitle('abc', 2)).toBe('ab')
  })

  it('折行 / 连续空白压成一行', () => {
    expect(truncateTitle('hello\n\n  world\t!')).toBe('hello world !')
  })

  it('去首尾空白', () => {
    expect(truncateTitle('  hi  ')).toBe('hi')
  })

  it('空输入 / 非字符串安全兜底', () => {
    expect(truncateTitle('')).toBe('')
    expect(truncateTitle('   ')).toBe('')
    expect(truncateTitle(undefined)).toBe('')
    expect(truncateTitle(123 as unknown)).toBe('')
  })
})
