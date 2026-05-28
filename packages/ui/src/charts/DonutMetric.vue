<script setup lang="ts">
import { computed } from 'vue'

import { useChartTheme } from '../composables/useChartTheme'
import { VChart, type ECOption } from './echarts'

interface Slice {
  name: string
  value: number
  color?: string
}

interface DonutProps {
  data: Slice[]
  title?: string
  subtitle?: string
  /** 中心数字(可选,显示在环图中央) */
  centerValue?: string | number
  centerLabel?: string
  height?: number | string
}

const props = withDefaults(defineProps<DonutProps>(), {
  title: '',
  subtitle: '',
  centerValue: '',
  centerLabel: '',
  height: 220
})

const DEFAULT_COLORS = ['#6ea7f5', '#86c5e8', '#f0a6c8', '#9fe5d4', '#f5c489']

const { tokens: themeTokens } = useChartTheme()

const option = computed<ECOption>(() => {
  const slices = props.data.length ? props.data : [{ name: '暂无数据', value: 1 }]
  const t = themeTokens.value
  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: t.tooltipText, fontSize: 12 },
      formatter: '{b}: {c} ({d}%)'
    },
    legend: {
      show: false
    },
    series: [
      {
        type: 'pie',
        radius: ['62%', '88%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        padAngle: 3,
        itemStyle: {
          borderRadius: 8,
          borderColor: t.panelBg,
          borderWidth: 2
        },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scale: true,
          scaleSize: 6,
          itemStyle: {
            shadowBlur: 12,
            shadowColor: 'rgba(110,167,245,0.5)'
          }
        },
        data: slices.map((s, idx) => ({
          name: s.name,
          value: s.value,
          itemStyle: { color: s.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length] }
        }))
      }
    ]
  }
})
</script>

<template>
  <section class="aipt-donut aipt-glass aipt-glass--accent">
    <header v-if="title || subtitle" class="aipt-donut__header">
      <h3 class="aipt-donut__title">{{ title }}</h3>
      <p v-if="subtitle" class="aipt-donut__sub">{{ subtitle }}</p>
    </header>
    <div class="aipt-donut__chart-wrap">
      <VChart
        class="aipt-donut__chart"
        :option="option"
        :style="{ height: typeof height === 'number' ? `${height}px` : height }"
        autoresize
      />
      <div v-if="centerValue !== ''" class="aipt-donut__center">
        <div class="aipt-donut__center-value aipt-aurora-text aipt-num">{{ centerValue }}</div>
        <div v-if="centerLabel" class="aipt-donut__center-label">{{ centerLabel }}</div>
      </div>
    </div>
    <ul v-if="data.length" class="aipt-donut__legend">
      <li v-for="(item, idx) in data" :key="item.name" class="aipt-donut__legend-item">
        <span
          class="aipt-donut__swatch"
          :style="{ background: item.color ?? defaultColor(idx) }"
        ></span>
        <span class="aipt-donut__legend-name">{{ item.name }}</span>
        <span class="aipt-donut__legend-value aipt-num">{{ item.value }}</span>
      </li>
    </ul>
  </section>
</template>

<script lang="ts">
const COLORS = ['#6ea7f5', '#86c5e8', '#f0a6c8', '#9fe5d4', '#f5c489']
function defaultColor(idx: number): string {
  return COLORS[idx % COLORS.length]
}
export { defaultColor }
</script>

<style scoped>
.aipt-donut {
  padding: var(--aipt-space-5) var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aipt-donut__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-donut__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aipt-donut__sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-donut__chart-wrap {
  position: relative;
}

.aipt-donut__chart {
  width: 100%;
}

.aipt-donut__center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.aipt-donut__center-value {
  font-size: 28px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
}

.aipt-donut__center-label {
  font-size: 11px;
  color: var(--aipt-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 4px;
}

.aipt-donut__legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px;
}

.aipt-donut__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aipt-donut__swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.aipt-donut__legend-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aipt-donut__legend-value {
  color: var(--aipt-text);
  font-weight: 600;
}
</style>
