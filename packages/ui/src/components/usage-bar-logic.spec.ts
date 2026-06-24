import { describe, it, expect } from 'vitest'

import { formatCompactUsage, usageColorVar, usageRatio, usageWidthPct } from './usage-bar-logic'

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

  it('紧凑数值格式化', () => {
    expect(formatCompactUsage(500)).toBe('500')
    expect(formatCompactUsage(1500)).toBe('1.5k')
    expect(formatCompactUsage(12000)).toBe('12k')
    expect(formatCompactUsage(2_500_000)).toBe('2.5M')
    expect(formatCompactUsage(0)).toBe('0')
    expect(formatCompactUsage(-5)).toBe('0')
  })
})
