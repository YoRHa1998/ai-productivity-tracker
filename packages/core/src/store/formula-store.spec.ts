import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_FORMULA, readFormula, writeFormula } from './formula-store.js'

describe('formula-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-formula-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('缺失时返回 DEFAULT_FORMULA', () => {
    expect(readFormula(root)).toEqual(DEFAULT_FORMULA)
  })

  it('writeFormula 合并 patch 后回读一致', () => {
    const out = writeFormula({ kBug: 0.3 }, root)
    expect(out.kBug).toBe(0.3)
    expect(out.kToken).toBe(DEFAULT_FORMULA.kToken)
    expect(readFormula(root).kBug).toBe(0.3)
  })

  it('writeFormula 第二次只动指定字段', () => {
    writeFormula({ kBug: 0.3, hourlyCostUsd: 50 }, root)
    const out = writeFormula({ kToken: 0.07 }, root)
    expect(out.kBug).toBe(0.3)
    expect(out.kToken).toBe(0.07)
    expect(out.hourlyCostUsd).toBe(50)
  })
})
