import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ServerResponse } from 'node:http'

import {
  handleAiProductivityInit,
  handleAiProductivityStatus,
  handleAiProductivityWatcherStatus,
  handleAiProductivityHook,
  handleAiProductivityCursorHookStatus,
  handleAiProductivityInstallCursorHook,
  handleAiProductivityInstallMcpEntry,
  handleAiProductivityListRequirements,
  handleAiProductivityGetRequirement,
  handleAiProductivityPatchRequirement,
  handleAiProductivityPatchSubtask,
  handleAiProductivitySummary,
  handleAiProductivityGetFormula,
  handleAiProductivityPatchFormula,
  handleAiProductivityGetJiraConfig,
  handleAiProductivityPatchJiraConfig,
  handleAiProductivityRefreshBugs,
  handleAiProductivitySyncJiraTitle,
  handleAiProductivityStoragePath,
  handleAiProductivityAttachSummary,
  handleAiProductivityListLessons,
  handleAiProductivityGetLesson,
  handleAiProductivityDeleteLesson,
  handleAiProductivityLessonsBundle,
  handleAiProductivitySaveLessons
} from './ai-productivity.js'
import { upsertBinding, readBindings } from '@ai-productivity-tracker/core'
import {
  aipRoot,
  saveRequirement,
  writeLessons,
  listIterations,
  peekPendingSummary,
  PENDING_SUMMARY_FILE,
  NUMSTAT_SNAPSHOT_FILE,
  LOCAL_AGENT_ROOT_ENV,
  readRecentAttachSentinel,
  recentAttachSentinelPath
} from '@ai-productivity-tracker/core/store'
import type { ServerConfig as ServiceConfig } from '../config.js'

const baseConfig: ServiceConfig = {
  token: 't',
  port: 17350,
  host: '127.0.0.1',
  allowedOrigins: []
}

function makeMockRes() {
  let statusCode = 0
  let body = ''
  const res = {
    writeHead(code: number) {
      statusCode = code
      return res
    },
    end(payload?: string) {
      body = payload ?? ''
    }
  } as unknown as ServerResponse
  return {
    res,
    get statusCode() {
      return statusCode
    },
    get body() {
      return body
    }
  }
}

function makeRepoWithBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aip-route-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: dir }
  )
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: dir })
  return dir
}

function setupAipRoot(): { rootDir: string; restore: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), 'aip-store-root-'))
  const prev = process.env.TRUESIGHT_AIP_ROOT
  process.env.TRUESIGHT_AIP_ROOT = rootDir
  return {
    rootDir,
    restore() {
      if (prev !== undefined) process.env.TRUESIGHT_AIP_ROOT = prev
      else delete process.env.TRUESIGHT_AIP_ROOT
      rmSync(rootDir, { recursive: true, force: true })
    }
  }
}

describe('handleAiProductivityInit', () => {
  let repo: string
  let aipCleanup: () => void

  beforeEach(() => {
    repo = makeRepoWithBranch('feature/ABC-123-route')
    const setup = setupAipRoot()
    aipCleanup = setup.restore
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    aipCleanup()
  })

  it('成功创建需求并写入 bindings + 本地 requirement.json', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInit(mock.res, baseConfig, {
      jiraInput: 'https://yourorg.atlassian.net/browse/ABC-123',
      title: 'New feature',
      projectRoot: repo
    })

    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.jiraKey).toBe('ABC-123')
    expect(body.data.branch).toBe('feature/ABC-123-route')
    expect(body.data.gitRoot).toBe(repo)
    expect(body.data.requirement.title).toBe('New feature')
    expect(body.data.requirement.jiraUrl).toBe('https://yourorg.atlassian.net/browse/ABC-123')

    // requirement.json 已落
    const reqFile = join(aipRoot(), 'ABC-123', 'requirement.json')
    expect(existsSync(reqFile)).toBe(true)
    // bindings 已写
    const bindings = readBindings(repo)
    expect(bindings.bindings['ABC-123']).toBeDefined()
    expect(bindings.bindings['ABC-123'].branch).toBe('feature/ABC-123-route')
    // init iteration 已落
    const iters = listIterations('ABC-123')
    expect(iters.length).toBe(1)
    expect(iters[0].kind).toBe('init')
  })

  it('v2.7.0: init 同步写入 numstat-snapshot 基线,避免首条 coding iteration 把工作区脏文件全部计入', async () => {
    // 在 init 前就把工作区做脏 → 模拟用户切换需求时残留的未提交修改
    writeFileSync(join(repo, 'dirty-existing.txt'), 'this is dirty before init\n')

    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-123',
      title: 'demo',
      projectRoot: repo
    })

    const snapshotFile = join(aipRoot(), 'ABC-123', NUMSTAT_SNAPSHOT_FILE)
    expect(existsSync(snapshotFile)).toBe(true)
    const snap = JSON.parse(readFileSync(snapshotFile, 'utf-8'))
    expect(snap.version).toBe(1)
    expect(typeof snap.baseRef).toBe('string')
    expect(snap.baseRef.length).toBeGreaterThan(0)
    // 注意: untracked 文件 (`dirty-existing.txt`) 不会出现在 `git diff --numstat HEAD` 输出里,
    // 我们只关心 snapshot 真实写入并且字段结构正确 — 这里能拿到 perFile 对象即可
    expect(snap.perFile).toBeDefined()
  })

  it('jiraInput 非法返回 400', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInit(mock.res, baseConfig, {
      jiraInput: 'not a jira',
      title: 'x',
      projectRoot: repo
    })
    expect(mock.statusCode).toBe(400)
  })

  it('分支不含 issueKey 时返回 409', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aip-route2-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: dir }
    )
    try {
      const mock = makeMockRes()
      await handleAiProductivityInit(mock.res, baseConfig, {
        jiraInput: 'ABC-1',
        title: 'x',
        projectRoot: dir
      })
      expect(mock.statusCode).toBe(409)
      expect(JSON.parse(mock.body).message).toMatch(/分支/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('v2.7.2 init reset binding 行为', () => {
    it('已存在脏 binding 时 reset cumulativeToken 与 startedAt / requirementStartedAt 字段', async () => {
      // 预置脏 binding:模拟「上次追踪 INSTANT-5321 残留 895K + startedAt 9 小时前」场景
      const oldStartedAt = '2026-05-20T08:51:35.652Z'
      upsertBinding(repo, 'ABC-123', {
        branch: 'feature/ABC-123-route',
        startedAt: oldStartedAt,
        requirementStartedAt: oldStartedAt
      })
      const bindingsFile = join(repo, '.ai-productivity', 'bindings.json')
      const dirty = JSON.parse(readFileSync(bindingsFile, 'utf-8')) as {
        version: number
        bindings: Record<
          string,
          {
            cumulativeToken: number
            lastIterationSeq: number
            lastReportedAt: string | null
            lastHookFiredAt: string | null
          }
        >
        pending: Record<string, unknown>
      }
      dirty.bindings['ABC-123'].cumulativeToken = 895000
      dirty.bindings['ABC-123'].lastIterationSeq = 12
      dirty.bindings['ABC-123'].lastReportedAt = '2026-05-20T10:00:00.000Z'
      dirty.bindings['ABC-123'].lastHookFiredAt = '2026-05-20T10:00:00.000Z'
      writeFileSync(bindingsFile, JSON.stringify(dirty, null, 2) + '\n', 'utf-8')

      const mock = makeMockRes()
      await handleAiProductivityInit(mock.res, baseConfig, {
        jiraInput: 'ABC-123',
        title: 'reset',
        projectRoot: repo
      })
      expect(mock.statusCode).toBe(200)

      const after = readBindings(repo).bindings['ABC-123']
      expect(after.cumulativeToken).toBe(0)
      expect(after.lastIterationSeq).toBe(0)
      expect(after.lastReportedAt).toBeNull()
      expect(after.lastHookFiredAt).toBeNull()
      // startedAt 与 requirementStartedAt 都被 reset 为 init 时刻的 now (不再是 oldStartedAt)
      expect(after.startedAt).not.toBe(oldStartedAt)
      expect(after.requirementStartedAt).not.toBe(oldStartedAt)
      // requirementStartedAt 字段以 saveRequirement 写入的 requirement.startedAt 为准
      // 但绝不是脏的 oldStartedAt
      expect(new Date(after.startedAt).getTime()).toBeGreaterThan(new Date(oldStartedAt).getTime())
    })

    it('已存在 pending[jiraKey] 时 init 强制清空 pending,不被 upsertBinding 吸收回来', async () => {
      // 模拟用户分支虽然带 issueKey 但还没 init,先攒了一段 pending token
      const file = join(repo, '.ai-productivity', 'bindings.json')
      mkdirSync(join(repo, '.ai-productivity'), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify(
          {
            version: 1,
            bindings: {},
            pending: {
              'ABC-123': {
                branch: 'feature/ABC-123-route',
                firstSeenAt: '2026-05-20T08:00:00.000Z',
                cumulativeToken: 50000
              }
            }
          },
          null,
          2
        ) + '\n',
        'utf-8'
      )

      const mock = makeMockRes()
      await handleAiProductivityInit(mock.res, baseConfig, {
        jiraInput: 'ABC-123',
        title: 'pending',
        projectRoot: repo
      })
      expect(mock.statusCode).toBe(200)

      const after = readBindings(repo)
      // pending 必须被清空
      expect(after.pending['ABC-123']).toBeUndefined()
      // 新建 binding 从 0 开始,不应继承 50000 pending
      expect(after.bindings['ABC-123'].cumulativeToken).toBe(0)
    })
  })
})

