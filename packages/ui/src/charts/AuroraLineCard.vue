<script setup lang="ts">
import { computed } from 'vue'

import { useChartTheme } from '../composables/useChartTheme'
import { VChart, type ECOption } from './echarts'

interface SeriesDef {
  name: string
  data: number[]
  color?: string
}

interface AuroraLineProps {
  /** x 轴文案(日期或简短 label) */
  categories: string[]
  /** 多条线 */
  series: SeriesDef[]
  /** 标题 */
  title?: string
  /** 副标题 */
  subtitle?: string
  height?: number | string
  /** y 轴刻度与 tooltip 数值的格式化函数(如 token 的 K/M 紧凑展示) */
  valueFormatter?: (value: number) => string
}

const props = withDefaults(defineProps<AuroraLineProps>(), {
  title: '',
  subtitle: '',
  height: 240,
  valueFormatter: undefined
})

const DEFAULT_COLORS = ['#6ea7f5', '#86c5e8', '#f0a6c8', '#9fe5d4']

const { tokens: themeTokens } = useChartTheme()

const option = computed<ECOption>(() => {
  const cats = props.categories?.length ? props.categories : ['']
  const t = themeTokens.value
  const fmt = props.valueFormatter
  return {
    grid: { left: 8, right: 12, top: 16, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: t.tooltipText, fontSize: 12 },
      ...(fmt ? { valueFormatter: (value) => fmt(Number(value)) } : {}),
      axisPointer: {
        type: 'line',
        lineStyle: { color: t.axisLine, type: 'dashed' }
      }
    },
    legend: {
      show: props.series.length > 1,
      top: 0,
      right: 0,
      textStyle: { color: t.subtle, fontSize: 11 },
      itemWidth: 10,
      itemHeight: 6
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: cats,
      axisLine: { lineStyle: { color: t.faint } },
      axisTick: { show: false },
      axisLabel: {
        color: t.text,
        fontSize: 10,
        margin: 8
      }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: t.faint, type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: t.text,
        fontSize: 10,
        ...(fmt ? { formatter: (value: number) => fmt(Number(value)) } : {})
      }
    },
    series: props.series.map((s, idx) => {
      const color = s.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length]
      return {
        name: s.name,
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        showSymbol: false,
        emphasis: { focus: 'series' },
        data: s.data,
        lineStyle: { width: 2, color, cap: 'round', shadowBlur: 6, shadowColor: color },
        itemStyle: { color },
        areaStyle: {
          opacity: 1,
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: hexToRgba(color, 0.32) },
              { offset: 1, color: hexToRgba(color, 0) }
            ]
          }
        }
      }
    })
  }
})

function hexToRgba(hex: string, alpha: number): string {
  if (hex.startsWith('rgba')) return hex
  const m = hex.match(/^#?([0-9a-f]{6})$/i)
  if (!m) return hex
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  return `rgba(${r},${g},${b},${alpha})`
}
</script>

<template>
  <section class="aipt-aurora-line aipt-glass aipt-glass--accent">
    <header v-if="title || subtitle" class="aipt-aurora-line__header">
      <h3 class="aipt-aurora-line__title">{{ title }}</h3>
      <p v-if="subtitle" class="aipt-aurora-line__sub">{{ subtitle }}</p>
    </header>
    <div class="aipt-aurora-line__chart">
      <VChart
        :option="option"
        :style="{ height: typeof height === 'number' ? `${height}px` : height }"
        autoresize
      />
    </div>
  </section>
</template>

<style scoped>
.aipt-aurora-line {
  padding: var(--aipt-space-5) var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aipt-aurora-line__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-aurora-line__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aipt-aurora-line__sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-aurora-line__chart {
  width: 100%;
  min-height: 240px;
}
</style>
