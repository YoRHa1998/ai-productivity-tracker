import { describe, it, expect } from 'vitest'

import {
  DEFAULT_ABSOLUTE_USAGE_THRESHOLDS,
  formatCompactUsage,
  usageColorVar,
  usageColorVarAbsolute,
  usageColorVarUnified,
  usageRatio,
  usageWidthPct
} from './usage-bar-logic'

describe('usage-bar-logic', () => {
  it('value/max 归一化:按比例 + clamp 到 [0,1]', () => {
    expect(usageRatio(50, 100)).toBe(0.5)
    expect(usageRatio(150, 100)).toBe(1) // 超出满格
    expect(usageWidthPct(25, 100)).toBe('25.0%')
    expect(usageWidthPct(100, 100)).toBe('100.0%') // 单条满格
  })

  it('max<=0 兜底:0 宽 + 绿档', () => {
    expect(usageRatio(10, 0)).toBe(0)
    expect(usageRatio(10, -5)).toBe(0)
    expect(usageWidthPct(10, 0)).toBe('0.0%')
    expect(usageColorVar(usageRatio(10, 0))).toBe('var(--aipt-usage-low)')
  })

  it('三档阈值取色:danger>=0.66 红 / warn>=0.33 橙 / 否则绿', () => {
    expect(usageColorVar(0.9)).toBe('var(--aipt-usage-high)')
    expect(usageColorVar(0.66)).toBe('var(--aipt-usage-high)')
    expect(usageColorVar(0.5)).toBe('var(--aipt-usage-mid)')
    expect(usageColorVar(0.33)).toBe('var(--aipt-usage-mid)')
    expect(usageColorVar(0.1)).toBe('var(--aipt-usage-low)')
    expect(usageColorVar(0)).toBe('var(--aipt-usage-low)')
  })

  it('自定义阈值覆盖默认', () => {
    expect(usageColorVar(0.5, { warn: 0.5, danger: 0.8 })).toBe('var(--aipt-usage-mid)')
    expect(usageColorVar(0.85, { warn: 0.5, danger: 0.8 })).toBe('var(--aipt-usage-high)')
  })

  it('绝对配色:>=300K 红 / >=150K 橙 / <150K 绿(边界值)', () => {
    expect(usageColorVarAbsolute(300_000)).toBe('var(--aipt-usage-high)')
    expect(usageColorVarAbsolute(500_000)).toBe('var(--aipt-usage-high)')
    expect(usageColorVarAbsolute(299_999)).toBe('var(--aipt-usage-mid)')
    expect(usageColorVarAbsolute(150_000)).toBe('var(--aipt-usage-mid)')
    expect(usageColorVarAbsolute(149_999)).toBe('var(--aipt-usage-low)')
    expect(usageColorVarAbsolute(0)).toBe('var(--aipt-usage-low)')
    expect(usageColorVarAbsolute(-5)).toBe('var(--aipt-usage-low)')
  })

  it('绝对配色与条长分母无关:小占比但绝对量大仍红', () => {
    // 条长 ratio 很小(value/max 远 < danger),但绝对值 >= 300K → 仍红
    expect(usageRatio(300_000, 10_000_000)).toBeLessThan(0.1)
    expect(usageColorVarAbsolute(300_000)).toBe('var(--aipt-usage-high)')
  })

  it('绝对阈值默认常量为 150K / 300K', () => {
    expect(DEFAULT_ABSOLUTE_USAGE_THRESHOLDS).toEqual({ warn: 150_000, danger: 300_000 })
  })

  it('绝对配色自定义阈值覆盖默认', () => {
    expect(usageColorVarAbsolute(60_000, { warn: 50_000, danger: 100_000 })).toBe(
      'var(--aipt-usage-mid)'
    )
    expect(usageColorVarAbsolute(120_000, { warn: 50_000, danger: 100_000 })).toBe(
      'var(--aipt-usage-high)'
    )
  })

  it('默认 ratio 模式取色与改前一致(benchmark 零回归)', () => {
    // 既有相对配色逻辑断言不变:0.66/0.33 阈值
    expect(usageColorVar(usageRatio(70, 100))).toBe('var(--aipt-usage-high)')
    expect(usageColorVar(usageRatio(40, 100))).toBe('var(--aipt-usage-mid)')
    expect(usageColorVar(usageRatio(10, 100))).toBe('var(--aipt-usage-low)')
  })

  it('统一单色:返回中性品牌色 token,不分档(外层会话列表用)', () => {
    expect(usageColorVarUnified()).toBe('var(--aipt-usage-bar)')
  })

  it('紧凑数值格式化', () => {
    expect(formatCompactUsage(500)).toBe('500')
    expect(formatCompactUsage(1500)).toBe('1.5k')
    expect(formatCompactUsage(12000)).toBe('12k')
    expect(formatCompactUsage(2_500_000)).toBe('2.5M')
    expect(formatCompactUsage(0)).toBe('0')
    expect(formatCompactUsage(-5)).toBe('0')
  })
})
