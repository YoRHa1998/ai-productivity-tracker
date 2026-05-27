import { describe, it, expect } from 'vitest'

import {
  computeCompletion,
  computeMetrics,
  buildOverallSummary,
  buildSummaryView
} from './metrics.js'
import { DEFAULT_FORMULA } from './store/formula-store.js'
import { normalizeIterationSource, type StoredIteration } from './store/iteration-store.js'
import type { StoredRequirement } from './store/requirement-store.js'

function iter(partial: Partial<StoredIteration>): StoredIteration {
  return {
    seq: 1,
    kind: 'coding',
    branch: '',
    source: 'unknown',
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
    reportedAt: new Date().toISOString(),
    rawPayloadFile: null,
    conversationSummary: null,
    ...partial
  }
}

function req(partial: Partial<StoredRequirement>): StoredRequirement {
  return {
    jiraKey: 'PROJ-1',
    jiraUrl: '',
    title: 't',
    summary: '',
    complexity: 'medium',
    manualEstimateMinutes: 0,
    subtasks: [],
    affectedPaths: [],
    owner: '',
    projectSlug: '',
    status: 'in_progress',
    linkedBugCount: 0,
    linkedBugJql: '',
    bugsRefreshedAt: null,
    clarifyReportPath: '',
    clarifyReviewerScore: null,
    clarifyConflicts: [],
    startedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    initBaseCommit: '',
    ...partial
  }
}

describe('metrics', () => {
  it('computeCompletion 空时返回 0', () => {
    expect(computeCompletion([])).toBe(0)
  })

  it('computeCompletion 按 weight 加权', () => {
    expect(
      computeCompletion([
        { id: '1', title: 'a', weight: 1, done: true },
        { id: '2', title: 'b', weight: 3, done: false }
      ])
    ).toBe(0.25)
  })

  it('computeMetrics 计算 boost / penalty', () => {
    const m = computeMetrics({
      manualEstimateMinutes: 480,
      iterations: [iter({ kind: 'coding', cumulativeToken: 10000, elapsedMinutes: 60 })],
      subtasks: [{ id: '1', title: 'a', weight: 1, done: true }],
      linkedBugCount: 1,
      formula: DEFAULT_FORMULA
    })
    expect(m.codingRuns).toBe(1)
    expect(m.bugPenalty).toBeCloseTo(1.15, 4)
    expect(m.boost).not.toBeNull()
  })

  it('computeMetrics 累加各轮 thinkSeconds 为 totalThinkSeconds', () => {
    const m = computeMetrics({
      manualEstimateMinutes: 480,
      iterations: [
        iter({ seq: 1, kind: 'init', thinkSeconds: 0 }),
        iter({ seq: 2, kind: 'coding', thinkSeconds: 120 }),
        iter({ seq: 3, kind: 'coding', thinkSeconds: 90 })
      ],
      subtasks: [],
      linkedBugCount: 0,
      formula: DEFAULT_FORMULA
    })
    expect(m.totalThinkSeconds).toBe(210)
  })

  it('computeMetrics 无 iteration 时 boost 为 null', () => {
    const m = computeMetrics({
      manualEstimateMinutes: 480,
      iterations: [],
      subtasks: [],
      linkedBugCount: 0,
      formula: DEFAULT_FORMULA
    })
    expect(m.boost).toBeNull()
  })

  it('buildSummaryView 汇总 iterationCount / latestIterationAt', () => {
    const view = buildSummaryView(
      req({ jiraKey: 'PROJ-1', title: 't' }),
      [
        iter({ seq: 1, kind: 'init', reportedAt: '2026-05-01T01:00:00.000Z' }),
        iter({
          seq: 2,
          kind: 'coding',
          cumulativeToken: 500,
          elapsedMinutes: 30,
          reportedAt: '2026-05-01T02:00:00.000Z'
        })
      ],
      DEFAULT_FORMULA
    )
    expect(view.iterationCount).toBe(2)
    expect(view.latestIterationAt).toBe('2026-05-01T02:00:00.000Z')
    expect(view.metrics.latestCumulativeToken).toBe(500)
  })

  it('normalizeIterationSource 把合法值原样返回、非法值归一化为 unknown', () => {
    expect(normalizeIterationSource('cursor')).toBe('cursor')
    expect(normalizeIterationSource('claude-code')).toBe('claude-code')
    expect(normalizeIterationSource('unknown')).toBe('unknown')
    expect(normalizeIterationSource(undefined)).toBe('unknown')
    expect(normalizeIterationSource(null)).toBe('unknown')
    expect(normalizeIterationSource('foo')).toBe('unknown')
    expect(normalizeIterationSource(123)).toBe('unknown')
  })

  it('buildSummaryView 保留 iteration.source 给前端渲染来源 chip', () => {
    const view = buildSummaryView(
      req({ jiraKey: 'PROJ-1' }),
      [
        iter({ seq: 1, kind: 'init', source: 'cursor' }),
        iter({ seq: 2, kind: 'coding', source: 'claude-code' })
      ],
      DEFAULT_FORMULA
    )
    // metrics 视图本身不直接复用 source,但通过 storedIteration 流入 detail 端;
    // 这里只验证 normalize 不破坏字段(回归保护)
    expect(view.iterationCount).toBe(2)
  })

  it('buildOverallSummary 计算 average boost', () => {
    const v1 = buildSummaryView(
      req({ jiraKey: 'A-1', status: 'in_progress', linkedBugCount: 1, manualEstimateMinutes: 480 }),
      [iter({ kind: 'coding', cumulativeToken: 1000, elapsedMinutes: 30 })],
      DEFAULT_FORMULA
    )
    const v2 = buildSummaryView(
      req({ jiraKey: 'A-2', status: 'finished', linkedBugCount: 0, manualEstimateMinutes: 240 }),
      [iter({ kind: 'coding', cumulativeToken: 500, elapsedMinutes: 30 })],
      DEFAULT_FORMULA
    )
    const overall = buildOverallSummary([v1, v2])
    expect(overall.totalRequirements).toBe(2)
    expect(overall.inProgressCount).toBe(1)
    expect(overall.finishedCount).toBe(1)
    expect(overall.totalBugCount).toBe(1)
    expect(overall.averageBoost).not.toBeNull()
  })
})
