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

/** 紧凑 token 数值:>=1M 用 M、>=1k 用 k,否则取整。 */
export function formatCompactUsage(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(Math.round(v))
}
