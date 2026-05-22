import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendIteration, getNextSeq, listIterations, loadRawPayload } from './iteration-store.js'
import { saveRequirement } from './requirement-store.js'
import { readIndex } from './index-store.js'
import { peekPendingSummary, writePendingSummary } from './pending-summary.js'

describe('iteration-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-iter-'))
    saveRequirement({ jiraKey: 'PROJ-9', title: 'demo' }, { root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('appendIteration 自增 seq 并同步 index', () => {
    const e1 = appendIteration('PROJ-9', { kind: 'init', branch: 'feature/PROJ-9' }, root)
    const e2 = appendIteration('PROJ-9', { kind: 'coding', cumulativeToken: 1234 }, root)
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e2.cumulativeToken).toBe(1234)
    const idx = readIndex(root)
    expect(idx.items['PROJ-9'].iterationCount).toBe(2)
    expect(idx.items['PROJ-9'].latestIterationAt).toBe(e2.reportedAt)
  })

  it('listIterations 按 seq 排序读取 jsonl', () => {
    appendIteration('PROJ-9', { kind: 'init' }, root)
    appendIteration('PROJ-9', { kind: 'coding', cumulativeToken: 10 }, root)
    appendIteration('PROJ-9', { kind: 'coding', cumulativeToken: 30 }, root)
    const list = listIterations('PROJ-9', root)
    expect(list.length).toBe(3)
    expect(list.map((i) => i.seq)).toEqual([1, 2, 3])
    expect(list[2].cumulativeToken).toBe(30)
  })

  it('getNextSeq 空时返回 1,非空返回 max+1', () => {
    expect(getNextSeq('PROJ-9', root)).toBe(1)
    appendIteration('PROJ-9', { kind: 'init' }, root)
    expect(getNextSeq('PROJ-9', root)).toBe(2)
  })

  it('rawPayload 非空时落盘 raw/<reportedAt>-<seq>.json', () => {
    const entry = appendIteration(
      'PROJ-9',
      {
        kind: 'coding',
        cumulativeToken: 500,
        reportedAt: '2026-05-15T08:00:00.000Z',
        rawPayload: { source: 'cursor-hook', model: 'sonnet-4' }
      },
      root
    )
    expect(entry.rawPayloadFile).toBeTruthy()
    const rawDir = join(root, 'PROJ-9', 'raw')
    expect(existsSync(rawDir)).toBe(true)
    const files = readdirSync(rawDir)
    expect(files.length).toBe(1)
    const content = JSON.parse(readFileSync(join(rawDir, files[0]), 'utf-8'))
    expect(content.source).toBe('cursor-hook')
  })

  it('rawPayload 为空时不落 raw 文件', () => {
    const entry = appendIteration('PROJ-9', { kind: 'init' }, root)
    expect(entry.rawPayloadFile).toBeNull()
    expect(existsSync(join(root, 'PROJ-9', 'raw'))).toBe(false)
  })

  it('loadRawPayload 读取已落盘的 raw 文件', () => {
    const entry = appendIteration('PROJ-9', { kind: 'coding', rawPayload: { foo: 'bar' } }, root)
    if (!entry.rawPayloadFile) throw new Error('expected rawPayloadFile')
    const loaded = loadRawPayload('PROJ-9', entry.rawPayloadFile, root)
    expect(loaded).toEqual({ foo: 'bar' })
  })

  // v2.7.0: attach_summary -> pending-summary -> appendIteration 消费
  describe('pending-summary consume (v2.7.0)', () => {
    it('coding kind iteration 消费 pending,把 conversationSummary 写到 entry', () => {
      writePendingSummary(
        'PROJ-9',
        { oneLine: '修了 attach 链路', type: 'coding', changeScope: '改了 4 个文件' },
        'cursor',
        root
      )
      const entry = appendIteration('PROJ-9', { kind: 'coding', cumulativeToken: 100 }, root)
      expect(entry.conversationSummary?.oneLine).toBe('修了 attach 链路')
      expect(entry.conversationSummary?.type).toBe('coding')
      expect(entry.conversationSummary?.changeScope).toBe('改了 4 个文件')
      // pending 已被消费
      expect(peekPendingSummary('PROJ-9', root)).toBeNull()
    })

    it('pending 中带 source 时,iteration.source 缺省/unknown 会被回填', () => {
      writePendingSummary(
        'PROJ-9',
        { oneLine: 'x', type: 'communication', discussion: 'y' },
        'cursor',
        root
      )
      // 不传 source -> 默认 unknown,会被 pending 的 cursor 回填
      const entry = appendIteration('PROJ-9', { kind: 'coding' }, root)
      expect(entry.source).toBe('cursor')
    })

    it('input.source 显式传值时优先于 pending.source', () => {
      writePendingSummary(
        'PROJ-9',
        { oneLine: 'x', type: 'communication', discussion: 'y' },
        'cursor',
        root
      )
      const entry = appendIteration('PROJ-9', { kind: 'coding', source: 'claude-code' }, root)
      expect(entry.source).toBe('claude-code')
    })

    it('init kind 不消费 pending,留给下一条 coding iteration', () => {
      writePendingSummary(
        'PROJ-9',
        { oneLine: 'x', type: 'communication', discussion: 'y' },
        undefined,
        root
      )
      const initEntry = appendIteration('PROJ-9', { kind: 'init' }, root)
      expect(initEntry.conversationSummary).toBeNull()
      // pending 还在
      expect(peekPendingSummary('PROJ-9', root)?.summary.oneLine).toBe('x')

      const next = appendIteration('PROJ-9', { kind: 'coding' }, root)
      expect(next.conversationSummary?.oneLine).toBe('x')
      expect(peekPendingSummary('PROJ-9', root)).toBeNull()
    })

    it('没有 pending 时 conversationSummary 为 null,不抛错', () => {
      const entry = appendIteration('PROJ-9', { kind: 'coding' }, root)
      expect(entry.conversationSummary).toBeNull()
    })
  })
})
