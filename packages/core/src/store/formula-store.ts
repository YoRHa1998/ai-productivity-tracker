import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { ensureRoot, formulaPath } from './paths.js'

/**
 * 提效公式配置(v1.0.0-rc.9 起精简版本)。
 *
 * 设计目标:把 boost 计算从「墙钟 × Bug惩罚 × Token惩罚」三因子收敛为
 * 「加权时间 + 可选 Token 软上限」两因子,移除业务上不易解释的时薪 / token 单价配置。
 *
 * - `wThink`:AI 实际参与时间(totalThinkSeconds / 60)在分母中的权重,墙钟时间权重 = 1 - wThink。
 *   并行开发多个需求时把权重往 AI 时间偏(默认 0.7),可大幅修正墙钟膨胀。
 * - `tokenPenaltyEnabled`:是否在 boost 上叠加 token 软上限惩罚。默认关闭 → 公式只看时间。
 * - `tokenSoftCapK`:token 软上限(单位:k tokens)。仅当 enabled 且 > 0 时生效,
 *   公式 `tokenPenalty = 1 + max(0, tokens/1000 - cap) / cap`,超过软上限部分按比例线性惩罚。
 *
 * 老 formula.json 中的 `kBug` / `kToken` / `tokenPriceUsdPer1k` / `hourlyCostUsd` 字段
 * 在 `readFormula` 中会被静默丢弃,不需要任何手工迁移。
 */
export interface FormulaSettings {
  /** AI 工作时间权重,墙钟时间权重 = 1 - wThink。范围 [0, 1],越大越向 AI 实参时间倾斜。 */
  wThink: number
  /** 是否启用 token 软上限惩罚。关闭(默认)时 boost 只看时间。 */
  tokenPenaltyEnabled: boolean
  /** token 软上限(单位:k tokens)。仅在 `tokenPenaltyEnabled` 为 true 且本字段 > 0 时生效。 */
  tokenSoftCapK: number
}

export const DEFAULT_FORMULA: FormulaSettings = {
  wThink: 0.7,
  tokenPenaltyEnabled: false,
  tokenSoftCapK: 200
}

function clampWThink(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FORMULA.wThink
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function normalizeTokenSoftCapK(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_FORMULA.tokenSoftCapK
  }
  return value
}

export function readFormula(root?: string): FormulaSettings {
  const file = formulaPath(root)
  if (!existsSync(file)) return { ...DEFAULT_FORMULA }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<FormulaSettings>
    return {
      wThink: 'wThink' in parsed ? clampWThink(parsed.wThink) : DEFAULT_FORMULA.wThink,
      tokenPenaltyEnabled:
        typeof parsed.tokenPenaltyEnabled === 'boolean'
          ? parsed.tokenPenaltyEnabled
          : DEFAULT_FORMULA.tokenPenaltyEnabled,
      tokenSoftCapK:
        'tokenSoftCapK' in parsed
          ? normalizeTokenSoftCapK(parsed.tokenSoftCapK)
          : DEFAULT_FORMULA.tokenSoftCapK
    }
  } catch {
    return { ...DEFAULT_FORMULA }
  }
}

export function writeFormula(patch: Partial<FormulaSettings>, root?: string): FormulaSettings {
  ensureRoot(root)
  const current = readFormula(root)
  const next: FormulaSettings = {
    wThink: patch.wThink !== undefined ? clampWThink(patch.wThink) : current.wThink,
    tokenPenaltyEnabled:
      typeof patch.tokenPenaltyEnabled === 'boolean'
        ? patch.tokenPenaltyEnabled
        : current.tokenPenaltyEnabled,
    tokenSoftCapK:
      patch.tokenSoftCapK !== undefined
        ? normalizeTokenSoftCapK(patch.tokenSoftCapK)
        : current.tokenSoftCapK
  }
  const file = formulaPath(root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
  return next
}
