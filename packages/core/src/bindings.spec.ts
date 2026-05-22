import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTokenUsage,
  ensureAipDir,
  readBindings,
  resetBindingForNewInit,
  resolveActiveBindingByCwd,
  upsertBinding
} from './bindings.js'

describe('bindings module', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aip-bind-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('ensureAipDir 创建 .ai-productivity 目录', () => {
    const dir = ensureAipDir(projectRoot)
    expect(dir).toBe(join(projectRoot, '.ai-productivity'))
    expect(existsSync(dir)).toBe(true)
  })

  it('readBindings 在文件缺失时返回默认结构', () => {
    const result = readBindings(projectRoot)
    expect(result).toEqual({ version: 1, bindings: {}, pending: {} })
  })

  it('upsertBinding 写入新条目 (v2.0 主键为 jiraKey,无 requirementId)', () => {
    upsertBinding(projectRoot, 'ABC-123', {
      branch: 'feature/ABC-123-test',
      startedAt: '2026-05-14T00:00:00.000Z'
    })

    const file = join(projectRoot, '.ai-productivity', 'bindings.json')
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed.bindings['ABC-123']).toMatchObject({
      jiraKey: 'ABC-123',
      branch: 'feature/ABC-123-test',
      cumulativeToken: 0,
      lastIterationSeq: 0
    })
    expect(parsed.bindings['ABC-123'].requirementId).toBeUndefined()
  })

  it('readBindings 兼容 v1 老格式 (有 requirementId 字段) 并丢弃该字段', () => {
    const dir = ensureAipDir(projectRoot)
    writeFileSync(
      join(dir, 'bindings.json'),
      JSON.stringify({
        version: 1,
        bindings: {
          'OLD-1': {
            requirementId: 99,
            jiraKey: 'OLD-1',
            branch: 'feature/OLD-1-x',
            startedAt: '2026-04-01T00:00:00.000Z',
            cumulativeToken: 1234,
            lastIterationSeq: 5
          }
        },
        pending: {}
      })
    )
    const result = readBindings(projectRoot)
    expect(result.bindings['OLD-1'].jiraKey).toBe('OLD-1')
    expect(result.bindings['OLD-1'].cumulativeToken).toBe(1234)
    expect(
      (result.bindings['OLD-1'] as unknown as { requirementId?: number }).requirementId
    ).toBeUndefined()
  })

  it('upsertBinding 保留已有 cumulativeToken,并合并 pending', () => {
    upsertBinding(projectRoot, 'ABC-123', {
      branch: 'feature/ABC-123-test',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    upsertBinding(projectRoot, 'ABC-123', {
      branch: 'feature/ABC-123-test',
      startedAt: '2026-05-14T00:00:00.000Z',
      mergePendingTokens: 999
    })
    const result = readBindings(projectRoot)
    expect(result.bindings['ABC-123'].cumulativeToken).toBe(999)
  })

  describe('resetBindingForNewInit (v2.7.2)', () => {
    it('已存在 binding 时全字段重置 (cumulativeToken / startedAt / requirementStartedAt / lastIterationSeq / lastReportedAt / lastHookFiredAt)', () => {
      // 预置一个带历史包袱的 binding
      upsertBinding(projectRoot, 'ABC-555', {
        branch: 'feature/old-branch',
        startedAt: '2026-05-19T08:00:00.000Z',
        requirementStartedAt: '2026-05-19T08:00:00.000Z'
      })
      // 用 appendTokenUsage 累加几次,产生 lastReportedAt / lastHookFiredAt / cumulativeToken
      appendTokenUsage(
        projectRoot,
        'feature/old-branch',
        'ABC-555',
        895000,
        '2026-05-19T10:00:00.000Z'
      )
      const before = readBindings(projectRoot).bindings['ABC-555']
      expect(before.cumulativeToken).toBe(895000)
      expect(before.startedAt).toBe('2026-05-19T08:00:00.000Z')
      expect(before.lastReportedAt).toBe('2026-05-19T10:00:00.000Z')
      expect(before.lastHookFiredAt).toBe('2026-05-19T10:00:00.000Z')

      // 触发 init reset
      const newNow = '2026-05-20T17:36:53.000Z'
      resetBindingForNewInit(projectRoot, 'ABC-555', 'feature/new-branch', newNow)

      const after = readBindings(projectRoot).bindings['ABC-555']
      expect(after.jiraKey).toBe('ABC-555')
      expect(after.branch).toBe('feature/new-branch')
      expect(after.cumulativeToken).toBe(0)
      expect(after.startedAt).toBe(newNow)
      expect(after.requirementStartedAt).toBe(newNow)
      expect(after.lastIterationSeq).toBe(0)
      expect(after.lastReportedAt).toBeNull()
      expect(after.lastHookFiredAt).toBeNull()
    })

    it('不存在 binding 时 no-op (bindings 不新增项,pending 也不会凭空创建)', () => {
      resetBindingForNewInit(projectRoot, 'NEW-1', 'feature/new-1', '2026-05-20T00:00:00.000Z')
      const after = readBindings(projectRoot)
      expect(after.bindings['NEW-1']).toBeUndefined()
      expect(after.pending['NEW-1']).toBeUndefined()
    })

    it('pending[jiraKey] 被强制清空,防 init 后 upsertBinding 把老 pending 吸收回来', () => {
      // 模拟分支还没 init 时先攒 pending
      appendTokenUsage(
        projectRoot,
        'feature/PENDING-1-x',
        'PENDING-1',
        12345,
        '2026-05-20T00:00:00.000Z'
      )
      const beforePending = readBindings(projectRoot).pending['PENDING-1']
      expect(beforePending?.cumulativeToken).toBe(12345)

      // 即使 bindings 中没有 PENDING-1,reset 也要清掉 pending
      resetBindingForNewInit(
        projectRoot,
        'PENDING-1',
        'feature/PENDING-1-x',
        '2026-05-20T01:00:00.000Z'
      )

      const after = readBindings(projectRoot)
      expect(after.bindings['PENDING-1']).toBeUndefined()
      expect(after.pending['PENDING-1']).toBeUndefined()

      // 后续 upsertBinding 应当从 0 开始,不会吸收已清空的 pending
      const fresh = upsertBinding(projectRoot, 'PENDING-1', {
        branch: 'feature/PENDING-1-x',
        startedAt: '2026-05-20T01:00:00.000Z'
      })
      expect(fresh.cumulativeToken).toBe(0)
    })

    it('reset 仅作用于本次 issueKey,同仓库其他 binding 不动', () => {
      upsertBinding(projectRoot, 'KEEP-1', {
        branch: 'feature/KEEP-1',
        startedAt: '2026-05-18T00:00:00.000Z'
      })
      appendTokenUsage(projectRoot, 'feature/KEEP-1', 'KEEP-1', 5000, '2026-05-18T01:00:00.000Z')
      upsertBinding(projectRoot, 'RESET-1', {
        branch: 'feature/RESET-1',
        startedAt: '2026-05-19T00:00:00.000Z'
      })
      appendTokenUsage(projectRoot, 'feature/RESET-1', 'RESET-1', 8000, '2026-05-19T01:00:00.000Z')

      resetBindingForNewInit(projectRoot, 'RESET-1', 'feature/RESET-1', '2026-05-20T00:00:00.000Z')

      const after = readBindings(projectRoot)
      expect(after.bindings['KEEP-1'].cumulativeToken).toBe(5000)
      expect(after.bindings['KEEP-1'].startedAt).toBe('2026-05-18T00:00:00.000Z')
      expect(after.bindings['RESET-1'].cumulativeToken).toBe(0)
      expect(after.bindings['RESET-1'].startedAt).toBe('2026-05-20T00:00:00.000Z')
    })
  })
})

