import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listIndexEntries, readIndex, removeIndexEntry, upsertIndexEntry } from './index-store.js'

describe('index-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-index-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('readIndex 缺失时返回空结构', () => {
    expect(readIndex(root)).toEqual({ version: 1, items: {} })
  })

  it('upsertIndexEntry 写入并补全默认字段', () => {
    const entry = upsertIndexEntry('PROJ-1', { title: '需求一', repoPath: '/tmp/repo' }, root)
    expect(entry.jiraKey).toBe('PROJ-1')
    expect(entry.title).toBe('需求一')
    expect(entry.repoPath).toBe('/tmp/repo')
    expect(entry.status).toBe('in_progress')
    expect(entry.iterationCount).toBe(0)
    expect(entry.startedAt).toBeTruthy()

    const persisted = JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'))
    expect(persisted.items['PROJ-1'].title).toBe('需求一')
  })

  it('upsertIndexEntry 第二次部分更新保留已有字段', () => {
    upsertIndexEntry(
      'PROJ-1',
      { title: '需求一', repoPath: '/tmp/repo', startedAt: '2026-01-01T00:00:00.000Z' },
      root
    )
    const updated = upsertIndexEntry(
      'PROJ-1',
      { iterationCount: 5, latestIterationAt: '2026-01-02T00:00:00.000Z' },
      root
    )
    expect(updated.title).toBe('需求一')
    expect(updated.repoPath).toBe('/tmp/repo')
    expect(updated.startedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(updated.iterationCount).toBe(5)
    expect(updated.latestIterationAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('listIndexEntries 按 updatedAt 倒序', () => {
    upsertIndexEntry('A-1', { title: 'A', updatedAt: '2026-05-10T00:00:00.000Z' }, root)
    upsertIndexEntry('B-2', { title: 'B', updatedAt: '2026-05-12T00:00:00.000Z' }, root)
    upsertIndexEntry('C-3', { title: 'C', updatedAt: '2026-05-11T00:00:00.000Z' }, root)
    const list = listIndexEntries(root)
    expect(list.map((e) => e.jiraKey)).toEqual(['B-2', 'C-3', 'A-1'])
  })

  it('removeIndexEntry 移除并返回 true', () => {
    upsertIndexEntry('PROJ-1', { title: '需求一' }, root)
    expect(removeIndexEntry('PROJ-1', root)).toBe(true)
    expect(removeIndexEntry('PROJ-1', root)).toBe(false)
    expect(existsSync(join(root, 'index.json'))).toBe(true)
    expect(readIndex(root).items).toEqual({})
  })
})
