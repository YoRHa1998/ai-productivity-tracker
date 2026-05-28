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