describe('appendTokenUsage', () => {
  let projectRoot: string
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aip-token-'))
  })
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it('已绑定的需求:累加到 binding.cumulativeToken,bound=true', () => {
    upsertBinding(projectRoot, 'ABC-1', {
      branch: 'feature/ABC-1-x',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    const result = appendTokenUsage(
      projectRoot,
      'feature/ABC-1-x',
      'ABC-1',
      150,
      '2026-05-14T01:00:00.000Z'
    )
    expect(result.bound).toBe(true)
    expect(result.binding?.cumulativeToken).toBe(150)
    expect(result.binding?.jiraKey).toBe('ABC-1')

    const again = appendTokenUsage(
      projectRoot,
      'feature/ABC-1-x',
      'ABC-1',
      50,
      '2026-05-14T02:00:00.000Z'
    )
    expect(again.binding?.cumulativeToken).toBe(200)
  })

  it('未绑定时累加到 pending,bound=false', () => {
    const result = appendTokenUsage(
      projectRoot,
      'feature/XYZ-99-x',
      'XYZ-99',
      80,
      '2026-05-14T00:00:00.000Z'
    )
    expect(result.bound).toBe(false)
    expect(result.binding).toBeNull()
    expect(result.pendingAccumulated).toBe(80)

    const more = appendTokenUsage(
      projectRoot,
      'feature/XYZ-99-x',
      'XYZ-99',
      20,
      '2026-05-14T01:00:00.000Z'
    )
    expect(more.pendingAccumulated).toBe(100)

    const persisted = readBindings(projectRoot)
    expect(persisted.pending['XYZ-99'].cumulativeToken).toBe(100)
    expect(persisted.pending['XYZ-99'].firstSeenAt).toBe('2026-05-14T00:00:00.000Z')
  })

  it('upsertBinding 后,pending 中已累计的 token 会被吸收为初始 cumulativeToken', () => {
    appendTokenUsage(projectRoot, 'feature/ABC-2-x', 'ABC-2', 300, '2026-05-14T00:00:00.000Z')
    const binding = upsertBinding(projectRoot, 'ABC-2', {
      branch: 'feature/ABC-2-x',
      startedAt: '2026-05-14T00:30:00.000Z'
    })
    expect(binding.cumulativeToken).toBe(300)
    const persisted = readBindings(projectRoot)
    expect(persisted.pending['ABC-2']).toBeUndefined()
  })

  it('appendTokenUsage 命中 binding 时写入 lastReportedAt / lastHookFiredAt 并返回 previousReportedAt', () => {
    upsertBinding(projectRoot, 'ABC-3', {
      branch: 'feature/ABC-3-x',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    const first = appendTokenUsage(
      projectRoot,
      'feature/ABC-3-x',
      'ABC-3',
      100,
      '2026-05-14T00:01:00.000Z'
    )
    expect(first.previousReportedAt).toBeNull()
    expect(first.binding?.lastReportedAt).toBe('2026-05-14T00:01:00.000Z')
    expect(first.binding?.lastHookFiredAt).toBe('2026-05-14T00:01:00.000Z')

    const second = appendTokenUsage(
      projectRoot,
      'feature/ABC-3-x',
      'ABC-3',
      50,
      '2026-05-14T00:03:00.000Z'
    )
    expect(second.previousReportedAt).toBe('2026-05-14T00:01:00.000Z')
    expect(second.binding?.lastReportedAt).toBe('2026-05-14T00:03:00.000Z')
    expect(second.binding?.cumulativeToken).toBe(150)
  })

  it('upsertBinding 持久化 requirementStartedAt 字段(显式传入则使用,缺省回退 startedAt)', () => {
    const explicit = upsertBinding(projectRoot, 'ABC-4', {
      branch: 'feature/ABC-4-x',
      startedAt: '2026-05-14T01:00:00.000Z',
      requirementStartedAt: '2026-05-13T22:00:00.000Z'
    })
    expect(explicit.requirementStartedAt).toBe('2026-05-13T22:00:00.000Z')

    const fallback = upsertBinding(projectRoot, 'ABC-5', {
      branch: 'feature/ABC-5-x',
      startedAt: '2026-05-14T02:00:00.000Z'
    })
    expect(fallback.requirementStartedAt).toBe('2026-05-14T02:00:00.000Z')
  })

  it('appendTokenUsage tokens=0 时不写文件且 previousReportedAt 反映现状', () => {
    upsertBinding(projectRoot, 'ABC-6', {
      branch: 'feature/ABC-6-x',
      startedAt: '2026-05-14T00:00:00.000Z'
    })
    appendTokenUsage(projectRoot, 'feature/ABC-6-x', 'ABC-6', 100, '2026-05-14T00:05:00.000Z')
    const noop = appendTokenUsage(
      projectRoot,
      'feature/ABC-6-x',
      'ABC-6',
      0,
      '2026-05-14T00:10:00.000Z'
    )
    expect(noop.bound).toBe(true)
    expect(noop.previousReportedAt).toBe('2026-05-14T00:05:00.000Z')
    const stored = readBindings(projectRoot)
    expect(stored.bindings['ABC-6'].lastReportedAt).toBe('2026-05-14T00:05:00.000Z')
  })

  describe('v2.12.0 lastReportedAtBySource source 分桶', () => {
    it('不同 source 互不串扰:Cursor 上报不污染 claude-code 桶的 previousReportedAt', () => {
      upsertBinding(projectRoot, 'INSTANT-9000', {
        branch: 'feature/INSTANT-9000',
        startedAt: '2026-05-21T00:00:00.000Z'
      })
      // Cursor 端跑了一轮,桶 cursor-hook 记上时间戳
      const a = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9000',
        'INSTANT-9000',
        200,
        '2026-05-21T00:05:00.000Z',
        'cursor-hook'
      )
      expect(a.previousReportedAt).toBeNull()
      // 5 分钟后 Claude Code 端首轮上报,该桶为空,previousReportedAt 退化到全局 lastReportedAt
      // 但只要后续再来一次 claude-code 上报,桶就建立
      const b = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9000',
        'INSTANT-9000',
        100,
        '2026-05-21T00:10:00.000Z',
        'claude-code'
      )
      expect(b.previousReportedAt).toBe('2026-05-21T00:05:00.000Z')

      // 再过 30 秒 Claude Code 又来一轮:这一次 previousReportedAt 应该取 claude-code 桶
      // 而不是 Cursor 桶,否则跨工具切换会再次串扰
      const c = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9000',
        'INSTANT-9000',
        80,
        '2026-05-21T00:10:30.000Z',
        'claude-code'
      )
      expect(c.previousReportedAt).toBe('2026-05-21T00:10:00.000Z')

      // 同理 Cursor 第二次上报应该取 cursor-hook 桶,不被 Claude Code 干扰
      const d = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9000',
        'INSTANT-9000',
        70,
        '2026-05-21T00:11:00.000Z',
        'cursor-hook'
      )
      expect(d.previousReportedAt).toBe('2026-05-21T00:05:00.000Z')

      const stored = readBindings(projectRoot).bindings['INSTANT-9000']
      expect(stored.lastReportedAtBySource).toEqual({
        'cursor-hook': '2026-05-21T00:11:00.000Z',
        'claude-code': '2026-05-21T00:10:30.000Z'
      })
      // lastReportedAt 全局兜底仍指向最近一次落盘
      expect(stored.lastReportedAt).toBe('2026-05-21T00:11:00.000Z')
    })

    it('source 缺省时落入 default 桶,行为与老版本一致', () => {
      upsertBinding(projectRoot, 'INSTANT-9001', {
        branch: 'feature/INSTANT-9001',
        startedAt: '2026-05-21T00:00:00.000Z'
      })
      const a = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9001',
        'INSTANT-9001',
        100,
        '2026-05-21T00:05:00.000Z'
      )
      expect(a.previousReportedAt).toBeNull()
      const b = appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9001',
        'INSTANT-9001',
        50,
        '2026-05-21T00:06:00.000Z'
      )
      expect(b.previousReportedAt).toBe('2026-05-21T00:05:00.000Z')
      const stored = readBindings(projectRoot).bindings['INSTANT-9001']
      expect(stored.lastReportedAtBySource?.['default']).toBe('2026-05-21T00:06:00.000Z')
    })

    it('老 binding 文件无 lastReportedAtBySource 时 fallback 到全局 lastReportedAt,不会突变成 0', () => {
      // 直接写老格式 bindings.json (没有 lastReportedAtBySource)
      const dir = ensureAipDir(projectRoot)
      writeFileSync(
        join(dir, 'bindings.json'),
        JSON.stringify({
          version: 1,
          bindings: {
            'LEGACY-1': {
              jiraKey: 'LEGACY-1',
              branch: 'feature/LEGACY-1',
              startedAt: '2026-05-20T00:00:00.000Z',
              cumulativeToken: 999,
              lastIterationSeq: 3,
              lastReportedAt: '2026-05-20T05:00:00.000Z'
            }
          },
          pending: {}
        })
      )
      const result = appendTokenUsage(
        projectRoot,
        'feature/LEGACY-1',
        'LEGACY-1',
        50,
        '2026-05-20T05:01:00.000Z',
        'cursor-hook'
      )
      expect(result.previousReportedAt).toBe('2026-05-20T05:00:00.000Z')
      const stored = readBindings(projectRoot).bindings['LEGACY-1']
      expect(stored.lastReportedAtBySource?.['cursor-hook']).toBe('2026-05-20T05:01:00.000Z')
    })

    it('resetBindingForNewInit 清空 lastReportedAtBySource', () => {
      upsertBinding(projectRoot, 'INSTANT-9002', {
        branch: 'feature/INSTANT-9002',
        startedAt: '2026-05-21T00:00:00.000Z'
      })
      appendTokenUsage(
        projectRoot,
        'feature/INSTANT-9002',
        'INSTANT-9002',
        100,
        '2026-05-21T00:05:00.000Z',
        'cursor-hook'
      )
      resetBindingForNewInit(
        projectRoot,
        'INSTANT-9002',
        'feature/INSTANT-9002',
        '2026-05-21T01:00:00.000Z'
      )
      const after = readBindings(projectRoot).bindings['INSTANT-9002']
      expect(after.lastReportedAtBySource).toEqual({})
    })
  })
})