describe('handleAiProductivityStatus', () => {
  let repo: string
  beforeEach(() => {
    repo = makeRepoWithBranch('feature/ABC-999-status')
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('未绑定时返回 bound=false', () => {
    const mock = makeMockRes()
    handleAiProductivityStatus(mock.res, baseConfig, { projectRoot: repo })
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.bound).toBe(false)
    expect(body.data.branch).toBe('feature/ABC-999-status')
    expect(body.data.issueKey).toBe('ABC-999')
  })
})

describe('handleAiProductivityHook', () => {
  let repo: string
  let dedupePath: string
  let aipCleanup: () => void

  beforeEach(() => {
    repo = makeRepoWithBranch('feature/INSTANT-501-hook')
    dedupePath = join(mkdtempSync(join(tmpdir(), 'aip-hook-dedupe-')), 'hook-dedupe.json')
    const setup = setupAipRoot()
    aipCleanup = setup.restore
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    aipCleanup()
  })

  it('命中 binding 时累加 cumulativeToken 并写本地 iteration', async () => {
    upsertBinding(repo, 'INSTANT-501', {
      branch: 'feature/INSTANT-501-hook',
      startedAt: '2026-05-15T00:00:00.000Z'
    })
    // 先 init 一个 requirement,确保 iteration 能落
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'INSTANT-501',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 1500,
        source: 'cursor-hook',
        dedupeKey: 'conv-1#gen-1',
        rawHookPayload: { model: 'claude-opus-4-7', cache_read_tokens: 1000 }
      },
      { dedupePath }
    )

    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.code).toBe('OK')
    expect(body.data.bound).toBe(true)
    expect(body.data.deduped).toBe(false)
    expect(body.data.accumulated).toBe(1500)
    expect(body.data.cumulativeToken).toBe(1500)
    expect(body.data.jiraKey).toBe('INSTANT-501')
    expect(body.data.iterationSeq).toBeGreaterThan(0)

    const iters = listIterations('INSTANT-501')
    const codingIter = iters.find((it) => it.kind === 'coding')
    expect(codingIter).toBeDefined()
    expect(codingIter?.cumulativeToken).toBe(1500)
    expect(codingIter?.modelName).toBe('claude-opus-4-7')

    const persisted = readBindings(repo)
    expect(persisted.bindings['INSTANT-501'].cumulativeToken).toBe(1500)

    const dedupe = JSON.parse(readFileSync(dedupePath, 'utf-8'))
    expect(dedupe.keys.map((e: { key: string }) => e.key)).toContain('conv-1#gen-1')
  })

  it('未命中 binding 时累 pending,不落 iteration', async () => {
    const mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 800,
        source: 'cursor-hook',
        dedupeKey: 'conv-2#gen-1'
      },
      { dedupePath }
    )

    const body = JSON.parse(mock.body)
    expect(body.data.bound).toBe(false)
    expect(body.data.accumulated).toBe(800)
    expect(body.data.cumulativeToken).toBeUndefined()
    expect(existsSync(join(aipRoot(), 'INSTANT-501', 'iterations.jsonl'))).toBe(false)
    const persisted = readBindings(repo)
    expect(persisted.pending['INSTANT-501']?.cumulativeToken).toBe(800)
  })

  it('dedupeKey 重复命中时跳过累加', async () => {
    upsertBinding(repo, 'INSTANT-501', {
      branch: 'feature/INSTANT-501-hook',
      startedAt: '2026-05-15T00:00:00.000Z'
    })
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'INSTANT-501',
      title: 'demo',
      projectRoot: repo
    })

    let mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 500,
        source: 'cursor-hook',
        dedupeKey: 'conv-3#gen-1'
      },
      { dedupePath }
    )
    expect(JSON.parse(mock.body).data.accumulated).toBe(500)

    mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 999,
        source: 'cursor-hook',
        dedupeKey: 'conv-3#gen-1'
      },
      { dedupePath }
    )
    const body = JSON.parse(mock.body)
    expect(body.data.deduped).toBe(true)
    expect(body.data.accumulated).toBe(0)

    const persisted = readBindings(repo)
    expect(persisted.bindings['INSTANT-501'].cumulativeToken).toBe(500)
  })

  it('tokens<=0 时直接返回 ok 不累加,不写 dedupe', async () => {
    const mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 0,
        source: 'cursor-hook',
        dedupeKey: 'conv-4#gen-1'
      },
      { dedupePath }
    )
    const body = JSON.parse(mock.body)
    expect(body.data.deduped).toBe(false)
    expect(body.data.accumulated).toBe(0)
    expect(body.data.reason).toContain('tokens=0')
    expect(readBindings(repo).bindings['INSTANT-501']).toBeUndefined()
  })

  it('payload.tokens 非法时返回 400', async () => {
    const mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        tokens: NaN,
        source: 'cursor-hook'
      } as never,
      { dedupePath }
    )
    expect(mock.statusCode).toBe(400)
  })

  it('iteration payload 含 elapsedMinutes / thinkSeconds / cumulativeDiff + 本次对话 diff / modelName', async () => {
    // v2.7.2: handleAiProductivityInit 会先 resetBindingForNewInit 把 startedAt 改成 init 时刻 now,
    // 因此需要先 init 再手动回拨 startedAt / requirementStartedAt 到 1 小时前,模拟「init 已过 1h 再发 hook」场景
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'INSTANT-501',
      title: 'demo',
      projectRoot: repo
    })
    const bindingsFile = join(repo, '.ai-productivity', 'bindings.json')
    const stored = JSON.parse(readFileSync(bindingsFile, 'utf-8')) as {
      version: number
      bindings: Record<string, { startedAt: string; requirementStartedAt?: string }>
      pending: Record<string, unknown>
    }
    stored.bindings['INSTANT-501'].startedAt = '2026-05-15T00:00:00.000Z'
    stored.bindings['INSTANT-501'].requirementStartedAt = '2026-05-15T00:00:00.000Z'
    writeFileSync(bindingsFile, JSON.stringify(stored, null, 2) + '\n', 'utf-8')

    const mock = makeMockRes()
    await handleAiProductivityHook(
      mock.res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 2000,
        source: 'cursor-hook',
        dedupeKey: 'conv-x#gen-1',
        rawHookPayload: { model: 'claude-opus-4-7' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-15T01:00:00.000Z'),
        collectDiff: () => ({
          files: 3,
          insertions: 42,
          deletions: 7,
          changedFiles: [
            { path: 'apps/web/foo.ts', status: 'M' },
            { path: 'packages/db/bar.ts', status: 'A' }
          ],
          truncated: false
        }),
        collectNumstatFn: () =>
          new Map([
            ['apps/web/foo.ts', { insertions: 35, deletions: 5 }],
            ['packages/db/bar.ts', { insertions: 7, deletions: 2 }]
          ])
      }
    )

    expect(mock.statusCode).toBe(200)
    const iters = listIterations('INSTANT-501')
    const last = iters[iters.length - 1]
    expect(last.elapsedMinutes).toBe(60)
    expect(last.thinkSeconds).toBe(0)
    // 总变更 = collectDiff 返回的累计统计
    expect(last.cumulativeDiffFiles).toBe(3)
    expect(last.cumulativeDiffInsertions).toBe(42)
    expect(last.cumulativeDiffDeletions).toBe(7)
    expect(last.cumulativeChangedFiles).toEqual([
      { path: 'apps/web/foo.ts', status: 'M' },
      { path: 'packages/db/bar.ts', status: 'A' }
    ])
    // 首轮 iteration 没有 prev snapshot, 本次对话变更 = 当前 numstat 全量
    expect(last.diffFiles).toBe(2)
    expect(last.diffInsertions).toBe(42) // 35 + 7
    expect(last.diffDeletions).toBe(7) // 5 + 2
    expect(last.modelName).toBe('claude-opus-4-7')
  })

  it('v2.12.0 Cursor hook 两次间隔 120s 时 thinkSeconds cap 到 60s(避免用户阅读/输入时间被算成 AI 思考)', async () => {
    // beforeEach 起的 repo 分支已经是 feature/INSTANT-501-hook,init 同 jiraKey 即可绑定
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'INSTANT-501',
      title: 'cursor cap',
      projectRoot: repo
    })

    // 第一次 Cursor hook 上报,模拟 ts = 00:00:00
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 100,
        source: 'cursor-hook',
        dedupeKey: 'conv-cap#gen-1',
        rawHookPayload: { model: 'claude-3-5-sonnet' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-21T00:00:00.000Z'),
        collectDiff: () => ({
          files: 0,
          insertions: 0,
          deletions: 0,
          changedFiles: [],
          truncated: false
        }),
        collectNumstatFn: () => new Map()
      }
    )

    // 第二次 Cursor hook,间隔 120s。旧逻辑会算 120s,新逻辑应被 cap 到 60s
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 80,
        source: 'cursor-hook',
        dedupeKey: 'conv-cap#gen-2',
        rawHookPayload: { model: 'claude-3-5-sonnet' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-21T00:02:00.000Z'),
        collectDiff: () => ({
          files: 0,
          insertions: 0,
          deletions: 0,
          changedFiles: [],
          truncated: false
        }),
        collectNumstatFn: () => new Map()
      }
    )

    const iters = listIterations('INSTANT-501').filter((it) => it.kind === 'coding')
    const last = iters[iters.length - 1]
    expect(last.thinkSeconds).toBe(60)
    // mapHookSource: 'cursor-hook' → 'cursor'
    expect(last.source).toBe('cursor')
  })

  it('v2.12.0 source 分桶:Cursor 写入后 Claude Code 上报取 claude-code 桶,不被 Cursor 串扰', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'INSTANT-501',
      title: 'cross tool',
      projectRoot: repo
    })

    // Cursor 上报一次(ts = 00:00:00)
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 100,
        source: 'cursor-hook',
        dedupeKey: 'cross#gen-1',
        rawHookPayload: { model: 'claude-3-5-sonnet' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-21T00:00:00.000Z'),
        collectDiff: () => ({
          files: 0,
          insertions: 0,
          deletions: 0,
          changedFiles: [],
          truncated: false
        }),
        collectNumstatFn: () => new Map()
      }
    )

    // Claude hook 在 30s 后上报。如果共用 lastReportedAt,Claude Code 这一轮 thinkSeconds=30。
    // 但 Claude Code 桶为空,首次落桶 → previousReportedAt 回退到全局 lastReportedAt
    // = Cursor 的 00:00:00,thinkSeconds=30。
    // 第二次 Claude hook 时桶建立,previousReportedAt 应取 Claude 自己的桶,不被 Cursor 干扰。
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 80,
        source: 'claude-hook',
        dedupeKey: 'cross#gen-2',
        rawHookPayload: { model: 'claude-opus-4-7' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-21T00:00:30.000Z'),
        collectDiff: () => ({
          files: 0,
          insertions: 0,
          deletions: 0,
          changedFiles: [],
          truncated: false
        }),
        collectNumstatFn: () => new Map()
      }
    )

    // 此时再让 Cursor 在 1 分钟后上报 → 应该相对于 Cursor 桶 00:00:00 算,即 60s,
    // cap 后还是 60s;若没有分桶会从 Claude 的 00:00:30 算成 30s,数字明显错位。
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/INSTANT-501-hook',
        tokens: 50,
        source: 'cursor-hook',
        dedupeKey: 'cross#gen-3',
        rawHookPayload: { model: 'claude-3-5-sonnet' }
      },
      {
        dedupePath,
        nowFn: () => new Date('2026-05-21T00:01:00.000Z'),
        collectDiff: () => ({
          files: 0,
          insertions: 0,
          deletions: 0,
          changedFiles: [],
          truncated: false
        }),
        collectNumstatFn: () => new Map()
      }
    )

    const codingIters = listIterations('INSTANT-501').filter((it) => it.kind === 'coding')
    expect(codingIters.length).toBe(3)
    // mapHookSource 归一化:'cursor-hook' → 'cursor'、'claude-hook' → 'claude-code'
    expect(codingIters[0].source).toBe('cursor')
    expect(codingIters[1].source).toBe('claude-code')
    expect(codingIters[2].source).toBe('cursor')
    // 第三轮(Cursor)thinkSeconds 取 cursor 桶 → 60s 真实差值 → cap 后还是 60s
    expect(codingIters[2].thinkSeconds).toBe(60)
  })
})

