import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonlIncremental } from './jsonl-incremental.js'

describe('readJsonlIncremental', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aip-jsonl-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('文件不存在返回空结果', async () => {
    const result = await readJsonlIncremental(join(tmp, 'missing.jsonl'), 0)
    expect(result).toEqual({ lines: [], newOffset: 0, truncated: false })
  })

  it('从 offset=0 读取整个文件,按行拆分', async () => {
    const f = join(tmp, 'a.jsonl')
    writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":3}\n', 'utf-8')
    const result = await readJsonlIncremental(f, 0)
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(result.newOffset).toBe(24)
    expect(result.truncated).toBe(false)
  })

  it('支持 append 增量:再次读取只返回新增行', async () => {
    const f = join(tmp, 'a.jsonl')
    writeFileSync(f, '{"a":1}\n{"b":2}\n', 'utf-8')
    const first = await readJsonlIncremental(f, 0)
    appendFileSync(f, '{"c":3}\n', 'utf-8')
    const second = await readJsonlIncremental(f, first.newOffset)
    expect(second.lines).toEqual(['{"c":3}'])
    expect(second.newOffset).toBe(24)
  })

  it('尾部未完整的行不会被消费,offset 停在最后换行符', async () => {
    const f = join(tmp, 'a.jsonl')
    writeFileSync(f, '{"a":1}\n{"b":2}\n{"partial":', 'utf-8')
    const result = await readJsonlIncremental(f, 0)
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(result.newOffset).toBe(16)
  })

  it('文件被截断时 truncated=true,从 0 重新读', async () => {
    const f = join(tmp, 'a.jsonl')
    writeFileSync(f, '{"a":1}\n{"b":2}\n', 'utf-8')
    writeFileSync(f, '{"new":1}\n', 'utf-8')
    const result = await readJsonlIncremental(f, 16)
    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(['{"new":1}'])
  })

  it('空行被忽略', async () => {
    const f = join(tmp, 'a.jsonl')
    writeFileSync(f, '{"a":1}\n\n{"b":2}\n   \n', 'utf-8')
    const result = await readJsonlIncremental(f, 0)
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}'])
  })
})