describe('resolveActiveBindingByCwd', () => {
  let gitRoot: string
  let subDir: string

  beforeEach(() => {
    gitRoot = mkdtempSync(join(tmpdir(), 'aip-active-'))
    mkdirSync(join(gitRoot, '.git'), { recursive: true })
    subDir = join(gitRoot, 'apps', 'web')
    mkdirSync(subDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(gitRoot, { recursive: true, force: true })
  })

  it('cwd 为空 / 非字符串时返回 null', () => {
    expect(resolveActiveBindingByCwd('')).toBeNull()
    expect(resolveActiveBindingByCwd('   ')).toBeNull()
    expect(resolveActiveBindingByCwd(undefined as unknown as string)).toBeNull()
  })

  it('cwd 不在 git 仓库内时返回 null', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'aip-active-out-'))
    try {
      expect(resolveActiveBindingByCwd(outsideDir)).toBeNull()
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('git 仓库无 bindings 时返回 null', () => {
    expect(resolveActiveBindingByCwd(gitRoot)).toBeNull()
    expect(resolveActiveBindingByCwd(subDir)).toBeNull()
  })

  it('单条 binding 时直接返回该条', () => {
    upsertBinding(gitRoot, 'INSTANT-5321', {
      branch: 'feature/INSTANT-5321-x',
      startedAt: '2026-05-19T00:00:00.000Z'
    })
    const result = resolveActiveBindingByCwd(subDir)
    expect(result?.jiraKey).toBe('INSTANT-5321')
  })

  it('多条 binding 时按 lastReportedAt → startedAt 取最近一条', () => {
    upsertBinding(gitRoot, 'OLD-1', {
      branch: 'feature/OLD-1-x',
      startedAt: '2026-04-01T00:00:00.000Z'
    })
    upsertBinding(gitRoot, 'OLD-2', {
      branch: 'feature/OLD-2-x',
      startedAt: '2026-04-10T00:00:00.000Z'
    })
    upsertBinding(gitRoot, 'NEW-1', {
      branch: 'feature/NEW-1-x',
      startedAt: '2026-05-19T00:00:00.000Z'
    })
    expect(resolveActiveBindingByCwd(subDir)?.jiraKey).toBe('NEW-1')
  })

  it('lastReportedAt 优先于 startedAt(刚汇报的旧需求胜出)', () => {
    upsertBinding(gitRoot, 'OLD-A', {
      branch: 'feature/OLD-A-x',
      startedAt: '2026-04-01T00:00:00.000Z'
    })
    upsertBinding(gitRoot, 'NEW-B', {
      branch: 'feature/NEW-B-x',
      startedAt: '2026-05-19T00:00:00.000Z'
    })
    // 让旧需求又汇报了一次,lastReportedAt 推到最新
    appendTokenUsage(gitRoot, 'feature/OLD-A-x', 'OLD-A', 10, '2026-05-20T08:00:00.000Z')
    expect(resolveActiveBindingByCwd(subDir)?.jiraKey).toBe('OLD-A')
  })
})