describe('Panel handlers', () => {
  let repo: string
  let aipCleanup: () => void

  beforeEach(() => {
    repo = makeRepoWithBranch('feature/PANEL-1-test')
    const setup = setupAipRoot()
    aipCleanup = setup.restore
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    aipCleanup()
  })

  it('list / get / patch requirement 闭环', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'orig title',
      projectRoot: repo,
      manualEstimateMinutes: 60
    })

    let mock = makeMockRes()
    handleAiProductivityListRequirements(mock.res, {})
    let body = JSON.parse(mock.body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].jiraKey).toBe('PANEL-1')

    mock = makeMockRes()
    handleAiProductivityGetRequirement(mock.res, 'PANEL-1')
    body = JSON.parse(mock.body)
    expect(body.data.title).toBe('orig title')
    expect(body.data.iterations.length).toBe(1)

    mock = makeMockRes()
    handleAiProductivityPatchRequirement(mock.res, 'PANEL-1', { status: 'finished', title: 'next' })
    body = JSON.parse(mock.body)
    expect(body.data.status).toBe('finished')

    mock = makeMockRes()
    handleAiProductivityGetRequirement(mock.res, 'PANEL-1')
    body = JSON.parse(mock.body)
    expect(body.data.title).toBe('next')
    expect(body.data.status).toBe('finished')
  })

  it('patch subtask 记录 event 并切换 done 状态', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo,
      subtasks: [{ id: 'st-1', title: 'foo', weight: 2 }]
    })

    const mock = makeMockRes()
    handleAiProductivityPatchSubtask(mock.res, 'PANEL-1', 'st-1', { done: true, source: 'manual' })
    const body = JSON.parse(mock.body)
    expect(body.data.subtasks[0].done).toBe(true)
    expect(body.data.subtasks[0].doneAt).toBeTruthy()
  })

  it('summary 汇总当前所有需求', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    const mock = makeMockRes()
    handleAiProductivitySummary(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.totalRequirements).toBe(1)
  })

  it('formula get/patch', () => {
    let mock = makeMockRes()
    handleAiProductivityGetFormula(mock.res)
    let body = JSON.parse(mock.body)
    expect(body.data.kBug).toBeGreaterThan(0)

    mock = makeMockRes()
    handleAiProductivityPatchFormula(mock.res, { kBug: 0.3 })
    body = JSON.parse(mock.body)
    expect(body.data.kBug).toBe(0.3)

    mock = makeMockRes()
    handleAiProductivityGetFormula(mock.res)
    body = JSON.parse(mock.body)
    expect(body.data.kBug).toBe(0.3)
  })

  it('jira-config get/patch', () => {
    let mock = makeMockRes()
    handleAiProductivityGetJiraConfig(mock.res)
    let body = JSON.parse(mock.body)
    expect(body.data.configured).toBe(false)

    mock = makeMockRes()
    handleAiProductivityPatchJiraConfig(mock.res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })
    body = JSON.parse(mock.body)
    expect(body.data.configured).toBe(true)
    expect(body.data.baseUrl).toBe('https://x.atlassian.net')
  })

  it('refresh-bugs 未配置 Jira 时返回 400', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    const mock = makeMockRes()
    await handleAiProductivityRefreshBugs(mock.res, 'PANEL-1', {}, { fetchImpl: fetch })
    expect(mock.statusCode).toBe(400)
  })

  it('refresh-bugs 调用 Jira 并更新 linkedBugCount', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    // v2.15.2 三层兜底:body 空 + requirement.linkedBugJql='' + 仅有 bugJqlTemplate 时必须能落到 template
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk',
      bugJqlTemplate: 'issuetype = Bug AND "Epic Link" = {{jiraKey}}'
    })

    // v2.15.1 起 Atlassian 用 approximate-count,响应 `{ count }`
    const fakeFetch = async () =>
      new Response(JSON.stringify({ count: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

    const mock = makeMockRes()
    await handleAiProductivityRefreshBugs(
      mock.res,
      'PANEL-1',
      {},
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    )
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.linkedBugCount).toBe(3)
    // v2.15.2:linkedBugJql 应被渲染 + bounded 兜底,落盘后续 ?? 短路也安全
    expect(body.data.linkedBugJql).toBe(
      'issuetype = Bug AND "Epic Link" = PANEL-1 AND project = PANEL'
    )
  })

  // v2.15.2:三层兜底链路 + Atlassian bounded 自动追加
  it('refresh-bugs body 与 requirement 均无 jql 时回退到 bugJqlTemplate 并自动追加 project', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk',
      bugJqlTemplate: 'issuetype = Bug AND "Epic Link" = {{jiraKey}}'
    })

    let observedBody: { jql?: string } | null = null
    const fakeFetch = async (_url: URL | string, init?: RequestInit) => {
      observedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      return new Response(JSON.stringify({ count: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const mock = makeMockRes()
    await handleAiProductivityRefreshBugs(
      mock.res,
      'PANEL-1',
      {},
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    )
    expect(mock.statusCode).toBe(200)
    expect(observedBody?.jql).toBe('issuetype = Bug AND "Epic Link" = PANEL-1 AND project = PANEL')
  })

  // 注意:store 层有 DEFAULT_BUG_JQL_TEMPLATE,生产里 config.bugJqlTemplate 几乎不会真的为空,
  // 这条用例显式把 bugJqlTemplate 清成 '' 来覆盖防御分支(用户手抠空模板)。
  it('refresh-bugs 三层兜底全空时返回 400 友好引导', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk',
      bugJqlTemplate: ''
    })

    let fetched = false
    const fakeFetch = async () => {
      fetched = true
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const mock = makeMockRes()
    await handleAiProductivityRefreshBugs(
      mock.res,
      'PANEL-1',
      {},
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    )
    expect(mock.statusCode).toBe(400)
    expect(JSON.parse(mock.body).message).toMatch(/Jira Bug JQL 模板未配置/)
    expect(fetched).toBe(false)
  })

  it('refresh-bugs body.jql 显式传入时优先使用 + bounded 兜底', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 't',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk',
      bugJqlTemplate: 'issuetype = Bug AND "Epic Link" = {{jiraKey}}'
    })

    let observedBody: { jql?: string } | null = null
    const fakeFetch = async (_url: URL | string, init?: RequestInit) => {
      observedBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      return new Response(JSON.stringify({ count: 8 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const mock = makeMockRes()
    await handleAiProductivityRefreshBugs(
      mock.res,
      'PANEL-1',
      { jql: 'issuetype = Bug AND fixVersion = "v1.0"' },
      { fetchImpl: fakeFetch as unknown as typeof fetch }
    )
    expect(mock.statusCode).toBe(200)
    // body.jql 渲染后(无 {{jiraKey}} 占位符) + 没含 bounded 字段 → 自动追加 AND project = PANEL
    expect(observedBody?.jql).toBe('issuetype = Bug AND fixVersion = "v1.0" AND project = PANEL')
  })

  it('storage-path 返回根目录', () => {
    const mock = makeMockRes()
    handleAiProductivityStoragePath(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.root).toBe(aipRoot())
  })

  // v2.14.0 sync-jira-title:用 agent 已存 Jira 凭证拉真实 summary 写回 title
  it('sync-jira-title 需求不存在时返回 404', async () => {
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'NOPE-9999')
    expect(mock.statusCode).toBe(404)
  })

  it('sync-jira-title 未配置 Jira 凭证时返回 422', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1')
    expect(mock.statusCode).toBe(422)
    expect(JSON.parse(mock.body).message).toMatch(/尚未配置 Jira 凭证/)
  })

  it('sync-jira-title 拉到 summary 时写回 title 并同步 index.json', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })

    const fakeFetch = async () =>
      new Response(
        JSON.stringify({ key: 'PANEL-1', fields: { summary: '【面板】真实标题示例' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )

    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', {
      fetchImpl: fakeFetch as unknown as typeof fetch
    })
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.title).toBe('【面板】真实标题示例')
    expect(body.data.source).toBe('jira')

    // 验证 list 读到的 title 也已更新(确认 index/store 已同步)
    const listMock = makeMockRes()
    handleAiProductivityListRequirements(listMock.res, {})
    const list = JSON.parse(listMock.body).data
    const target = list.find((r: { jiraKey: string }) => r.jiraKey === 'PANEL-1')
    expect(target?.title).toBe('【面板】真实标题示例')
  })

  // v2.14.2 sync-jira-title 按 inspectJiraIssueSummary 的 reason 输出细分 status & 文案
  it('sync-jira-title Jira 返回 404 时返回 404 + issue 未找到文案', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })
    const fakeFetch = async () => new Response('not found', { status: 404 })
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', {
      fetchImpl: fakeFetch as unknown as typeof fetch
    })
    expect(mock.statusCode).toBe(404)
    expect(JSON.parse(mock.body).message).toMatch(/Jira 上未找到 PANEL-1/)
  })

  it('sync-jira-title Jira 返回 401 时返回 401 + 鉴权失败文案', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })
    const fakeFetch = async () => new Response('unauthorized', { status: 401 })
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', {
      fetchImpl: fakeFetch as unknown as typeof fetch
    })
    expect(mock.statusCode).toBe(401)
    expect(JSON.parse(mock.body).message).toMatch(/鉴权失败/)
  })

  it('sync-jira-title Jira 返回 403 时返回 403 + 无权访问文案', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })
    const fakeFetch = async () => new Response('forbidden', { status: 403 })
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', {
      fetchImpl: fakeFetch as unknown as typeof fetch
    })
    expect(mock.statusCode).toBe(403)
    expect(JSON.parse(mock.body).message).toMatch(/无权访问 PANEL-1/)
  })

  it('sync-jira-title baseUrl 缺协议但被 normalize 时能正常拉到 summary', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    // 直接落盘"裸域名",PATCH 在 normalizeJiraBaseUrl 后自动补 https://
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'tssoft.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })

    let observedUrl = ''
    const fakeFetch = (async (url: URL | string) => {
      observedUrl = url instanceof URL ? url.toString() : String(url)
      return new Response(JSON.stringify({ key: 'PANEL-1', fields: { summary: '真实标题' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', { fetchImpl: fakeFetch })
    expect(mock.statusCode).toBe(200)
    expect(observedUrl.startsWith('https://tssoft.atlassian.net/rest/api/3/issue/PANEL-1')).toBe(
      true
    )
    expect(JSON.parse(mock.body).data.title).toBe('真实标题')
  })

  it('sync-jira-title 网络抛错时返回 502 + 网络异常文案', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'PANEL-1',
      title: 'PANEL-1',
      projectRoot: repo
    })
    handleAiProductivityPatchJiraConfig(makeMockRes().res, {
      baseUrl: 'https://x.atlassian.net',
      apiEmail: 'a@b.com',
      apiToken: 'tk'
    })
    const fakeFetch = async () => {
      throw new Error('ENOTFOUND')
    }
    const mock = makeMockRes()
    await handleAiProductivitySyncJiraTitle(mock.res, 'PANEL-1', {
      fetchImpl: fakeFetch as unknown as typeof fetch
    })
    expect(mock.statusCode).toBe(502)
    expect(JSON.parse(mock.body).message).toMatch(/Jira 网络异常/)
  })
})

