<script setup lang="ts">
import { computed } from 'vue'

import { useChartTheme } from '../composables/useChartTheme'
import { VChart, type ECOption } from './echarts'

/**
 * v1.0.0-rc.23 复盘报告 5 维雷达图。
 *
 * 每个维度独立 max(归一化由调用方负责),value 超过 max 时自动 clamp 到 max,
 * value < 0 视为 0。max <= 0 时该维度按 1 处理(避免除零)。
 */
export interface RadarDimension {
  name: string
  /** 当前值(越大越好) */
  value: number
  /** 该维度的「满分线」,雷达图按此渲染最外圈刻度 */
  max: number
}

interface RadarProps {
  dimensions: RadarDimension[]
  title?: string
  subtitle?: string
  height?: number | string
  /** 系列名称,鼠标悬停时显示 */
  seriesName?: string
}

const props = withDefaults(defineProps<RadarProps>(), {
  title: '',
  subtitle: '',
  height: 260,
  seriesName: '复盘指标'
})

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  if (max <= 0) return 0
  return value > max ? max : value
}

const indicators = computed(() =>
  props.dimensions.map((d) => ({
    name: d.name,
    max: d.max > 0 ? d.max : 1
  }))
)

const values = computed(() => props.dimensions.map((d) => clamp(d.value, d.max)))

const { tokens: themeTokens } = useChartTheme()

const option = computed<ECOption>(() => {
  const t = themeTokens.value
  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: t.tooltipText, fontSize: 12 },
      formatter: () => {
        const lines = [`<strong>${props.seriesName}</strong>`]
        for (let i = 0; i < props.dimensions.length; i += 1) {
          const dim = props.dimensions[i]
          lines.push(
            `${dim.name}: ${values.value[i].toFixed(2)} / ${(dim.max > 0 ? dim.max : 1).toFixed(2)}`
          )
        }
        return lines.join('<br/>')
      }
    },
    radar: {
      indicator: indicators.value,
      shape: 'polygon',
      splitNumber: 4,
      axisName: {
        color: t.text,
        fontSize: 12,
        fontWeight: 600
      },
      axisLine: {
        lineStyle: { color: t.axisLine }
      },
      splitLine: {
        lineStyle: { color: t.faint }
      },
      splitArea: {
        areaStyle: {
          color: ['rgba(110,167,245,0.04)', 'rgba(110,167,245,0.08)']
        }
      }
    },
    series: [
      {
        type: 'radar',
        name: props.seriesName,
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { width: 2, color: '#6ea7f5' },
        areaStyle: { color: 'rgba(110,167,245,0.22)' },
        itemStyle: { color: '#6ea7f5' },
        data: [
          {
            value: values.value,
            name: props.seriesName
          }
        ]
      }
    ]
  }
})
</script>

<template>
  <section class="aipt-radar aipt-glass aipt-glass--accent">
    <header v-if="title || subtitle" class="aipt-radar__header">
      <h3 class="aipt-radar__title">{{ title }}</h3>
      <p v-if="subtitle" class="aipt-radar__sub">{{ subtitle }}</p>
    </header>
    <VChart
      class="aipt-radar__chart"
      :option="option"
      :style="{ height: typeof height === 'number' ? `${height}px` : height }"
      autoresize
    />
  </section>
</template>

<style scoped>
.aipt-radar {
  padding: var(--aipt-space-5) var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aipt-radar__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-radar__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aipt-radar__sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-radar__chart {
  width: 100%;
}
</style>
