import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_RETROSPECTIVE_SCHEMA_VERSION,
  RETROSPECTIVE_LIMITS,
  buildRetrospectiveBundle,
  computeRetrospectiveSnapshot,
  loadRetrospective,
  removeRetrospective,
  writeRetrospective,
  type RetrospectiveNarrative
} from './retrospective-store.js'
import { retrospectivePath } from './paths.js'
import { loadRequirement, saveRequirement } from './requirement-store.js'
import { appendIteration, listIterations } from './iteration-store.js'
import { writeLessons } from './lessons-store.js'

function makeNarrative(overrides: Partial<RetrospectiveNarrative> = {}): RetrospectiveNarrative {
  return {
    overview:
      '本需求由 init → 多轮调试 → 一次冲刺 collapse 完成,整体 boost 偏低,主因是反复 bugfix。',
    phases: [
      {
        title: '设计与拆分',
        iterationSeqRange: [1, 2],
        summary: '梳理 baseUrl 兼容路径,确定 store 层拦截策略'
      },
      {
        title: '实现',
        iterationSeqRange: [3, 4],
        summary: '落地 normalizeJiraBaseUrl 并补单测'
      }
    ],
    highlights: ['boost > 5x 的轮次集中在 phase2'],
    issues: ['watcher 漏抓导致一轮总结漂移'],
    improvements: ['加入 sentinel 兜底'],
    pitfallsObserved: ['baseUrl 缺协议导致 422'],
    nextSteps: ['对所有 atlassian REST 入口同样补 normalize'],
    ...overrides
  }
}

