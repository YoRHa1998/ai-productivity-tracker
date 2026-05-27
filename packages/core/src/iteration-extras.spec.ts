import { describe, expect, it } from 'vitest'

import {
  ACTIVE_GAP_SECONDS,
  ACTIVE_GAP_SECONDS_CURSOR,
  buildIterationExtras
} from './iteration-extras.js'
import type { BindingEntry } from './bindings.js'
import type { GitDiffSummary, NumstatMap } from './git-diff.js'
import type { NumstatPerFile } from './store/numstat-snapshot.js'

function makeBinding(overrides: Partial<BindingEntry> = {}): BindingEntry {
  return {
    jiraKey: 'ABC-1',
    branch: 'feature/ABC-1',
    startedAt: '2026-05-15T00:00:00.000Z',
    cumulativeToken: 0,
    lastIterationSeq: 0,
    lastReportedAt: null,
    requirementStartedAt: '2026-05-15T00:00:00.000Z',
    lastHookFiredAt: null,
    ...overrides
  }
}

const fakeCumulativeDiff: GitDiffSummary = {
  files: 2,
  insertions: 30,
  deletions: 5,
  changedFiles: [
    { path: 'a.ts', status: 'M' },
    { path: 'b.ts', status: '??' }
  ],
  truncated: false
}

const fakeNumstat = (entries: Array<[string, NumstatPerFile]>): NumstatMap => new Map(entries)

describe('buildIterationExtras (耗时/think_seconds 不变)', () => {
  it('elapsedMinutes 用 requirementStartedAt 算到 now', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding({ requirementStartedAt: '2026-05-15T00:00:00.000Z' }),
      now: new Date('2026-05-15T01:30:00.000Z'),
      previousReportedAt: null,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.elapsedMinutes).toBe(90)
  })

  it('requirementStartedAt 缺省时回退 binding.startedAt', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding({ requirementStartedAt: null, startedAt: '2026-05-15T00:00:00.000Z' }),
      now: new Date('2026-05-15T00:45:00.000Z'),
      previousReportedAt: null,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.elapsedMinutes).toBe(45)
  })

  it('thinkSeconds 在 ≤300s 间隔内累积,>300 截断到 300', () => {
    const within = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:30.000Z',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(within.thinkSeconds).toBe(30)

    const beyond = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:30:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:00.000Z',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(beyond.thinkSeconds).toBe(ACTIVE_GAP_SECONDS)
  })

  it('previousReportedAt 缺省时 thinkSeconds=0', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:00:00.000Z'),
      previousReportedAt: null,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(0)
  })

  it('v2.12.0 turnStartedAt 提供时优先生效,thinkSeconds = now - turnStartedAt (不受 previousReportedAt 影响)', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:00:45.000Z'),
      // previousReportedAt 模拟「上一轮上报后过了 5 分钟」,旧逻辑会算 300s
      previousReportedAt: '2026-05-14T23:55:45.000Z',
      // turnStartedAt 表示「用户 prompt 真实发起 45 秒前」
      turnStartedAt: '2026-05-15T00:00:00.000Z',
      source: 'claude-code',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(45)
  })

  it('v2.12.0 turnStartedAt 不可解析时退化到 previousReportedAt 口径', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:30.000Z',
      turnStartedAt: 'not-a-date',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(30)
  })

  it("v2.12.0 source='cursor-hook' 时 cap 收紧到 60s (避免用户阅读/输入时间被算成 AI 思考)", () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      // 两次 hook 间隔 120s,Cursor 链路应被 cap 到 60s
      now: new Date('2026-05-15T00:02:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:00.000Z',
      source: 'cursor-hook',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(ACTIVE_GAP_SECONDS_CURSOR)
  })

  it("v2.12.0 source 非 'cursor-hook' 时 cap 保持 300s (兼容历史行为)", () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:10:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:00.000Z',
      source: 'claude-hook',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(ACTIVE_GAP_SECONDS)
  })

  it('v1.0.0-rc.18 pureThinkSeconds 透传:有传则原样落,缺省 undefined,不影响 thinkSeconds', () => {
    const withPure = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:03:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:00.000Z',
      turnStartedAt: '2026-05-15T00:00:00.000Z',
      source: 'cursor-hook',
      pureThinkSeconds: 12,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    // turnStartedAt 命中走 300s cap,180s 不截
    expect(withPure.thinkSeconds).toBe(180)
    expect(withPure.pureThinkSeconds).toBe(12)

    const withoutPure = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:30.000Z',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(withoutPure.pureThinkSeconds).toBeUndefined()
  })

  it('v1.0.0-rc.20 pureThinkSeconds > thinkSeconds 时钳到 thinkSeconds(修反逻辑,复现 seq 121)', () => {
    // Cursor 链路 cap=60s:两次 hook 间隔 120s,thinkSeconds 被钳到 60。
    // afterAgentThought 累加出 396s 纯思考(无上限),逻辑上不可能 > 总思考,应被钳到 60。
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:02:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:00.000Z',
      source: 'cursor-hook',
      pureThinkSeconds: 396,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.thinkSeconds).toBe(ACTIVE_GAP_SECONDS_CURSOR)
    expect(extras.pureThinkSeconds).toBe(ACTIVE_GAP_SECONDS_CURSOR)
  })

  it('v1.0.0-rc.20 负数 pureThinkSeconds 钳到 0', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:30.000Z',
      pureThinkSeconds: -5,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.pureThinkSeconds).toBe(0)
  })

  it('透传 modelName 与 cumulativeDiff 字段', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: '2026-05-15T00:00:30.000Z',
      modelName: 'claude-opus-4-7',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([])
    })
    expect(extras.modelName).toBe('claude-opus-4-7')
    expect(extras.cumulativeDiffFiles).toBe(2)
    expect(extras.cumulativeDiffInsertions).toBe(30)
    expect(extras.cumulativeDiffDeletions).toBe(5)
    expect(extras.cumulativeChangedFiles).toHaveLength(2)
  })
})

