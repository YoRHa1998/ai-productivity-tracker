import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideIncrementalRead, loadWatcherState, saveWatcherState } from './watcher-state.js'

describe('watcher-state', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aip-ws-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('文件不存在返回空 state', () => {
    expect(loadWatcherState(join(tmp, 'missing.json'))).toEqual({ version: 1, files: {} })
  })

  it('save 后 load 回环一致', () => {
    const p = join(tmp, 'state.json')
    saveWatcherState(p, {
      version: 1,
      files: {
        '/a.jsonl': { offset: 100, mtimeMs: 1700000000000 }
      }
    })
    expect(existsSync(p)).toBe(true)
    const reloaded = loadWatcherState(p)
    expect(reloaded.files['/a.jsonl']).toEqual({ offset: 100, mtimeMs: 1700000000000 })
  })

  it('load 容错:坏 JSON 返回默认 state', () => {
    const p = join(tmp, 'state.json')
    writeFileSync(p, '{ broken', 'utf-8')
    expect(loadWatcherState(p)).toEqual({ version: 1, files: {} })
  })

  it('save 通过 tmp + rename 原子化', () => {
    const p = join(tmp, 'sub', 'state.json')
    saveWatcherState(p, { version: 1, files: {} })
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    expect(parsed.version).toBe(1)
  })

  it('save 后 load 回环保留 size / ino 新字段', () => {
    const p = join(tmp, 'state.json')
    saveWatcherState(p, {
      version: 1,
      files: {
        '/a.jsonl': { offset: 100, size: 100, ino: 12345, mtimeMs: 1700000000000 }
      }
    })
    const reloaded = loadWatcherState(p)
    expect(reloaded.files['/a.jsonl']).toEqual({
      offset: 100,
      size: 100,
      ino: 12345,
      mtimeMs: 1700000000000
    })
  })

  it('加载旧版 state(无 size / ino)不丢 offset / mtimeMs', () => {
    const p = join(tmp, 'state.json')
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        files: { '/old.jsonl': { offset: 42, mtimeMs: 1699999999999 } }
      }),
      'utf-8'
    )
    const reloaded = loadWatcherState(p)
    expect(reloaded.files['/old.jsonl']).toEqual({ offset: 42, mtimeMs: 1699999999999 })
    expect(reloaded.files['/old.jsonl'].size).toBeUndefined()
    expect(reloaded.files['/old.jsonl'].ino).toBeUndefined()
  })
})

describe('decideIncrementalRead', () => {
  it('prev 缺失(首次扫描)→ 从 0 读', () => {
    expect(decideIncrementalRead(undefined, { size: 100, mtimeMs: 1, ino: 7 })).toEqual({
      skip: false,
      startOffset: 0
    })
  })

  it('正常追加(ino 不变、size 增大)→ 从上次 offset 续读', () => {
    const prev = { offset: 100, size: 100, ino: 7, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 180, mtimeMs: 2, ino: 7 })).toEqual({
      skip: false,
      startOffset: 100
    })
  })

  it('未变(offset===size && ino 一致 && mtime 一致)→ skip', () => {
    const prev = { offset: 100, size: 100, ino: 7, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 100, mtimeMs: 1, ino: 7 })).toEqual({
      skip: true,
      startOffset: 100
    })
  })

  it('inode 变化(轮转/替换)→ 从 0 重读', () => {
    const prev = { offset: 100, size: 100, ino: 7, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 50, mtimeMs: 2, ino: 99 })).toEqual({
      skip: false,
      startOffset: 0
    })
  })

  it('截断(size < offset、ino 不变)→ 从 0 重读', () => {
    const prev = { offset: 100, size: 100, ino: 7, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 40, mtimeMs: 2, ino: 7 })).toEqual({
      skip: false,
      startOffset: 0
    })
  })

  it('旧 state(无 ino)未变 → 退回 offset+mtime 逻辑判 skip', () => {
    const prev = { offset: 100, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 100, mtimeMs: 1, ino: 7 })).toEqual({
      skip: true,
      startOffset: 100
    })
  })

  it('旧 state(无 ino)有新增 → 续读补齐', () => {
    const prev = { offset: 100, mtimeMs: 1 }
    expect(decideIncrementalRead(prev, { size: 150, mtimeMs: 2, ino: 7 })).toEqual({
      skip: false,
      startOffset: 100
    })
  })

  it('Windows 兜底:ino=0 不参与重置判定,退回 offset+mtime', () => {
    const prev = { offset: 100, size: 100, ino: 0, mtimeMs: 1 }
    // ino 在两侧都为 0 → 不因 ino 差异重置;offset===size && mtime 一致 → skip
    expect(decideIncrementalRead(prev, { size: 100, mtimeMs: 1, ino: 0 })).toEqual({
      skip: true,
      startOffset: 100
    })
    // stats.ino=0(拿不到)即使 prev.ino 有值也不重置
    const prev2 = { offset: 100, size: 100, ino: 7, mtimeMs: 1 }
    expect(decideIncrementalRead(prev2, { size: 120, mtimeMs: 2, ino: 0 })).toEqual({
      skip: false,
      startOffset: 100
    })
  })
})