describe('retrospective-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-retro-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('文件不存在时 loadRetrospective 返回 null', () => {
    expect(loadRetrospective('PROJ-1', root)).toBeNull()
  })

  it('writeRetrospective 落盘后能读回, 自动注入 schemaVersion / generatedAt / snapshot', () => {
    saveRequirement({ jiraKey: 'PROJ-1', title: 'Demo', manualEstimateMinutes: 240 }, { root })
    appendIteration('PROJ-1', { kind: 'init', cumulativeToken: 0 }, root)
    appendIteration(
      'PROJ-1',
      { kind: 'coding', cumulativeToken: 12000, thinkSeconds: 90, elapsedMinutes: 30 },
      root
    )

    const written = writeRetrospective(
      'PROJ-1',
      { narrative: makeNarrative(), source: 'cursor' },
      root
    )

    expect(written.schemaVersion).toBe(CURRENT_RETROSPECTIVE_SCHEMA_VERSION)
    expect(written.jiraKey).toBe('PROJ-1')
    expect(written.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(written.generatedAtIterationSeq).toBe(2)
    expect(written.generatedAtIterationCount).toBe(2)
    expect(written.source).toBe('cursor')
    expect(written.snapshot.title).toBe('Demo')
    expect(written.snapshot.cumulativeToken).toBe(12000)
    expect(written.snapshot.totalThinkSeconds).toBe(90)

    const back = loadRetrospective('PROJ-1', root)
    expect(back).not.toBeNull()
    expect(back!.narrative.overview).toBe(written.narrative.overview)
    expect(back!.narrative.phases).toHaveLength(2)
  })

  it('writeRetrospective 覆盖式:第二次落盘替换老内容, generatedAtIterationSeq 推进', () => {
    saveRequirement({ jiraKey: 'PROJ-2', title: '需求二' }, { root })
    appendIteration('PROJ-2', { kind: 'init' }, root)
    appendIteration('PROJ-2', { kind: 'coding', cumulativeToken: 100 }, root)

    writeRetrospective(
      'PROJ-2',
      { narrative: makeNarrative({ overview: '版本 1' }), source: 'manual' },
      root
    )

    appendIteration('PROJ-2', { kind: 'coding', cumulativeToken: 800 }, root)
    const updated = writeRetrospective(
      'PROJ-2',
      { narrative: makeNarrative({ overview: '版本 2' }), source: 'cursor' },
      root
    )
    expect(updated.narrative.overview).toBe('版本 2')
    expect(updated.generatedAtIterationSeq).toBe(3)
    expect(updated.generatedAtIterationCount).toBe(3)

    const back = loadRetrospective('PROJ-2', root)
    expect(back!.narrative.overview).toBe('版本 2')
    expect(back!.source).toBe('cursor')
  })

  it('writeRetrospective 拒绝空 overview', () => {
    saveRequirement({ jiraKey: 'PROJ-3', title: 'X' }, { root })
    expect(() =>
      writeRetrospective('PROJ-3', { narrative: makeNarrative({ overview: '   ' }) }, root)
    ).toThrow(/overview/)
  })

  it('writeRetrospective 字段超长会被静默截断', () => {
    saveRequirement({ jiraKey: 'PROJ-4', title: 'X' }, { root })
    appendIteration('PROJ-4', { kind: 'init' }, root)
    const longOverview = 'a'.repeat(RETROSPECTIVE_LIMITS.overviewMaxChars + 200)
    const written = writeRetrospective(
      'PROJ-4',
      {
        narrative: makeNarrative({
          overview: longOverview,
          highlights: Array.from({ length: 30 }, (_, i) => `highlight-${i}`)
        })
      },
      root
    )
    expect(written.narrative.overview.length).toBe(RETROSPECTIVE_LIMITS.overviewMaxChars)
    expect(written.narrative.highlights).toHaveLength(RETROSPECTIVE_LIMITS.bulletsMaxCount)
  })

  it('writeRetrospective 过滤悬挂的 referencedLessonIds(不属于本 jiraKey 的)', () => {
    saveRequirement({ jiraKey: 'PROJ-5', title: 'X' }, { root })
    saveRequirement({ jiraKey: 'OTHER-1', title: 'Y' }, { root })
    appendIteration('PROJ-5', { kind: 'init' }, root)

    const ownResult = writeLessons(
      [
        {
          jiraKey: 'PROJ-5',
          type: 'pitfall',
          title: '坑',
          content: '反复改 baseUrl',
          tags: ['baseUrl']
        }
      ],
      {},
      root
    )
    const otherResult = writeLessons(
      [
        {
          jiraKey: 'OTHER-1',
          type: 'pitfall',
          title: '别的需求的坑',
          content: '别的需求踩的',
          tags: ['x']
        }
      ],
      {},
      root
    )
    const ownId = ownResult.saved[0].id
    const otherId = otherResult.saved[0].id

    const written = writeRetrospective(
      'PROJ-5',
      {
        narrative: makeNarrative(),
        referencedLessonIds: [ownId, otherId, 'lsn-MISSING-12345678']
      },
      root
    )
    expect(written.referencedLessonIds).toEqual([ownId])
  })

  it('writeRetrospective 过滤超出 iteration 范围的 anchorIterationSeqs', () => {
    saveRequirement({ jiraKey: 'PROJ-6', title: 'X' }, { root })
    appendIteration('PROJ-6', { kind: 'init' }, root)
    appendIteration('PROJ-6', { kind: 'coding' }, root)
    appendIteration('PROJ-6', { kind: 'coding' }, root)

    const written = writeRetrospective(
      'PROJ-6',
      { narrative: makeNarrative(), anchorIterationSeqs: [2, 3, 99, -1, 0] },
      root
    )
    expect(written.anchorIterationSeqs).toEqual([2, 3])
  })

  it('removeRetrospective 删除文件, 二次删除返回 false', () => {
    saveRequirement({ jiraKey: 'PROJ-7', title: 'X' }, { root })
    appendIteration('PROJ-7', { kind: 'init' }, root)
    writeRetrospective('PROJ-7', { narrative: makeNarrative() }, root)

    expect(existsSync(retrospectivePath('PROJ-7', root))).toBe(true)
    expect(removeRetrospective('PROJ-7', root)).toBe(true)
    expect(existsSync(retrospectivePath('PROJ-7', root))).toBe(false)
    expect(removeRetrospective('PROJ-7', root)).toBe(false)
  })

  it('loadRetrospective 容忍字段缺失,走兜底默认值', () => {
    saveRequirement({ jiraKey: 'PROJ-8', title: 'X' }, { root })
    const file = retrospectivePath('PROJ-8', root)
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        jiraKey: 'PROJ-8',
        narrative: { overview: '极简版报告' }
      })
    )
    const back = loadRetrospective('PROJ-8', root)
    expect(back).not.toBeNull()
    expect(back!.narrative.overview).toBe('极简版报告')
    expect(back!.narrative.phases).toEqual([])
    expect(back!.narrative.highlights).toEqual([])
    expect(back!.referencedLessonIds).toEqual([])
    expect(back!.anchorIterationSeqs).toEqual([])
    expect(back!.snapshot.cumulativeToken).toBe(0)
    expect(back!.source).toBe('manual')
  })

  it('loadRetrospective 见到未来 schemaVersion 返回 null 且不删盘(预留升级空间)', () => {
    saveRequirement({ jiraKey: 'PROJ-9', title: 'X' }, { root })
    const file = retrospectivePath('PROJ-9', root)
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: CURRENT_RETROSPECTIVE_SCHEMA_VERSION + 99,
        jiraKey: 'PROJ-9',
        narrative: { overview: '未来版本数据' }
      })
    )
    expect(loadRetrospective('PROJ-9', root)).toBeNull()
    // 文件不应被自动删除
    expect(existsSync(file)).toBe(true)
  })

  it('loadRetrospective 损坏 JSON 返回 null', () => {
    saveRequirement({ jiraKey: 'PROJ-10', title: 'X' }, { root })
    const file = retrospectivePath('PROJ-10', root)
    writeFileSync(file, 'not json {{{')
    expect(loadRetrospective('PROJ-10', root)).toBeNull()
  })

  it('writeRetrospective 是原子写,不会留下损坏文件', () => {
    saveRequirement({ jiraKey: 'PROJ-11', title: 'X' }, { root })
    appendIteration('PROJ-11', { kind: 'init' }, root)
    writeRetrospective('PROJ-11', { narrative: makeNarrative() }, root)
    const content = readFileSync(retrospectivePath('PROJ-11', root), 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })

  it('phases 字段非法格式被静默丢弃(iterationSeqRange 缺失 / 反向)', () => {
    saveRequirement({ jiraKey: 'PROJ-12', title: 'X' }, { root })
    appendIteration('PROJ-12', { kind: 'init' }, root)
    const written = writeRetrospective(
      'PROJ-12',
      {
        narrative: {
          overview: '正常',
          phases: [
            { title: '正常段', iterationSeqRange: [1, 2], summary: 'ok' },
            { title: '反向区间', iterationSeqRange: [5, 1], summary: 'bad' } as never,
            { title: '缺 range', summary: 'no range' } as never,
            // 标题为空也丢弃
            { title: '   ', iterationSeqRange: [3, 4], summary: 'no title' } as never
          ],
          highlights: [],
          issues: [],
          improvements: [],
          pitfallsObserved: [],
          nextSteps: []
        }
      },
      root
    )
    expect(written.narrative.phases).toHaveLength(1)
    expect(written.narrative.phases[0].title).toBe('正常段')
  })

  it('computeRetrospectiveSnapshot 包含 boost / token / abnormalStopReasonsCount / lessonsCount', () => {
    saveRequirement(
      { jiraKey: 'PROJ-13', title: 'Snapshot 测试', manualEstimateMinutes: 600 },
      { root }
    )
    appendIteration('PROJ-13', { kind: 'init' }, root)
    appendIteration(
      'PROJ-13',
      {
        kind: 'coding',
        cumulativeToken: 50000,
        thinkSeconds: 600,
        elapsedMinutes: 60,
        rawPayload: { triggerStopReason: 'max_tokens' }
      },
      root
    )
    writeLessons(
      [{ jiraKey: 'PROJ-13', type: 'pitfall', title: '坑', content: 'c', tags: ['x'] }],
      {},
      root
    )

    const snap = computeRetrospectiveSnapshot(
      'PROJ-13',
      loadRequirement('PROJ-13', root),
      listIterations('PROJ-13', root),
      root
    )
    expect(snap.title).toBe('Snapshot 测试')
    expect(snap.cumulativeToken).toBe(50000)
    expect(snap.totalThinkSeconds).toBe(600)
    expect(snap.elapsedMinutes).toBe(60)
    expect(snap.boost).not.toBeNull()
    expect(snap.lessonsCount).toBeGreaterThanOrEqual(1)
    expect(snap.abnormalStopReasonsCount).toBe(1)
  })
})

