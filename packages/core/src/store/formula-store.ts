import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { ensureRoot, formulaPath } from './paths.js'

export interface FormulaSettings {
  kBug: number
  kToken: number
  tokenPriceUsdPer1k: number
  hourlyCostUsd: number
}

export const DEFAULT_FORMULA: FormulaSettings = {
  kBug: 0.15,
  kToken: 0.05,
  tokenPriceUsdPer1k: 0.01,
  hourlyCostUsd: 40
}

export function readFormula(root?: string): FormulaSettings {
  const file = formulaPath(root)
  if (!existsSync(file)) return { ...DEFAULT_FORMULA }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<FormulaSettings>
    return {
      kBug: typeof parsed.kBug === 'number' ? parsed.kBug : DEFAULT_FORMULA.kBug,
      kToken: typeof parsed.kToken === 'number' ? parsed.kToken : DEFAULT_FORMULA.kToken,
      tokenPriceUsdPer1k:
        typeof parsed.tokenPriceUsdPer1k === 'number'
          ? parsed.tokenPriceUsdPer1k
          : DEFAULT_FORMULA.tokenPriceUsdPer1k,
      hourlyCostUsd:
        typeof parsed.hourlyCostUsd === 'number'
          ? parsed.hourlyCostUsd
          : DEFAULT_FORMULA.hourlyCostUsd
    }
  } catch {
    return { ...DEFAULT_FORMULA }
  }
}

export function writeFormula(patch: Partial<FormulaSettings>, root?: string): FormulaSettings {
  ensureRoot(root)
  const current = readFormula(root)
  const next: FormulaSettings = {
    kBug: patch.kBug ?? current.kBug,
    kToken: patch.kToken ?? current.kToken,
    tokenPriceUsdPer1k: patch.tokenPriceUsdPer1k ?? current.tokenPriceUsdPer1k,
    hourlyCostUsd: patch.hourlyCostUsd ?? current.hourlyCostUsd
  }
  const file = formulaPath(root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
  return next
}