describe('handleAiProductivityInstallCursorHook', () => {
  let tmpDir: string
  let hooksPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aip-install-cursor-'))
    hooksPath = join(tmpDir, 'hooks.json')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('MCP .mjs 入口不存在时返回 412,并提示用户去使用说明下载', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInstallCursorHook(
      mock.res,
      { debug: false },
      { hookEntryPath: join(tmpDir, 'nonexistent.mjs'), hooksPath }
    )
    expect(mock.statusCode).toBe(412)
    expect(JSON.parse(mock.body).message).toMatch(/MCP 入口/)
  })

  it('MCP 入口存在时,直接写 hooks.json,命令字符串包含 `node <abs-mjs> hook` + marker', async () => {
    const entryPath = join(tmpDir, 'ai-productivity-mcp.mjs')
    writeFileSync(entryPath, '#!/usr/bin/env node\n')
    const mock = makeMockRes()
    await handleAiProductivityInstallCursorHook(
      mock.res,
      { debug: false },
      { hookEntryPath: entryPath, hooksPath }
    )
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.ok).toBe(true)
    expect(body.data.hookEntryPath).toBe(entryPath)
    expect(body.data.cliPath).toBe(entryPath)
    expect(body.data.finalCommand).toBe(`node ${entryPath} hook # ai-productivity-hook`)
    expect(body.data.replaced).toBe(false)
    expect(body.data.previousCommand).toBeNull()

    const written = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(written.hooks.afterAgentResponse[0].command).toBe(
      `node ${entryPath} hook # ai-productivity-hook`
    )
  })

  it('debug 模式前置 AI_PRODUCTIVITY_DEBUG_HOOK=1', async () => {
    const entryPath = join(tmpDir, 'ai-productivity-mcp.mjs')
    writeFileSync(entryPath, '#!/usr/bin/env node\n')
    const mock = makeMockRes()
    await handleAiProductivityInstallCursorHook(
      mock.res,
      { debug: true },
      { hookEntryPath: entryPath, hooksPath }
    )
    const body = JSON.parse(mock.body)
    expect(body.data.finalCommand).toBe(
      `AI_PRODUCTIVITY_DEBUG_HOOK=1 node ${entryPath} hook # ai-productivity-hook`
    )
  })

  it('hooks.json 已存在老 CLI marker 条目时,会就地覆盖并返回 previousCommand', async () => {
    const legacy = '/Users/old/.local/bin/ai-productivity hook # ai-productivity-hook'
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: { afterAgentResponse: [{ command: legacy }] }
      })
    )
    const entryPath = join(tmpDir, 'ai-productivity-mcp.mjs')
    writeFileSync(entryPath, '#!/usr/bin/env node\n')
    const mock = makeMockRes()
    await handleAiProductivityInstallCursorHook(
      mock.res,
      { debug: false },
      { hookEntryPath: entryPath, hooksPath }
    )
    const body = JSON.parse(mock.body)
    expect(body.data.replaced).toBe(true)
    expect(body.data.previousCommand).toBe(legacy)
    const written = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(written.hooks.afterAgentResponse).toHaveLength(1)
    expect(written.hooks.afterAgentResponse[0].command).toBe(
      `node ${entryPath} hook # ai-productivity-hook`
    )
  })
})