describe('buildRetrospectiveBundle', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-retro-bundle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('返回 requirement / iterations / computedSignals / relatedLessons / existingRetrospective', () => {
    saveRequirement(
      {
        jiraKey: 'PROJ-1',
        title: 'Bundle 测试',
        projectSlug: '@scope/proj',
        manualEstimateMinutes: 120
      },
      { root }
    )
    appendIteration('PROJ-1', { kind: 'init' }, root)
    appendIteration('PROJ-1', { kind: 'coding', cumulativeToken: 1000, thinkSeconds: 30 }, root)
    writeLessons(
      [
        {
          jiraKey: 'PROJ-1',
          type: 'pitfall',
          title: '本需求的坑',
          content: 'x',
          scope: 'project',
          projectSlug: '@scope/proj',
          tags: ['t1']
        }
      ],
      {},
      root
    )

    const bundle = buildRetrospectiveBundle('PROJ-1', root)
    expect(bundle.jiraKey).toBe('PROJ-1')
    expect(bundle.currentProjectSlug).toBe('@scope/proj')
    expect(bundle.requirement?.title).toBe('Bundle 测试')
    expect(bundle.iterations).toHaveLength(2)
    expect(bundle.relatedLessons).toHaveLength(1)
    expect(bundle.relatedLessons[0].title).toBe('本需求的坑')
    expect(bundle.computedSignals.cumulativeEffectiveTokens).toBeGreaterThan(0)
    expect(bundle.existingRetrospective).toBeNull()
  })

  it('已落盘报告会回带在 existingRetrospective', () => {
    saveRequirement({ jiraKey: 'PROJ-2', title: 'X' }, { root })
    appendIteration('PROJ-2', { kind: 'init' }, root)
    writeRetrospective('PROJ-2', { narrative: makeNarrative({ overview: 'pre-existing' }) }, root)
    const bundle = buildRetrospectiveBundle('PROJ-2', root)
    expect(bundle.existingRetrospective).not.toBeNull()
    expect(bundle.existingRetrospective!.narrative.overview).toBe('pre-existing')
  })

  it('jiraKey 不存在时仍能返回(requirement=null,relatedLessons=[],iterations=[])', () => {
    const bundle = buildRetrospectiveBundle('GHOST-1', root)
    expect(bundle.requirement).toBeNull()
    expect(bundle.iterations).toEqual([])
    expect(bundle.relatedLessons).toEqual([])
    expect(bundle.existingRetrospective).toBeNull()
  })
})
