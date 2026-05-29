import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listRequirementsFromStore,
  loadRequirement,
  saveRequirement,
  updateRequirement
} from './requirement-store.js'
import { readIndex } from './index-store.js'

describe('requirement-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-req-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('saveRequirement 创建文件夹与 requirement.json,并同步 index', () => {
    const req = saveRequirement(
      { jiraKey: 'PROJ-100', title: 'Hello', summary: 'sum' },
      { root, repoPath: '/tmp/repo' }
    )
    expect(req.jiraKey).toBe('PROJ-100')
    expect(req.title).toBe('Hello')
    expect(req.status).toBe('in_progress')
    expect(existsSync(join(root, 'PROJ-100', 'requirement.json'))).toBe(true)

    const idx = readIndex(root)
    expect(idx.items['PROJ-100']).toBeDefined()
    expect(idx.items['PROJ-100'].repoPath).toBe('/tmp/repo')
  })

  it('loadRequirement 缺失时返回 null', () => {
    expect(loadRequirement('PROJ-X', root)).toBeNull()
  })

  it('saveRequirement 二次保存保留 createdAt 但刷新 updatedAt', async () => {
    const first = saveRequirement({ jiraKey: 'PROJ-1', title: 'a' }, { root })
    await new Promise((r) => setTimeout(r, 5))
    const second = saveRequirement({ jiraKey: 'PROJ-1', title: 'b' }, { root })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).not.toBe(first.updatedAt)
    expect(second.title).toBe('b')
  })

  it('updateRequirement 仅改 patch 字段', () => {
    saveRequirement({ jiraKey: 'PROJ-1', title: 'a', summary: 'orig' }, { root })
    const next = updateRequirement('PROJ-1', { status: 'finished' }, root)
    expect(next.summary).toBe('orig')
    expect(next.status).toBe('finished')
  })

  it('updateRequirement 在缺失时抛错', () => {
    expect(() => updateRequirement('PROJ-MISS', { status: 'finished' }, root)).toThrow()
  })

  it('listRequirementsFromStore 按 index 枚举', () => {
    saveRequirement({ jiraKey: 'A-1', title: 'A' }, { root })
    saveRequirement({ jiraKey: 'B-2', title: 'B' }, { root })
    const list = listRequirementsFromStore(root)
    expect(list.map((r) => r.jiraKey).sort()).toEqual(['A-1', 'B-2'])
  })

  it('formulaWThinkOverride 默认 null,可写入并 round-trip', () => {
    const first = saveRequirement({ jiraKey: 'PROJ-7', title: 't' }, { root })
    expect(first.formulaWThinkOverride).toBeNull()

    const updated = updateRequirement('PROJ-7', { formulaWThinkOverride: 0.35 }, root)
    expect(updated.formulaWThinkOverride).toBe(0.35)

    const reloaded = loadRequirement('PROJ-7', root)
    expect(reloaded?.formulaWThinkOverride).toBe(0.35)

    const cleared = updateRequirement('PROJ-7', { formulaWThinkOverride: null }, root)
    expect(cleared.formulaWThinkOverride).toBeNull()
  })

  it('finishedAt 默认 null;切到 finished 自动戳记,回到 in_progress 清空', async () => {
    const created = saveRequirement({ jiraKey: 'PROJ-F', title: 't' }, { root })
    expect(created.finishedAt).toBeNull()

    const finished = updateRequirement('PROJ-F', { status: 'finished' }, root)
    expect(finished.status).toBe('finished')
    expect(typeof finished.finishedAt).toBe('string')
    expect(finished.finishedAt).not.toBeNull()

    // 重复点「已完成」不刷新定格点
    await new Promise((r) => setTimeout(r, 5))
    const stillFinished = updateRequirement('PROJ-F', { status: 'finished' }, root)
    expect(stillFinished.finishedAt).toBe(finished.finishedAt)

    // 回到进行中清空定格点
    const reopened = updateRequirement('PROJ-F', { status: 'in_progress' }, root)
    expect(reopened.finishedAt).toBeNull()
  })

  it('finishedAt:abandoned 同样戳记;不带 status 的 patch 不动 finishedAt', () => {
    saveRequirement({ jiraKey: 'PROJ-AB', title: 't' }, { root })
    const abandoned = updateRequirement('PROJ-AB', { status: 'abandoned' }, root)
    expect(abandoned.finishedAt).not.toBeNull()

    const stamp = abandoned.finishedAt
    const titleOnly = updateRequirement('PROJ-AB', { title: 'x' }, root)
    expect(titleOnly.finishedAt).toBe(stamp)
  })

  it('finishedAt:显式传入 patch.finishedAt 时尊重其值(历史数据回填)', () => {
    saveRequirement({ jiraKey: 'PROJ-BF', title: 't' }, { root })
    const backfilled = updateRequirement(
      'PROJ-BF',
      { status: 'finished', finishedAt: '2026-05-01T00:00:00.000Z' },
      root
    )
    expect(backfilled.finishedAt).toBe('2026-05-01T00:00:00.000Z')
  })

  it('loadRequirement 老 requirement.json(缺 formulaWThinkOverride)兜底为 null', () => {
    // 模拟 rc.27 之前的 requirement.json:不包含 formulaWThinkOverride 字段
    const jiraKey = 'LEGACY-1'
    const dir = join(root, jiraKey)
    const file = join(dir, 'requirement.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        jiraKey,
        title: 'legacy',
        status: 'in_progress',
        manualEstimateMinutes: 60
      }),
      'utf-8'
    )
    const loaded = loadRequirement(jiraKey, root)
    expect(loaded).not.toBeNull()
    expect(loaded?.formulaWThinkOverride).toBeNull()
  })
})
