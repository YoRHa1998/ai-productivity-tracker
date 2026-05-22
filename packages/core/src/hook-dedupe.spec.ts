import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendDedupeKey,
  emptyDedupeState,
  hasDedupeKey,
  loadDedupeState,
  saveDedupeState
} from './hook-dedupe.js'

describe('hook-dedupe', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aip-dedupe-'))
    file = join(dir, 'hook-dedupe.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadDedupeState 在文件缺失时返回空状态', () => {
    expect(loadDedupeState(file)).toEqual({ version: 1, keys: [] })
  })

  it('saveDedupeState + loadDedupeState 往返一致', () => {
    const s = appendDedupeKey(emptyDedupeState(), 'k1', '2026-05-15T01:00:00.000Z')
    saveDedupeState(file, s)
    const loaded = loadDedupeState(file)
    expect(loaded.keys.map((e) => e.key)).toEqual(['k1'])
  })

  it('损坏的 JSON 文件被静默重置', () => {
    writeFileSync(file, '{not json')
    expect(loadDedupeState(file)).toEqual({ version: 1, keys: [] })
  })

  it('hasDedupeKey 正确命中', () => {
    let s = emptyDedupeState()
    s = appendDedupeKey(s, 'a', '2026-05-15T01:00:00.000Z')
    expect(hasDedupeKey(s, 'a')).toBe(true)
    expect(hasDedupeKey(s, 'b')).toBe(false)
  })

  it('appendDedupeKey 重复 key 移到末尾,不重复累加', () => {
    let s = emptyDedupeState()
    s = appendDedupeKey(s, 'a', '2026-05-15T01:00:00.000Z')
    s = appendDedupeKey(s, 'b', '2026-05-15T01:01:00.000Z')
    s = appendDedupeKey(s, 'a', '2026-05-15T01:02:00.000Z')
    expect(s.keys.map((e) => e.key)).toEqual(['b', 'a'])
    expect(s.keys.find((e) => e.key === 'a')?.at).toBe('2026-05-15T01:02:00.000Z')
  })

  it('超过 capacity 时丢弃最早的条目', () => {
    let s = emptyDedupeState()
    for (let i = 0; i < 5; i += 1) {
      s = appendDedupeKey(s, `k${i}`, `2026-05-15T01:0${i}:00.000Z`, 3)
    }
    expect(s.keys.map((e) => e.key)).toEqual(['k2', 'k3', 'k4'])
  })

  it('saveDedupeState 自动建目录', () => {
    const nested = join(dir, 'nested', 'sub', 'hook-dedupe.json')
    saveDedupeState(nested, emptyDedupeState())
    expect(JSON.parse(readFileSync(nested, 'utf-8'))).toEqual({ version: 1, keys: [] })
  })
})