describe('handleAiProductivityInstallMcpEntry', () => {
  let tmpDir: string
  let targetPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aip-install-mcp-'))
    targetPath = join(tmpDir, 'sub', 'ai-productivity-mcp.mjs')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function validMjsBase64(): string {
    const content = '#!/usr/bin/env node\n// ai-productivity-mcp entry\nconsole.log("ok")\n'
    return Buffer.from(content, 'utf8').toString('base64')
  }

  it('缺 contentBase64 返回 400', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(mock.res, {}, { targetPath })
    expect(mock.statusCode).toBe(400)
    expect(JSON.parse(mock.body).message).toMatch(/contentBase64/)
  })

  it('解码后为空返回 400', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(mock.res, { contentBase64: '' }, { targetPath })
    expect(mock.statusCode).toBe(400)
  })

  it('体积超 2MB 返回 413', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(
      mock.res,
      { contentBase64: big.toString('base64') },
      { targetPath }
    )
    expect(mock.statusCode).toBe(413)
  })

  it('sanity check 不命中返回 400', async () => {
    const garbage = Buffer.from('hello world this is not a mcp entry file', 'utf8')
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(
      mock.res,
      { contentBase64: garbage.toString('base64') },
      { targetPath }
    )
    expect(mock.statusCode).toBe(400)
    expect(JSON.parse(mock.body).message).toMatch(/不像/)
  })

  it('合法 mjs 写入成功,返回 replaced=false 与字节数', async () => {
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(
      mock.res,
      { contentBase64: validMjsBase64() },
      { targetPath }
    )
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.ok).toBe(true)
    expect(body.data.path).toBe(targetPath)
    expect(body.data.replaced).toBe(false)
    expect(body.data.bytesWritten).toBeGreaterThan(0)
    expect(existsSync(targetPath)).toBe(true)
    const written = readFileSync(targetPath, 'utf8')
    expect(written).toMatch(/ai-productivity-mcp/)
  })

  it('已存在时返回 replaced=true,内容被覆盖', async () => {
    mkdirSync(join(tmpDir, 'sub'), { recursive: true })
    writeFileSync(targetPath, 'old content\n')
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(
      mock.res,
      { contentBase64: validMjsBase64() },
      { targetPath }
    )
    expect(mock.statusCode).toBe(200)
    expect(JSON.parse(mock.body).data.replaced).toBe(true)
    const written = readFileSync(targetPath, 'utf8')
    expect(written).not.toMatch(/old content/)
    expect(written).toMatch(/ai-productivity-mcp/)
  })

  // v2.9.2 回归:esbuild bundle 产物头部 2KB 全是 helper 噪音,签名词被推到中段,
  // sanity check 必须做全文搜索而不是只看头部,否则 Step 3「重新下载并覆盖」永远 400。
  it('签名词只出现在 buf 中段时仍 200(全文 sanity)', async () => {
    const helperNoise =
      '#!/usr/bin/env node\n' + 'var __defProp = Object.defineProperty;\n'.repeat(200)
    expect(helperNoise.length).toBeGreaterThan(4096)
    const tail = '\n// modelcontextprotocol stdio entry: ai-productivity-mcp\nconsole.log("ok")\n'
    const content = helperNoise + tail
    const head = Buffer.from(content, 'utf8').subarray(0, 2048).toString('utf8')
    expect(head).not.toMatch(/ai-productivity-mcp|modelcontextprotocol/)
    const mock = makeMockRes()
    await handleAiProductivityInstallMcpEntry(
      mock.res,
      { contentBase64: Buffer.from(content, 'utf8').toString('base64') },
      { targetPath }
    )
    expect(mock.statusCode).toBe(200)
    expect(JSON.parse(mock.body).data.ok).toBe(true)
  })
})

describe('handleAiProductivityCursorHookStatus', () => {
  let tmpHome: string
  const origHome = process.env.HOME

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aip-fakehome-'))
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    process.env.HOME = origHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('hooks.json 不存在 + .mjs 不存在时全为 false,并暴露 hookEntryPath / 兼容 cliInstalled / hookEntryVersion=null', () => {
    const mock = makeMockRes()
    handleAiProductivityCursorHookStatus(mock.res)
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.hookEntryInstalled).toBe(false)
    expect(body.data.cliInstalled).toBe(false)
    expect(body.data.hookEntryPath).toContain('Downloads/ai-productivity-mcp.mjs')
    expect(body.data.cliPath).toBe(body.data.hookEntryPath)
    expect(body.data.hooksFileExists).toBe(false)
    expect(body.data.hookInstalled).toBe(false)
    expect(body.data.legacyHookDetected).toBe(false)
    expect(body.data.hookEntryVersion).toBeNull()
  })

  it('v2.13.0:.mjs 含 banner marker 时解析出版本号', () => {
    const downloadsDir = join(tmpHome, 'Downloads')
    mkdirSync(downloadsDir, { recursive: true })
    writeFileSync(
      join(downloadsDir, 'ai-productivity-mcp.mjs'),
      '#!/usr/bin/env node\n// ai-productivity-mcp · truesight bundled entry\n// __AI_PRODUCTIVITY_MCP_VERSION__: 0.1.12\nconsole.log("...")\n'
    )
    const mock = makeMockRes()
    handleAiProductivityCursorHookStatus(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.hookEntryInstalled).toBe(true)
    expect(body.data.hookEntryVersion).toBe('0.1.12')
  })

  it('v2.13.0:.mjs 存在但无 banner marker(老版本) → hookEntryVersion=null', () => {
    const downloadsDir = join(tmpHome, 'Downloads')
    mkdirSync(downloadsDir, { recursive: true })
    writeFileSync(
      join(downloadsDir, 'ai-productivity-mcp.mjs'),
      '#!/usr/bin/env node\n// old v2.10.x bundle without marker\nconsole.log("...")\n'
    )
    const mock = makeMockRes()
    handleAiProductivityCursorHookStatus(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.hookEntryInstalled).toBe(true)
    expect(body.data.hookEntryVersion).toBeNull()
  })

  it('hooks.json 含 ai-productivity-hook marker 时识别为已安装,且能识别 debug 前缀', () => {
    const cursorDir = join(tmpHome, '.cursor')
    mkdirSync(cursorDir, { recursive: true })
    writeFileSync(
      join(cursorDir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [
            {
              command:
                'AI_PRODUCTIVITY_DEBUG_HOOK=1 /usr/bin/node /opt/cli.mjs hook # ai-productivity-hook'
            }
          ]
        }
      })
    )
    const mock = makeMockRes()
    handleAiProductivityCursorHookStatus(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.hooksFileExists).toBe(true)
    expect(body.data.hookInstalled).toBe(true)
    expect(body.data.debugMode).toBe(true)
    expect(body.data.hookCommand).toContain('# ai-productivity-hook')
    expect(body.data.legacyHookDetected).toBe(false)
  })

  it('hooks.json 仍写老 CLI 路径 ~/.local/bin/ai-productivity 时 legacyHookDetected=true', () => {
    const cursorDir = join(tmpHome, '.cursor')
    mkdirSync(cursorDir, { recursive: true })
    const legacyHomeCli = join(tmpHome, '.local', 'bin', 'ai-productivity')
    writeFileSync(
      join(cursorDir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: `${legacyHomeCli} hook # ai-productivity-hook` }]
        }
      })
    )
    const mock = makeMockRes()
    handleAiProductivityCursorHookStatus(mock.res)
    const body = JSON.parse(mock.body)
    expect(body.data.hookInstalled).toBe(true)
    expect(body.data.legacyHookDetected).toBe(true)
  })
})

