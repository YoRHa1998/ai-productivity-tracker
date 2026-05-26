<script setup lang="ts">
import { computed } from 'vue'

import { VChart, type ECOption } from './echarts'

interface SparkProps {
  /** 数据点序列(纯数字数组,长度 ≥ 2) */
  data: number[]
  /** 主色(默认极光蓝) */
  color?: string
  /** 高度,默认 40px */
  height?: number | string
}

const props = withDefaults(defineProps<SparkProps>(), {
  color: '#6ea7f5',
  height: 40
})

const option = computed<ECOption>(() => {
  const data = props.data?.length ? props.data : [0, 0]
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const padding = (max - min) * 0.2 || 1

  return {
    grid: { left: 0, right: 0, top: 4, bottom: 4 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: data.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: min - padding, max: max + padding },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        data,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, color: props.color, cap: 'round' },
        areaStyle: {
          opacity: 1,
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: hexToRgba(props.color, 0.35) },
              { offset: 1, color: hexToRgba(props.color, 0) }
            ]
          }
        }
      }
    ]
  }
})

function hexToRgba(hex: string, alpha: number): string {
  if (hex.startsWith('rgba')) return hex
  if (hex.startsWith('rgb(')) return hex.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
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
  <VChart
    class="aipt-sparkline"
    :option="option"
    :style="{ height: typeof height === 'number' ? `${height}px` : height, width: '100%' }"
    autoresize
  />
</template>

<style scoped>
.aipt-sparkline {
  pointer-events: none;
}
</style>
