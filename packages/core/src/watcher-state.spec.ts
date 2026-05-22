import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWatcherState, saveWatcherState } from './watcher-state.js'

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
})