describe('handleAiProductivityWatcherStatus', () => {
  it('返回 watcher 状态结构', () => {
    const status = {
      running: true,
      claudeProjectsDir: '/Users/x/.claude/projects',
      trackedFiles: 3,
      startedAt: '2026-05-14T07:00:00.000Z'
    }
    const mock = makeMockRes()
    handleAiProductivityWatcherStatus(mock.res, baseConfig, () => status)
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data).toEqual(status)
  })
})

// v2.7.0: attach-summary 改写为 pending consume 模型
// v2.10.0: 同步落 jiraKey 维度 sentinel
describe('handleAiProductivityAttachSummary (v2.7.0 pending model + v2.10.0 sentinel)', () => {
  let repo: string
  let aipCleanup: () => void
  let agentRoot: string
  let prevLocalAgentRoot: string | undefined

  beforeEach(() => {
    repo = makeRepoWithBranch('feature/ABC-700-attach')
    const setup = setupAipRoot()
    aipCleanup = setup.restore
    // v2.10.0:agent store 默认根读 TRUESIGHT_LOCAL_AGENT_ROOT,把 sentinel 隔离到 tmp
    agentRoot = mkdtempSync(join(tmpdir(), 'aip-agent-attach-'))
    prevLocalAgentRoot = process.env[LOCAL_AGENT_ROOT_ENV]
    process.env[LOCAL_AGENT_ROOT_ENV] = agentRoot
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    aipCleanup()
    if (prevLocalAgentRoot === undefined) delete process.env[LOCAL_AGENT_ROOT_ENV]
    else process.env[LOCAL_AGENT_ROOT_ENV] = prevLocalAgentRoot
    rmSync(agentRoot, { recursive: true, force: true })
  })

  it('communication 总结写入 pending-summary.json,返回 updated:true pending:true iterationSeq:null', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '聊了一下架构',
      type: 'communication',
      discussion: '讨论了 attach-summary 的 pending consume 模型',
      source: 'cursor',
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.ok).toBe(true)
    expect(body.data.updated).toBe(true)
    expect(body.data.pending).toBe(true)
    expect(body.data.iterationSeq).toBeNull()
    expect(body.data.jiraKey).toBe('ABC-700')

    const pendingFile = join(aipRoot(), 'ABC-700', PENDING_SUMMARY_FILE)
    expect(existsSync(pendingFile)).toBe(true)

    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.oneLine).toBe('聊了一下架构')
    expect(peeked?.summary.type).toBe('communication')
    expect(peeked?.source).toBe('cursor')
  })

  it('coding 总结落 pending(v2.13.3 起缺 changeScope 不再 400,改为 oneLine 兜底,下面专门用例覆盖)', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    // 正常 coding 落 pending
    const mockOk = makeMockRes()
    await handleAiProductivityAttachSummary(mockOk.res, {
      oneLine: '修了 attach 链路',
      type: 'coding',
      changeScope: '动了 4 个文件 + 1 个新建',
      source: 'cursor',
      cwd: repo
    })
    expect(mockOk.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.type).toBe('coding')
    expect(peeked?.summary.changeScope).toBe('动了 4 个文件 + 1 个新建')
  })

  it('pending 落盘后下一次 hook 写 iteration 时被消费,总结挂到该 iteration 上', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    // 模拟"AI 答复中段 attach"
    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '总结一下本轮架构讨论',
      type: 'communication',
      discussion: '决定走 pending consume',
      source: 'cursor',
      cwd: repo
    })
    expect(peekPendingSummary('ABC-700')?.summary.oneLine).toBe('总结一下本轮架构讨论')

    // 模拟"AI 答复结束后 Cursor hook 落 coding iteration"
    const hookDedupePath = join(
      mkdtempSync(join(tmpdir(), 'aip-hook-dedupe-att-')),
      'hook-dedupe.json'
    )
    await handleAiProductivityHook(
      makeMockRes().res,
      baseConfig,
      {
        projectRoot: repo,
        branch: 'feature/ABC-700-attach',
        tokens: 1234,
        source: 'cursor-hook',
        dedupeKey: 'att-conv-1#gen-1'
      },
      { dedupePath: hookDedupePath }
    )

    const iters = listIterations('ABC-700')
    const coding = iters.find((it) => it.kind === 'coding')
    expect(coding?.conversationSummary?.oneLine).toBe('总结一下本轮架构讨论')
    expect(coding?.conversationSummary?.type).toBe('communication')
    // pending 已消费
    expect(peekPendingSummary('ABC-700')).toBeNull()
  })

  it('jiraKey 无法解析时返回 400,且 pending 不落盘', async () => {
    // 不 init,且 cwd 是非 git 仓库 → 四级 fallback 全部失败
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: 'x',
      type: 'communication',
      discussion: 'y'
    })
    expect(mock.statusCode).toBe(400)
  })

  it('需求未 init 时返回 404,不落 pending', async () => {
    // cwd 解析得到 ABC-700,但没 init → 404
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '我们聊一下',
      type: 'communication',
      discussion: '没 init',
      cwd: repo
    })
    expect(mock.statusCode).toBe(404)
    expect(existsSync(join(aipRoot(), 'ABC-700', PENDING_SUMMARY_FILE))).toBe(false)
  })

  it('多次 attach 以最后一次为准(覆盖式 pending)', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '第一次',
      type: 'communication',
      discussion: '第一次',
      cwd: repo
    })
    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '第二次',
      type: 'communication',
      discussion: '第二次',
      cwd: repo
    })
    expect(peekPendingSummary('ABC-700')?.summary.oneLine).toBe('第二次')
  })

  // v2.10.0 验证:成功 attach 时同步落 recent-attach sentinel
  it('v2.10.0:成功 attach 之后,jiraKey 维度 sentinel 同步落到 hook-state 目录,calledAt 是合法 ISO', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const before = Date.now()
    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '总结一下',
      type: 'communication',
      discussion: 'sentinel 同步写盘验证',
      cwd: repo
    })
    const after = Date.now()

    const sentinelFile = recentAttachSentinelPath('ABC-700')
    expect(sentinelFile).toBe(join(agentRoot, 'hook-state', 'ABC-700.recent-attach.json'))
    expect(existsSync(sentinelFile)).toBe(true)

    const payload = readRecentAttachSentinel('ABC-700')
    expect(payload?.jiraKey).toBe('ABC-700')
    expect(payload?.calledAt).toBeTypeOf('string')
    const calledAtMs = Date.parse(payload!.calledAt)
    expect(Number.isFinite(calledAtMs)).toBe(true)
    expect(calledAtMs).toBeGreaterThanOrEqual(before)
    expect(calledAtMs).toBeLessThanOrEqual(after)
  })

  it('v2.10.0:多次 attach 时 sentinel 也覆盖式更新到最后一次的 calledAt', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '第一次',
      type: 'communication',
      discussion: '第一次',
      cwd: repo
    })
    const firstCalledAt = readRecentAttachSentinel('ABC-700')?.calledAt
    expect(firstCalledAt).toBeTypeOf('string')

    // 等待至少 5 ms 确保 ISO 时间戳变化
    await new Promise((resolve) => setTimeout(resolve, 5))

    await handleAiProductivityAttachSummary(makeMockRes().res, {
      oneLine: '第二次',
      type: 'communication',
      discussion: '第二次',
      cwd: repo
    })
    const secondCalledAt = readRecentAttachSentinel('ABC-700')?.calledAt
    expect(secondCalledAt).toBeTypeOf('string')
    expect(Date.parse(secondCalledAt!)).toBeGreaterThan(Date.parse(firstCalledAt!))
  })

  it('v2.10.0:attach 失败(需求未 init)时不落 sentinel', async () => {
    // 不 init,直接 attach → 404
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '我们聊一下',
      type: 'communication',
      discussion: '没 init',
      cwd: repo
    })
    expect(mock.statusCode).toBe(404)
    // sentinel 不应该写出来(只有成功路径才写)
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(false)
  })

  // v2.12.0:MCP zod max 下线后,agent 端 resolveAttachSummary 改 soft trim,
  // 不再返回 400。落盘到 pending-summary.json 时被截到上限。
  it('v2.12.0:超长 oneLine 被静默截断到 120 字,pending + sentinel 均按 200 路径落盘', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const longOneLine = 'A'.repeat(500)
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: longOneLine,
      type: 'communication',
      discussion: '正常长度',
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.oneLine.length).toBe(120)
    expect(peeked?.summary.oneLine).toBe('A'.repeat(120))
    // sentinel 也按成功路径落盘
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(true)
  })

  it('v2.12.0:超长 changeScope 被截到 120 字', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const longScope = 'B'.repeat(800)
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '修了一通',
      type: 'coding',
      changeScope: longScope,
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.changeScope?.length).toBe(120)
    expect(peeked?.summary.changeScope).toBe('B'.repeat(120))
  })

  it('v2.12.0:超长 discussion 被截到 300 字', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const longDiscussion = 'C'.repeat(1500)
    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '聊了很多',
      type: 'communication',
      discussion: longDiscussion,
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.discussion?.length).toBe(300)
    expect(peeked?.summary.discussion).toBe('C'.repeat(300))
  })

  it('v2.12.0:正常长度字段不被截断,完整保留', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '简短一句话',
      type: 'communication',
      discussion: '同样不长的讨论',
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.oneLine).toBe('简短一句话')
    expect(peeked?.summary.discussion).toBe('同样不长的讨论')
  })

  // v2.13.3:agent 端软兜底,字段缺失不再返回 400,改为 oneLine 兜底 / type 默认 communication
  it('v2.13.3:缺 type 字段时 agent 默认 communication + discussion 用 oneLine 兜底 + 200 + sentinel 落盘', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '只填了 oneLine,type 缺失',
      cwd: repo
    } as unknown as Parameters<typeof handleAiProductivityAttachSummary>[1])

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.oneLine).toBe('只填了 oneLine,type 缺失')
    expect(peeked?.summary.type).toBe('communication')
    expect(peeked?.summary.discussion).toBe('只填了 oneLine,type 缺失')
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(true)
  })

  it('v2.13.3:type=communication 缺 discussion 时 discussion 用 oneLine 兜底', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '聊天但没填 discussion',
      type: 'communication',
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.type).toBe('communication')
    expect(peeked?.summary.discussion).toBe('聊天但没填 discussion')
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(true)
  })

  it('v2.13.3:type=coding 缺 changeScope 时 changeScope 用 oneLine 兜底', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      oneLine: '改了点东西但没填 changeScope',
      type: 'coding',
      cwd: repo
    })

    expect(mock.statusCode).toBe(200)
    const peeked = peekPendingSummary('ABC-700')
    expect(peeked?.summary.type).toBe('coding')
    expect(peeked?.summary.changeScope).toBe('改了点东西但没填 changeScope')
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(true)
  })

  it('v2.13.3:缺 oneLine 仍返回 400,sentinel 不落盘', async () => {
    await handleAiProductivityInit(makeMockRes().res, baseConfig, {
      jiraInput: 'ABC-700',
      title: 'demo',
      projectRoot: repo
    })

    const mock = makeMockRes()
    await handleAiProductivityAttachSummary(mock.res, {
      type: 'communication',
      discussion: '有 discussion 但没 oneLine',
      cwd: repo
    } as unknown as Parameters<typeof handleAiProductivityAttachSummary>[1])

    expect(mock.statusCode).toBe(400)
    expect(JSON.parse(mock.body).message).toMatch(/oneLine/)
    expect(existsSync(recentAttachSentinelPath('ABC-700'))).toBe(false)
  })
})

