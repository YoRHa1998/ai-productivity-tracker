import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
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
})
