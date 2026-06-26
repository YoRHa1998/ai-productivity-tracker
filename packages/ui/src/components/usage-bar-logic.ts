/**
 * UsageBar 纯逻辑(与组件解耦,便于单测):条长归一化 + 三档阈值取色 + 紧凑数值。
 *
 * 颜色取设计 token(--aipt-usage-low/mid/high),此处只决定用哪个变量名,不写死色值。
 */

export interface UsageThresholds {
  warn: number
  danger: number
}

export const DEFAULT_USAGE_THRESHOLDS: UsageThresholds = { warn: 0.33, danger: 0.66 }

/**
 * 绝对 token 阈值(会话列表配色用):达到 danger(300K)红、达到 warn(150K)橙、否则绿。
 * 与「条长归一化分母」无关,可被 props 覆盖。
 */
export const DEFAULT_ABSOLUTE_USAGE_THRESHOLDS: UsageThresholds = {
  warn: 150_000,
  danger: 300_000
}

/** value 相对 max 的归一化比值,clamp 到 [0,1];max<=0 或非法时为 0。 */
export function usageRatio(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0
  const r = value / max
  if (!Number.isFinite(r) || r <= 0) return 0
  return r > 1 ? 1 : r
}

/** 条长百分比字符串(如 `42.0%`)。 */
export function usageWidthPct(value: number, max: number): string {
  return `${(usageRatio(value, max) * 100).toFixed(1)}%`
}

/** 按比值落入绿/橙/红三档,返回对应 CSS 变量引用。 */
export function usageColorVar(
  ratio: number,
  thresholds: UsageThresholds = DEFAULT_USAGE_THRESHOLDS
): string {
  if (ratio >= thresholds.danger) return 'var(--aipt-usage-high)'
  if (ratio >= thresholds.warn) return 'var(--aipt-usage-mid)'
  return 'var(--aipt-usage-low)'
}

/**
 * 按 value 的**绝对值**落入绿/橙/红三档,返回对应 CSS 变量引用。
 *
 * 与 usageColorVar(按比值)互补:用于会话列表「绝对量级」配色,即便条很短,只要
 * value 达阈值即显对应颜色。
 */
export function usageColorVarAbsolute(
  value: number,
  thresholds: UsageThresholds = DEFAULT_ABSOLUTE_USAGE_THRESHOLDS
): string {
  const v = Number.isFinite(value) && value > 0 ? value : 0
  if (v >= thresholds.danger) return 'var(--aipt-usage-high)'
  if (v >= thresholds.warn) return 'var(--aipt-usage-mid)'
  return 'var(--aipt-usage-low)'
}

/**
 * 统一单色取值:返回中性品牌色设计 token,不按绝对量 / 比值分档。
 *
 * 用于「会话用量明细」外层列表用量条 —— 仅以条长表达占比,绝对量三档配色下沉到详情弹窗
 * 逐轮条(见 add-session-usage-detail/design.md D5)。
 */
export function usageColorVarUnified(): string {
  return 'var(--aipt-usage-bar)'
}

/** 紧凑 token 数值:>=1M 用 M、>=1k 用 k,否则取整。 */
export function formatCompactUsage(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(Math.round(v))
}