describe('lessons handlers (v2.16.0 P0 经验沉淀)', () => {
  let aipRootCtx: ReturnType<typeof setupAipRoot>

  beforeEach(() => {
    aipRootCtx = setupAipRoot()
  })

  afterEach(() => {
    aipRootCtx.restore()
  })

  it('handleAiProductivitySaveLessons 写入 lessons 并返回 saved/replaced/rejected', () => {
    saveRequirement({ jiraKey: 'PROJ-1', title: 'demo' }, {})
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: 'PROJ-1',
      source: 'cursor',
      lessons: [
        {
          jiraKey: 'PROJ-1',
          type: 'pitfall',
          title: '坑1',
          content: '描述',
          tags: ['t1']
        },
        {
          jiraKey: 'PROJ-1',
          type: 'unknown' as never,
          title: '坑2',
          content: 'x'
        }
      ]
    })
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.code).toBe('OK')
    expect(body.data.savedCount).toBe(1)
    expect(body.data.saved).toHaveLength(1)
    expect(body.data.saved[0].source.extractedBy).toBe('cursor')
    expect(body.data.rejected).toHaveLength(1)
  })

  it('handleAiProductivitySaveLessons body 缺 jiraKey 且条目自带时仍写入', () => {
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: '',
      lessons: [{ jiraKey: 'AAA-9', type: 'rule', title: 'r', content: 'c' }]
    })
    expect(mock.statusCode).toBe(200)
    expect(JSON.parse(mock.body).data.savedCount).toBe(1)
  })

  it('handleAiProductivitySaveLessons 输入非数组返回 400', () => {
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, { jiraKey: 'X-1', lessons: 'oops' as never })
    expect(mock.statusCode).toBe(400)
  })

  it('handleAiProductivityListLessons 支持 jiraKey / type 过滤', () => {
    writeLessons(
      [
        { jiraKey: 'A-1', type: 'pitfall', title: '坑', content: 'c1' },
        { jiraKey: 'A-1', type: 'rule', title: '规', content: 'c2' },
        { jiraKey: 'B-2', type: 'pitfall', title: '坑2', content: 'c3' }
      ],
      {}
    )
    const mock = makeMockRes()
    handleAiProductivityListLessons(mock.res, { jiraKey: 'A-1' })
    const body = JSON.parse(mock.body)
    expect(body.data).toHaveLength(2)
    const mock2 = makeMockRes()
    handleAiProductivityListLessons(mock2.res, { type: 'pitfall' })
    expect(JSON.parse(mock2.body).data).toHaveLength(2)
  })

  it('handleAiProductivityGetLesson 返回详情 / 404 / 400', () => {
    const result = writeLessons(
      [{ jiraKey: 'P-1', type: 'pitfall', title: '坑', content: '内容' }],
      {}
    )
    const id = result.saved[0].id
    const mock = makeMockRes()
    handleAiProductivityGetLesson(mock.res, id)
    expect(mock.statusCode).toBe(200)
    expect(JSON.parse(mock.body).data.id).toBe(id)
    const mock404 = makeMockRes()
    handleAiProductivityGetLesson(mock404.res, 'lsn-NOPE-12345678')
    expect(mock404.statusCode).toBe(404)
    const mock400 = makeMockRes()
    handleAiProductivityGetLesson(mock400.res, 'illegal id with space')
    expect(mock400.statusCode).toBe(400)
  })

  it('handleAiProductivityDeleteLesson 删除后再 list 不再可见', () => {
    const result = writeLessons([{ jiraKey: 'P-1', type: 'rule', title: 'r', content: 'c' }], {})
    const id = result.saved[0].id
    const mockDel = makeMockRes()
    handleAiProductivityDeleteLesson(mockDel.res, id)
    expect(mockDel.statusCode).toBe(200)
    expect(JSON.parse(mockDel.body).data.deleted).toBe(true)
    const mockList = makeMockRes()
    handleAiProductivityListLessons(mockList.res, {})
    expect(JSON.parse(mockList.body).data).toEqual([])
  })

  it('handleAiProductivityLessonsBundle 返回 requirement+iterations+existingLessons,需求未 init 时 404', () => {
    saveRequirement({ jiraKey: 'P-1', title: 'demo' }, {})
    writeLessons([{ jiraKey: 'P-1', type: 'rule', title: 'r', content: 'c' }], {})
    const mock = makeMockRes()
    handleAiProductivityLessonsBundle(mock.res, 'P-1')
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.jiraKey).toBe('P-1')
    expect(body.data.requirement.title).toBe('demo')
    expect(body.data.existingLessons).toHaveLength(1)
    const mock404 = makeMockRes()
    handleAiProductivityLessonsBundle(mock404.res, 'NONE-1')
    expect(mock404.statusCode).toBe(404)
  })

  // v2.17.0 经验作用域 / 空数组路径 / projectSlug 透传
  it('handleAiProductivitySaveLessons 接受空数组并返回 savedCount=0(v2.17.0 价值判定无数据路径)', () => {
    saveRequirement({ jiraKey: 'EMPTY-1', title: 'demo' }, {})
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: 'EMPTY-1',
      source: 'cursor',
      lessons: []
    })
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.code).toBe('OK')
    expect(body.data.savedCount).toBe(0)
    expect(body.data.saved).toEqual([])
    expect(body.data.replaced).toEqual([])
    expect(body.data.rejected).toEqual([])
  })

  it('handleAiProductivitySaveLessons scope=project 缺 projectSlug 时按 requirement.projectSlug 兜底', () => {
    saveRequirement({ jiraKey: 'PROJ-7', title: 'demo', projectSlug: 'my-monorepo' }, {})
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: 'PROJ-7',
      source: 'cursor',
      lessons: [
        {
          jiraKey: 'PROJ-7',
          type: 'rule',
          title: '规则1',
          content: '内容',
          scope: 'project'
          // 故意不填 projectSlug
        }
      ]
    })
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.saved[0].scope).toBe('project')
    expect(body.data.saved[0].projectSlug).toBe('my-monorepo')
  })

  it('handleAiProductivitySaveLessons scope=general 强制清空 projectSlug', () => {
    saveRequirement({ jiraKey: 'PROJ-8', title: 'demo', projectSlug: 'my-monorepo' }, {})
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: 'PROJ-8',
      source: 'cursor',
      lessons: [
        {
          jiraKey: 'PROJ-8',
          type: 'pitfall',
          title: '通用陷阱',
          content: '内容',
          scope: 'general',
          // 即便 LLM 错填 projectSlug,scope=general 时也应被清空
          projectSlug: 'should-be-cleared'
        }
      ]
    })
    expect(mock.statusCode).toBe(200)
    const saved = JSON.parse(mock.body).data.saved[0]
    expect(saved.scope).toBe('general')
    expect(saved.projectSlug).toBe('')
  })

  it('handleAiProductivityListLessons 支持 scope / projectSlug query 过滤', () => {
    saveRequirement({ jiraKey: 'A-1', title: 't', projectSlug: 'app-a' }, {})
    saveRequirement({ jiraKey: 'B-1', title: 't', projectSlug: 'app-b' }, {})
    writeLessons(
      [
        { jiraKey: 'A-1', type: 'rule', title: 'a-project', content: 'c', scope: 'project' },
        { jiraKey: 'A-1', type: 'pitfall', title: '通用', content: 'c', scope: 'general' },
        { jiraKey: 'B-1', type: 'rule', title: 'b-project', content: 'c', scope: 'project' }
      ],
      {}
    )
    const mockGeneral = makeMockRes()
    handleAiProductivityListLessons(mockGeneral.res, { scope: 'general' })
    expect(JSON.parse(mockGeneral.body).data).toHaveLength(1)

    const mockProjA = makeMockRes()
    handleAiProductivityListLessons(mockProjA.res, { scope: 'project', projectSlug: 'app-a' })
    const rowsA = JSON.parse(mockProjA.body).data
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0].projectSlug).toBe('app-a')

    const mockProjAOnly = makeMockRes()
    handleAiProductivityListLessons(mockProjAOnly.res, { projectSlug: 'app-b' })
    expect(JSON.parse(mockProjAOnly.body).data).toHaveLength(1)
  })

  it('handleAiProductivityLessonsBundle 返回 currentProjectSlug 且 existingLessons 按通用+当前项目过滤', () => {
    saveRequirement({ jiraKey: 'CUR-1', title: 'cur', projectSlug: 'cur-app' }, {})
    saveRequirement({ jiraKey: 'OTH-1', title: 'oth', projectSlug: 'other-app' }, {})
    writeLessons(
      [
        // 当前项目专属
        { jiraKey: 'CUR-1', type: 'rule', title: 'self-proj', content: 'c', scope: 'project' },
        // 通用经验
        { jiraKey: 'OTH-1', type: 'pitfall', title: '通用', content: 'c', scope: 'general' },
        // 另一项目的专属经验 → 应被过滤掉
        { jiraKey: 'OTH-1', type: 'rule', title: 'other-proj', content: 'c', scope: 'project' }
      ],
      {}
    )
    const mock = makeMockRes()
    handleAiProductivityLessonsBundle(mock.res, 'CUR-1')
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body)
    expect(body.data.currentProjectSlug).toBe('cur-app')
    const titles = body.data.existingLessons.map((l: { title: string }) => l.title).sort()
    expect(titles).toEqual(['self-proj', '通用'])
  })

  // ============ v2.18.0 信号化 + 跨需求计数 路由层 ============

  it('handleAiProductivityLessonsBundle 返回 computedSignals.topThinkSeqs / fileChurnMap(v2.18.0)', async () => {
    saveRequirement(
      { jiraKey: 'BND-1', title: 'bnd', projectSlug: 'bnd-app', manualEstimateMinutes: 600 },
      {}
    )
    const { appendIteration } = await import('@ai-productivity-tracker/core/store')
    appendIteration('BND-1', { kind: 'init', branch: 'f/BND-1' })
    appendIteration('BND-1', {
      kind: 'coding',
      branch: 'f/BND-1',
      thinkSeconds: 30,
      cumulativeToken: 10_000,
      changedFiles: [{ path: 'shared.ts', status: 'M' }],
      diffInsertions: 5,
      diffDeletions: 0
    })
    appendIteration('BND-1', {
      kind: 'coding',
      branch: 'f/BND-1',
      thinkSeconds: 200, // 最长思考
      cumulativeToken: 20_000,
      changedFiles: [{ path: 'shared.ts', status: 'M' }],
      diffInsertions: 10,
      diffDeletions: 5
    })
    const mock = makeMockRes()
    handleAiProductivityLessonsBundle(mock.res, 'BND-1')
    expect(mock.statusCode).toBe(200)
    const body = JSON.parse(mock.body).data
    expect(body.computedSignals).toBeDefined()
    expect(body.computedSignals.cumulativeThinkSeconds).toBe(30 + 200)
    // topThinkSeqs:seq=3(200s) 在前
    expect(body.computedSignals.topThinkSeqs[0]).toBe(3)
    // shared.ts 触碰 2 次
    expect(body.computedSignals.fileChurnMap[0].path).toBe('shared.ts')
    expect(body.computedSignals.fileChurnMap[0].touchedSeqs.sort()).toEqual([2, 3])
  })

  it('handleAiProductivitySaveLessons 合并路径:同款 lesson 跨 jiraKey 第二次提 → replaced 非空 + hitCount 增长(v2.18.0)', () => {
    saveRequirement(
      { jiraKey: 'MG-1', title: 't1', projectSlug: 'mg-app', manualEstimateMinutes: 60 },
      {}
    )
    saveRequirement(
      { jiraKey: 'MG-2', title: 't2', projectSlug: 'mg-app', manualEstimateMinutes: 60 },
      {}
    )

    const mock1 = makeMockRes()
    handleAiProductivitySaveLessons(mock1.res, {
      jiraKey: 'MG-1',
      source: 'cursor',
      lessons: [
        {
          jiraKey: 'MG-1',
          type: 'pitfall',
          title: 'baseUrl 缺协议导致 422',
          content: 'x',
          tags: ['jira', 'baseurl'],
          scope: 'general'
        }
      ]
    })
    expect(mock1.statusCode).toBe(200)
    const first = JSON.parse(mock1.body).data
    expect(first.savedCount).toBe(1)
    const firstId = first.saved[0].id

    // 同款 lesson 在另一需求里再次出现 → agent 合并
    const mock2 = makeMockRes()
    handleAiProductivitySaveLessons(mock2.res, {
      jiraKey: 'MG-2',
      source: 'claude-code',
      lessons: [
        {
          jiraKey: 'MG-2',
          type: 'pitfall',
          title: 'baseUrl 缺协议导致 422 错误',
          content: 'y',
          tags: ['jira', 'baseurl', 'cors'],
          scope: 'general'
        }
      ]
    })
    expect(mock2.statusCode).toBe(200)
    const second = JSON.parse(mock2.body).data
    expect(second.replaced).toContain(firstId)
    expect(second.saved[0].hitCount).toBe(2)
    expect(second.saved[0].seenInJiraKeys.sort()).toEqual(['MG-1', 'MG-2'])

    // INDEX 投影同步含 hitCount
    const mockList = makeMockRes()
    handleAiProductivityListLessons(mockList.res, {})
    const all = JSON.parse(mockList.body).data
    expect(all).toHaveLength(1)
    expect(all[0].hitCount).toBe(2)
  })

  it('handleAiProductivitySaveLessons 新建路径:首条 lesson signals 注入 + trustReasons 非空(v2.18.0)', async () => {
    saveRequirement(
      {
        jiraKey: 'NEW-1',
        title: 't',
        projectSlug: 'new-app',
        manualEstimateMinutes: 600
      },
      {}
    )
    const { appendIteration } = await import('@ai-productivity-tracker/core/store')
    appendIteration('NEW-1', { kind: 'init', branch: 'f/NEW-1' })
    appendIteration('NEW-1', {
      kind: 'coding',
      branch: 'f/NEW-1',
      thinkSeconds: 90,
      cumulativeToken: 50_000,
      elapsedMinutes: 60
    })
    const mock = makeMockRes()
    handleAiProductivitySaveLessons(mock.res, {
      jiraKey: 'NEW-1',
      source: 'cursor',
      lessons: [
        {
          jiraKey: 'NEW-1',
          type: 'best-practice',
          title: '复杂改动一气呵成',
          content: '记录该模式',
          scope: 'project',
          iterationSeqs: [2]
        }
      ]
    })
    expect(mock.statusCode).toBe(200)
    const saved = JSON.parse(mock.body).data.saved[0]
    expect(saved.signals).not.toBeNull()
    expect(saved.signals.sourceThinkSeconds).toBe(90)
    expect(saved.signals.sourceEffectiveTokens).toBe(50_000)
    expect(saved.seenInJiraKeys).toEqual(['NEW-1'])
    expect(saved.hitCount).toBe(1)
    expect(saved.trustReasons.length).toBeGreaterThan(0)
  })
})
