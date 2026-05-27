import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_FORMULA, readFormula, writeFormula } from './formula-store.js'
import { formulaPath } from './paths.js'

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
    const out = writeFormula({ wThink: 0.5 }, root)
    expect(out.wThink).toBe(0.5)
    expect(out.tokenPenaltyEnabled).toBe(DEFAULT_FORMULA.tokenPenaltyEnabled)
    expect(out.tokenSoftCapK).toBe(DEFAULT_FORMULA.tokenSoftCapK)
    expect(readFormula(root).wThink).toBe(0.5)
  })

  it('writeFormula 第二次只动指定字段', () => {
    writeFormula({ wThink: 0.4, tokenSoftCapK: 100 }, root)
    const out = writeFormula({ tokenPenaltyEnabled: true }, root)
    expect(out.wThink).toBe(0.4)
    expect(out.tokenPenaltyEnabled).toBe(true)
    expect(out.tokenSoftCapK).toBe(100)
  })

  it('wThink 越界时被钳制到 [0, 1]', () => {
    const lo = writeFormula({ wThink: -0.5 }, root)
    expect(lo.wThink).toBe(0)
    const hi = writeFormula({ wThink: 2 }, root)
    expect(hi.wThink).toBe(1)
  })

  it('读取老版 formula.json(含 kBug / hourlyCostUsd 等老字段)时静默丢弃,回落默认值', () => {
    const file = formulaPath(root)
    writeFileSync(
      file,
      JSON.stringify({
        kBug: 0.15,
        kToken: 0.05,
        tokenPriceUsdPer1k: 0.01,
        hourlyCostUsd: 40
      }),
      'utf-8'
    )
    expect(readFormula(root)).toEqual(DEFAULT_FORMULA)
  })

  it('读取部分新字段 + 部分老字段时,只采纳新字段,老字段被丢弃', () => {
    const file = formulaPath(root)
    writeFileSync(
      file,
      JSON.stringify({
        kBug: 0.3,
        wThink: 0.55,
        tokenPenaltyEnabled: true
      }),
      'utf-8'
    )
    const out = readFormula(root)
    expect(out.wThink).toBe(0.55)
    expect(out.tokenPenaltyEnabled).toBe(true)
    expect(out.tokenSoftCapK).toBe(DEFAULT_FORMULA.tokenSoftCapK)
    expect(out).not.toHaveProperty('kBug')
  })
})