describe('buildIterationExtras 双轨 diff (总变更 / 本次对话变更)', () => {
  it('无 snapshot (首轮 iteration): 本次对话变更 = 当前 numstat 全量', () => {
    const snapshots: Array<{ baseRef: string; perFile: Record<string, NumstatPerFile> }> = []
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: null,
      initBaseCommit: 'init-sha',
      jiraKey: 'ABC-1',
      storeRoot: '/tmp/root',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () =>
        fakeNumstat([
          ['a.ts', { insertions: 30, deletions: 5 }],
          ['b.ts', { insertions: 0, deletions: 0 }]
        ]),
      readSnapshot: () => null,
      writeSnapshot: (_jira, snap) => {
        snapshots.push({ baseRef: snap.baseRef, perFile: snap.perFile })
      }
    })
    expect(extras.diffFiles).toBe(1)
    expect(extras.diffInsertions).toBe(30)
    expect(extras.diffDeletions).toBe(5)
    expect(extras.cumulativeDiffFiles).toBe(2)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].baseRef).toBe('init-sha')
    expect(snapshots[0].perFile['a.ts'].insertions).toBe(30)
  })

  it('有 snapshot: 本次对话变更 = current - prev, prev 大于 current 时截到 0', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:02:00.000Z'),
      previousReportedAt: '2026-05-15T00:01:00.000Z',
      initBaseCommit: 'init-sha',
      jiraKey: 'ABC-1',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () =>
        fakeNumstat([
          // a.ts 比上一轮多了 10 行 +, 5 行 -
          ['a.ts', { insertions: 40, deletions: 10 }],
          // c.ts 新增,全量计入
          ['c.ts', { insertions: 7, deletions: 0 }]
        ]),
      readSnapshot: () => ({
        perFile: {
          'a.ts': { insertions: 30, deletions: 5 },
          // b.ts 在 prev 有,本轮已撤销 -> 不计入
          'b.ts': { insertions: 4, deletions: 0 }
        }
      }),
      writeSnapshot: () => undefined
    })
    expect(extras.diffFiles).toBe(2) // a.ts + c.ts
    expect(extras.diffInsertions).toBe(17) // 10 + 7
    expect(extras.diffDeletions).toBe(5) // 5 (a.ts) + 0
  })

  it('提交后 numstat 缩水 (current < prev): 本次对话变更视为 0, 不报负数', () => {
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:03:00.000Z'),
      previousReportedAt: '2026-05-15T00:02:00.000Z',
      initBaseCommit: 'init-sha',
      jiraKey: 'ABC-1',
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([['a.ts', { insertions: 5, deletions: 0 }]]),
      readSnapshot: () => ({
        perFile: {
          'a.ts': { insertions: 100, deletions: 80 }
        }
      }),
      writeSnapshot: () => undefined
    })
    expect(extras.diffFiles).toBe(0)
    expect(extras.diffInsertions).toBe(0)
    expect(extras.diffDeletions).toBe(0)
  })

  it('initBaseCommit 缺省时回退到 HEAD 作为 baseRef', () => {
    let observedBaseRef = ''
    buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: null,
      jiraKey: 'ABC-1',
      collectDiff: (_root, ref) => {
        observedBaseRef = ref
        return fakeCumulativeDiff
      },
      collectNumstatFn: () => fakeNumstat([]),
      readSnapshot: () => null,
      writeSnapshot: () => undefined
    })
    expect(observedBaseRef).toBe('HEAD')
  })

  it('缺 jiraKey 时不读写 snapshot, 也不计算 iterDiff (退化为空)', () => {
    let snapshotWrites = 0
    const extras = buildIterationExtras({
      gitRoot: '/tmp/repo',
      binding: makeBinding(),
      now: new Date('2026-05-15T00:01:00.000Z'),
      previousReportedAt: null,
      collectDiff: () => fakeCumulativeDiff,
      collectNumstatFn: () => fakeNumstat([['a.ts', { insertions: 30, deletions: 5 }]]),
      readSnapshot: () => null,
      writeSnapshot: () => {
        snapshotWrites += 1
      }
    })
    expect(snapshotWrites).toBe(0)
    // 没有 jiraKey -> prev 永远为 null -> 当前 numstat 全部算作首次新增
    expect(extras.diffFiles).toBe(1)
    expect(extras.cumulativeDiffFiles).toBe(2)
  })
})
