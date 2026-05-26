import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendIteration,
  backupIterations,
  getNextSeq,
  listIterations,
  loadRawPayload,
  mergeAutoSplitIterations,
  mergeIterationPair,
  rewriteIterations,
  shouldMergeAutoSplit,
  type StoredIteration
} from './iteration-store.js'
import { saveRequirement } from './requirement-store.js'
import { readIndex } from './index-store.js'
import { iterationsFilePath } from './paths.js'
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

  // v2.18.0 数据整理:合并 Cursor stop-hook 兜底产生的拆分 iteration
  describe('mergeAutoSplitIterations (v2.18.0)', () => {
    function baseIter(overrides: Partial<StoredIteration> = {}): StoredIteration {
      return {
        seq: 0,
        kind: 'coding',
        branch: 'feature/PROJ-9-x',
        source: 'cursor',
        cumulativeToken: 0,
        elapsedMinutes: 0,
        firstCodingCompletion: null,
        aiQualitySelfScore: null,
        aiConfidence: null,
        diffFiles: 0,
        diffInsertions: 0,
        diffDeletions: 0,
        changedFiles: [],
        cumulativeDiffFiles: 0,
        cumulativeDiffInsertions: 0,
        cumulativeDiffDeletions: 0,
        cumulativeChangedFiles: [],
        milestoneNote: '',
        thinkSeconds: 0,
        modelName: '',
        reportedAt: '',
        rawPayloadFile: null,
        conversationSummary: null,
        ...overrides
      }
    }

    describe('shouldMergeAutoSplit 严格规则', () => {
      const summary = { oneLine: 't', type: 'communication' as const, discussion: 'd' }

      it('正常拆分对 → 命中', () => {
        const a = baseIter({
          seq: 1,
          reportedAt: '2026-05-26T00:00:00.000Z',
          conversationSummary: null
        })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:00:30.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(true)
      })

      it('间隔正好 120s → 命中边界', () => {
        const a = baseIter({ seq: 1, reportedAt: '2026-05-26T00:00:00.000Z' })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:02:00.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(true)
      })

      it('间隔 > 120s → 不命中', () => {
        const a = baseIter({ seq: 1, reportedAt: '2026-05-26T00:00:00.000Z' })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:02:00.001Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('a 已有总结 → 不命中', () => {
        const a = baseIter({
          seq: 1,
          reportedAt: '2026-05-26T00:00:00.000Z',
          conversationSummary: summary
        })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:00:30.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('b 没有总结 → 不命中', () => {
        const a = baseIter({ seq: 1, reportedAt: '2026-05-26T00:00:00.000Z' })
        const b = baseIter({ seq: 2, reportedAt: '2026-05-26T00:00:30.000Z' })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('b.source 非 cursor → 不命中', () => {
        const a = baseIter({ seq: 1, reportedAt: '2026-05-26T00:00:00.000Z' })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:00:30.000Z',
          source: 'claude-code',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('branch 不同 → 不命中', () => {
        const a = baseIter({
          seq: 1,
          branch: 'feature/PROJ-9-a',
          reportedAt: '2026-05-26T00:00:00.000Z'
        })
        const b = baseIter({
          seq: 2,
          branch: 'feature/PROJ-9-b',
          reportedAt: '2026-05-26T00:00:30.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('a.kind=init → 不命中', () => {
        const a = baseIter({ seq: 1, kind: 'init', reportedAt: '2026-05-26T00:00:00.000Z' })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:00:30.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })

      it('reportedAt 反序(b 早于 a)→ 不命中', () => {
        const a = baseIter({ seq: 1, reportedAt: '2026-05-26T00:00:30.000Z' })
        const b = baseIter({
          seq: 2,
          reportedAt: '2026-05-26T00:00:00.000Z',
          conversationSummary: summary
        })
        expect(shouldMergeAutoSplit(a, b)).toBe(false)
      })
    })

    describe('mergeIterationPair 字段合并', () => {
      const summary = {
        oneLine: '本轮总结',
        type: 'coding' as const,
        changeScope: '改了 store'
      }

      it('增量字段累加 / 累计快照取 b / summary 取 b / seq 保留 a', () => {
        const a = baseIter({
          seq: 5,
          reportedAt: '2026-05-26T00:00:00.000Z',
          source: 'cursor',
          cumulativeToken: 1000,
          elapsedMinutes: 10,
          thinkSeconds: 3,
          diffFiles: 1,
          diffInsertions: 10,
          diffDeletions: 0,
          changedFiles: [{ path: 'a.ts', status: 'A' }],
          cumulativeDiffFiles: 1,
          cumulativeDiffInsertions: 10,
          cumulativeDiffDeletions: 0,
          cumulativeChangedFiles: [{ path: 'a.ts', status: 'A' }],
          modelName: '',
          rawPayloadFile: 'a-5.json'
        })
        const b = baseIter({
          seq: 6,
          reportedAt: '2026-05-26T00:00:30.000Z',
          source: 'cursor',
          cumulativeToken: 1500,
          elapsedMinutes: 12,
          thinkSeconds: 2,
          diffFiles: 1,
          diffInsertions: 5,
          diffDeletions: 3,
          changedFiles: [{ path: 'a.ts', status: 'M' }],
          cumulativeDiffFiles: 1,
          cumulativeDiffInsertions: 15,
          cumulativeDiffDeletions: 3,
          cumulativeChangedFiles: [{ path: 'a.ts', status: 'M' }],
          modelName: 'sonnet-4',
          conversationSummary: summary,
          rawPayloadFile: 'b-6.json'
        })

        const merged = mergeIterationPair(a, b)
        expect(merged.seq).toBe(5)
        expect(merged.reportedAt).toBe(b.reportedAt)
        expect(merged.cumulativeToken).toBe(1500)
        expect(merged.elapsedMinutes).toBe(12)
        expect(merged.thinkSeconds).toBe(5)
        expect(merged.diffFiles).toBe(2)
        expect(merged.diffInsertions).toBe(15)
        expect(merged.diffDeletions).toBe(3)
        expect(merged.changedFiles).toEqual([{ path: 'a.ts', status: 'M' }])
        expect(merged.cumulativeDiffFiles).toBe(1)
        expect(merged.cumulativeDiffInsertions).toBe(15)
        expect(merged.cumulativeDiffDeletions).toBe(3)
        expect(merged.modelName).toBe('sonnet-4')
        expect(merged.rawPayloadFile).toBe('a-5.json')
        expect(merged.conversationSummary).toEqual(summary)
      })

      it('changedFiles 跨 a/b 合并去重,后者 status 胜出', () => {
        const a = baseIter({
          seq: 1,
          changedFiles: [
            { path: 'x.ts', status: 'A' },
            { path: 'y.ts', status: 'M' }
          ]
        })
        const b = baseIter({
          seq: 2,
          changedFiles: [
            { path: 'y.ts', status: 'D' },
            { path: 'z.ts', status: 'A' }
          ]
        })
        const merged = mergeIterationPair(a, b)
        const byPath = new Map(merged.changedFiles.map((f) => [f.path, f.status]))
        expect(byPath.size).toBe(3)
        expect(byPath.get('x.ts')).toBe('A')
        expect(byPath.get('y.ts')).toBe('D')
        expect(byPath.get('z.ts')).toBe('A')
      })
    })

    it('真合并 e2e:写盘 + .bak 备份 + INDEX 同步 + 字段合并落实', () => {
      const branch = 'feature/PROJ-9-merge'
      const t = (offset: number) =>
        new Date(Date.parse('2026-05-26T00:00:00.000Z') + offset).toISOString()

      appendIteration('PROJ-9', { kind: 'init', branch, reportedAt: t(0) }, root)
      // 拆分对 1: #2 空 + #3 满 (间隔 30s)
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          cumulativeToken: 1000,
          thinkSeconds: 5,
          reportedAt: t(10_000)
        },
        root
      )
      writePendingSummary(
        'PROJ-9',
        { oneLine: '拆分对1的总结', type: 'coding', changeScope: '改 store' },
        'cursor',
        root
      )
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          cumulativeToken: 1500,
          thinkSeconds: 3,
          reportedAt: t(40_000)
        },
        root
      )
      // 普通孤立条目: #4 有总结
      writePendingSummary(
        'PROJ-9',
        { oneLine: '孤立轮', type: 'communication', discussion: '聊聊' },
        'cursor',
        root
      )
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          cumulativeToken: 2000,
          reportedAt: t(300_000)
        },
        root
      )
      // 拆分对 2: #5 空 + #6 满 (间隔 50s)
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          cumulativeToken: 2200,
          thinkSeconds: 2,
          reportedAt: t(600_000)
        },
        root
      )
      writePendingSummary(
        'PROJ-9',
        { oneLine: '拆分对2总结', type: 'coding', changeScope: '改 route' },
        'cursor',
        root
      )
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          cumulativeToken: 2500,
          thinkSeconds: 4,
          reportedAt: t(650_000)
        },
        root
      )

      // dryRun:不写盘,但返回候选
      const dry = mergeAutoSplitIterations('PROJ-9', { dryRun: true, root })
      expect(dry.mergedPairs.length).toBe(2)
      expect(dry.totalBefore).toBe(6)
      expect(dry.totalAfter).toBe(4)
      expect(dry.backupPath).toBeNull()
      expect(listIterations('PROJ-9', root).length).toBe(6)

      // 真合并
      const result = mergeAutoSplitIterations('PROJ-9', { root })
      expect(result.mergedPairs.length).toBe(2)
      expect(result.mergedPairs[0]).toEqual({ fromSeq: 3, intoSeq: 2 })
      expect(result.mergedPairs[1]).toEqual({ fromSeq: 6, intoSeq: 5 })
      expect(result.totalBefore).toBe(6)
      expect(result.totalAfter).toBe(4)
      expect(result.backupPath).toBeTruthy()
      expect(existsSync(result.backupPath!)).toBe(true)

      const after = listIterations('PROJ-9', root)
      expect(after.length).toBe(4)
      expect(after.map((i) => i.seq)).toEqual([1, 2, 4, 5])

      const mergedFirst = after.find((i) => i.seq === 2)!
      expect(mergedFirst.conversationSummary?.oneLine).toBe('拆分对1的总结')
      expect(mergedFirst.cumulativeToken).toBe(1500)
      expect(mergedFirst.thinkSeconds).toBe(8)
      expect(mergedFirst.reportedAt).toBe(t(40_000))

      const mergedSecond = after.find((i) => i.seq === 5)!
      expect(mergedSecond.conversationSummary?.oneLine).toBe('拆分对2总结')
      expect(mergedSecond.cumulativeToken).toBe(2500)
      expect(mergedSecond.thinkSeconds).toBe(6)

      const idx = readIndex(root)
      expect(idx.items['PROJ-9'].iterationCount).toBe(4)
      expect(idx.items['PROJ-9'].latestIterationAt).toBe(t(650_000))
    })

    it('没有候选时:不写盘,不备份', () => {
      appendIteration('PROJ-9', { kind: 'init' }, root)
      appendIteration('PROJ-9', { kind: 'coding', cumulativeToken: 100 }, root)
      const before = readFileSync(iterationsFilePath('PROJ-9', root), 'utf-8')

      const result = mergeAutoSplitIterations('PROJ-9', { root })
      expect(result.mergedPairs).toEqual([])
      expect(result.backupPath).toBeNull()
      expect(result.totalBefore).toBe(2)
      expect(result.totalAfter).toBe(2)

      const after = readFileSync(iterationsFilePath('PROJ-9', root), 'utf-8')
      expect(after).toBe(before)
    })

    it('连续 [空, 空, 满] 三条相邻:只合后两条,不错配前空 + 中空', () => {
      const branch = 'feature/PROJ-9-x'
      const t = (offset: number) =>
        new Date(Date.parse('2026-05-26T00:00:00.000Z') + offset).toISOString()
      appendIteration('PROJ-9', { kind: 'init', branch, reportedAt: t(0) }, root)
      // 三条 coding,前两条无总结(空),最后一条满(应合并 b+c)
      appendIteration(
        'PROJ-9',
        { kind: 'coding', branch, source: 'cursor', reportedAt: t(10_000) },
        root
      )
      appendIteration(
        'PROJ-9',
        { kind: 'coding', branch, source: 'cursor', reportedAt: t(40_000) },
        root
      )
      writePendingSummary(
        'PROJ-9',
        { oneLine: '后两条合并', type: 'communication', discussion: 'd' },
        'cursor',
        root
      )
      appendIteration(
        'PROJ-9',
        { kind: 'coding', branch, source: 'cursor', reportedAt: t(70_000) },
        root
      )

      const result = mergeAutoSplitIterations('PROJ-9', { root })
      // 仅一对被合并:扫描从前往后,#2 和 #3 都空(b.summary=null 不命中),前进一步;
      // #3 和 #4 命中(前空后满),合并为 #3,即 fromSeq=4 intoSeq=3.
      expect(result.mergedPairs.length).toBe(1)
      expect(result.mergedPairs[0]).toEqual({ fromSeq: 4, intoSeq: 3 })
      const after = listIterations('PROJ-9', root)
      expect(after.map((i) => i.seq)).toEqual([1, 2, 3])
    })

    it('rewriteIterations 空数组 → 文件清空 + INDEX iterationCount=0', () => {
      appendIteration('PROJ-9', { kind: 'init' }, root)
      appendIteration('PROJ-9', { kind: 'coding' }, root)
      const result = rewriteIterations('PROJ-9', () => [], root)
      expect(result.wrote).toBe(0)
      expect(listIterations('PROJ-9', root)).toEqual([])
      expect(readFileSync(iterationsFilePath('PROJ-9', root), 'utf-8')).toBe('')
      const idx = readIndex(root)
      expect(idx.items['PROJ-9'].iterationCount).toBe(0)
      // latestIterationAt 在 upsertIndexEntry 内部用 ?? 兜底,无法被 null 覆盖,
      // 即沿用 existing 的非 null 值;空路径属于边界,合并主链路永不归零。
      expect(typeof idx.items['PROJ-9'].latestIterationAt).toBe('string')
    })

    it('backupIterations 文件不存在时返回 null', () => {
      // PROJ-9 现在没有任何 iteration 文件
      const path = iterationsFilePath('PROJ-9', root)
      if (existsSync(path)) {
        rmSync(path)
      }
      const backup = backupIterations('PROJ-9', root)
      expect(backup).toBeNull()
    })

    it('backupIterations 与 .bak-<ts> 文件名格式', () => {
      appendIteration('PROJ-9', { kind: 'init' }, root)
      const backup = backupIterations('PROJ-9', root)
      expect(backup).toBeTruthy()
      expect(/\.bak-\d{14}$/.test(backup!)).toBe(true)
      expect(existsSync(backup!)).toBe(true)
    })

    it('rewriteIterations 不影响 raw/ 目录(孤儿文件继续存在)', () => {
      const branch = 'feature/PROJ-9-raw'
      appendIteration('PROJ-9', { kind: 'init', branch }, root)
      const a = appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          rawPayload: { tag: 'a' },
          reportedAt: '2026-05-26T00:00:00.000Z'
        },
        root
      )
      writePendingSummary(
        'PROJ-9',
        { oneLine: 't', type: 'communication', discussion: 'd' },
        'cursor',
        root
      )
      const b = appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          rawPayload: { tag: 'b' },
          reportedAt: '2026-05-26T00:00:20.000Z'
        },
        root
      )
      expect(a.rawPayloadFile).toBeTruthy()
      expect(b.rawPayloadFile).toBeTruthy()
      const result = mergeAutoSplitIterations('PROJ-9', { root })
      expect(result.mergedPairs.length).toBe(1)
      // b 的 raw 文件仍然在硬盘上,主表已不引用
      expect(existsSync(join(root, 'PROJ-9', 'raw', b.rawPayloadFile!))).toBe(true)
    })

    it('已合并过的数据再次合并是幂等的(无新拆分对)', () => {
      // 用 writeFileSync 直接构造一对拆分,触发合并
      const branch = 'feature/PROJ-9-y'
      appendIteration('PROJ-9', { kind: 'init', branch }, root)
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          reportedAt: '2026-05-26T00:00:00.000Z'
        },
        root
      )
      writePendingSummary(
        'PROJ-9',
        { oneLine: 'one', type: 'communication', discussion: 'd' },
        'cursor',
        root
      )
      appendIteration(
        'PROJ-9',
        {
          kind: 'coding',
          branch,
          source: 'cursor',
          reportedAt: '2026-05-26T00:00:30.000Z'
        },
        root
      )

      const first = mergeAutoSplitIterations('PROJ-9', { root })
      expect(first.mergedPairs.length).toBe(1)
      const second = mergeAutoSplitIterations('PROJ-9', { root })
      expect(second.mergedPairs).toEqual([])
      expect(second.totalBefore).toBe(second.totalAfter)
    })

    it('跳过 jsonl 中无法解析的脏行后再走合并流程', () => {
      // 手动构造一份含脏行的 jsonl
      const file = iterationsFilePath('PROJ-9', root)
      appendIteration('PROJ-9', { kind: 'init' }, root)
      writeFileSync(file, readFileSync(file, 'utf-8') + 'not-json-line\n', 'utf-8')
      // 应不抛错,listIterations 跳过脏行,merge 结果合理
      const result = mergeAutoSplitIterations('PROJ-9', { root })
      expect(result.mergedPairs).toEqual([])
    })
  })
})
