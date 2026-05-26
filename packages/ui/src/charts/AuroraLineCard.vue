<script setup lang="ts">
import { computed } from 'vue'

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
}

const props = withDefaults(defineProps<AuroraLineProps>(), {
  title: '',
  subtitle: '',
  height: 240
})

const DEFAULT_COLORS = ['#6ea7f5', '#86c5e8', '#f0a6c8', '#9fe5d4']

const option = computed<ECOption>(() => {
  const cats = props.categories?.length ? props.categories : ['']
  return {
    grid: { left: 8, right: 12, top: 16, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20, 24, 40, 0.92)',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      textStyle: { color: 'rgba(255,255,255,0.92)', fontSize: 12 },
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(255,255,255,0.18)', type: 'dashed' }
      }
    },
    legend: {
      show: props.series.length > 1,
      top: 0,
      right: 0,
      textStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
      itemWidth: 10,
      itemHeight: 6
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: cats,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
      axisTick: { show: false },
      axisLabel: {
        color: 'rgba(255,255,255,0.45)',
        fontSize: 10,
        margin: 8
      }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 10 }
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
