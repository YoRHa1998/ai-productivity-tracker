import { computed, type ComputedRef } from 'vue'

import { useTheme } from './useTheme'

/**
 * useChartTheme — 给 echarts 图表组件提供一套与 tokens.css 对齐的「文本/网格」配色。
 *
 * 背景:echarts 不消费 CSS 变量,组件里只能传具体颜色字符串。早期实现把 dark mode 下
 * 的 `rgba(220,224,235,...)` 直接硬编码到所有图表 axisLabel / nameTextStyle 上,
 * 切到浅色主题后这些极淡的灰白色完全融进白底,几乎看不见(雷达图维度名、Y 轴刻度数字
 * 都中招)。
 *
 * 这里按 `resolvedTheme` 动态返回三档对比度:
 *   - text     — 关键文字(轴标签、刻度数字、tooltip 主要文字),保证清晰可读
 *   - subtle   — 次要文字(坐标轴名 nameTextStyle、legend),不抢主体但仍可辨识
 *   - faint    — 极轻装饰(splitLine 网格 / axisLine),只做视觉引导
 * 以及 tooltip 的背景 / 边框 / 文字色。
 *
 * 颜色刻意比 `--aipt-text-*` token 略深 / 略浅一档:图表本身大多在玻璃 / 渐变面板上,
 * token 的次要色阶用在轴标签会被背景"吃掉",所以这里做了独立调优。
 */
export interface ChartThemeTokens {
  /** 轴刻度 / 主要文字 */
  text: string
  /** 坐标轴名 / legend */
  subtle: string
  /** 网格分割线 / 轻量边框 */
  faint: string
  /** 坐标轴线 */
  axisLine: string
  /** tooltip 背景 */
  tooltipBg: string
  /** tooltip 边框 */
  tooltipBorder: string
  /** tooltip 文字 */
  tooltipText: string
  /** 与图表所在面板背景近似的填充色,用于切片描边等"贴近底色"场景 */
  panelBg: string
}

const DARK_TOKENS: ChartThemeTokens = {
  text: 'rgba(235, 239, 248, 0.92)',
  subtle: 'rgba(235, 239, 248, 0.7)',
  faint: 'rgba(255, 255, 255, 0.08)',
  axisLine: 'rgba(255, 255, 255, 0.2)',
  tooltipBg: 'rgba(20, 24, 40, 0.92)',
  tooltipBorder: 'rgba(255, 255, 255, 0.12)',
  tooltipText: 'rgba(255, 255, 255, 0.92)',
  panelBg: 'rgba(7, 10, 20, 0.6)'
}

const LIGHT_TOKENS: ChartThemeTokens = {
  text: 'rgba(20, 23, 42, 0.86)',
  subtle: 'rgba(20, 23, 42, 0.62)',
  faint: 'rgba(20, 23, 42, 0.1)',
  axisLine: 'rgba(20, 23, 42, 0.22)',
  tooltipBg: 'rgba(20, 24, 40, 0.94)',
  tooltipBorder: 'rgba(255, 255, 255, 0.16)',
  tooltipText: 'rgba(255, 255, 255, 0.94)',
  panelBg: 'rgba(255, 255, 255, 0.85)'
}

export function useChartTheme(): { tokens: ComputedRef<ChartThemeTokens> } {
  const { resolvedTheme } = useTheme()
  const tokens = computed<ChartThemeTokens>(() =>
    resolvedTheme.value === 'light' ? LIGHT_TOKENS : DARK_TOKENS
  )
  return { tokens }
}
