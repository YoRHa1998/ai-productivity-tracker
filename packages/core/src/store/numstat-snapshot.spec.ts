import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  numstatMapToRecord,
  readNumstatSnapshot,
  writeNumstatSnapshot
} from './numstat-snapshot.js'
import { ensureRequirementDir } from './paths.js'

describe('numstat-snapshot', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-numstat-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('写入后能读回, baseRef 一致时返回 perFile', () => {
    writeNumstatSnapshot(
      'ABC-1',
      {
        version: 1,
        baseRef: 'init-sha',
        perFile: {
          'a.ts': { insertions: 30, deletions: 5 },
          'b.ts': { insertions: 0, deletions: 1 }
        },
        updatedAt: '2026-05-15T00:00:00.000Z'
      },
      root
    )
    const back = readNumstatSnapshot('ABC-1', 'init-sha', root)
    expect(back).not.toBeNull()
    expect(back!.perFile['a.ts'].insertions).toBe(30)
    expect(back!.perFile['b.ts'].deletions).toBe(1)
  })

  it('baseRef 不一致 (init base commit 变了) -> 返回 null, 视为没有可用快照', () => {
    writeNumstatSnapshot(
      'ABC-1',
      {
        version: 1,
        baseRef: 'sha-A',
        perFile: { 'a.ts': { insertions: 30, deletions: 5 } },
        updatedAt: '2026-05-15T00:00:00.000Z'
      },
      root
    )
    expect(readNumstatSnapshot('ABC-1', 'sha-B', root)).toBeNull()
  })

  it('文件缺失时返回 null', () => {
    ensureRequirementDir('ABC-2', root)
    expect(readNumstatSnapshot('ABC-2', 'init-sha', root)).toBeNull()
  })

  it('文件内容损坏时返回 null', () => {
    ensureRequirementDir('ABC-3', root)
    writeFileSync(join(root, 'ABC-3', 'numstat-snapshot.json'), 'not json {{{')
    expect(readNumstatSnapshot('ABC-3', 'init-sha', root)).toBeNull()
  })

  it('version 不匹配时返回 null (留作后续 schema 升级)', () => {
    ensureRequirementDir('ABC-4', root)
    writeFileSync(
      join(root, 'ABC-4', 'numstat-snapshot.json'),
      JSON.stringify({ version: 99, baseRef: 'init-sha', perFile: {}, updatedAt: '' })
    )
    expect(readNumstatSnapshot('ABC-4', 'init-sha', root)).toBeNull()
  })

  it('numstatMapToRecord 把 Map 转 Record 用于 JSON 序列化', () => {
    const map = new Map([
      ['a.ts', { insertions: 1, deletions: 2 }],
      ['b.ts', { insertions: 3, deletions: 4 }]
    ])
    const rec = numstatMapToRecord(map)
    expect(rec['a.ts']).toEqual({ insertions: 1, deletions: 2 })
    expect(rec['b.ts']).toEqual({ insertions: 3, deletions: 4 })
  })

  it('写入是原子写 (tmp -> rename), 不会留下半截文件', () => {
    writeNumstatSnapshot(
      'ABC-5',
      {
        version: 1,
        baseRef: 'sha',
        perFile: { 'a.ts': { insertions: 1, deletions: 0 } },
        updatedAt: '2026-05-15T00:00:00.000Z'
      },
      root
    )
    // 读出来的内容是完整的 JSON
    const content = readFileSync(join(root, 'ABC-5', 'numstat-snapshot.json'), 'utf-8')
    expect(() => JSON.parse(content)).not.toThrow()
  })
})
