<script setup lang="ts">
import { computed } from 'vue'

import { VChart, type ECOption } from './echarts'

/**
 * v1.0.0-rc.23 iteration 阶段时间线条形图。
 *
 * 数据语义:
 * - 横轴 = iteration seq(1, 2, 3, ...)
 * - 纵轴 = 该轮 thinkSeconds(秒)
 * - 颜色 = 所属 phase(超出 phase 范围的轮次走灰色"未分类")
 *
 * 适用场景:复盘报告里直观对比"哪个阶段思考最久 / 哪轮最耗时"。
 */

export interface IterationTimelineRow {
  seq: number
  /** 本轮 think 秒数(<= 0 时按 0 渲染,但仍占位) */
  thinkSeconds: number
  /** 一句话总结(用于 tooltip);可为空字符串 */
  oneLine?: string
}

export interface IterationTimelinePhase {
  title: string
  iterationSeqRange: [number, number]
}

interface TimelineProps {
  iterations: IterationTimelineRow[]
  phases: IterationTimelinePhase[]
  title?: string
  subtitle?: string
  height?: number | string
}

const props = withDefaults(defineProps<TimelineProps>(), {
  title: '',
  subtitle: '',
  height: 220
})

const PHASE_COLORS = ['#6ea7f5', '#9fe5d4', '#f5c489', '#f0a6c8', '#86c5e8']
const UNCLASSIFIED_COLOR = 'rgba(255,255,255,0.18)'

interface BarItem {
  seq: number
  value: number
  oneLine: string
  phaseTitle: string
  phaseColor: string
}

const items = computed<BarItem[]>(() => {
  const rows = [...props.iterations].sort((a, b) => a.seq - b.seq)
  return rows.map((row) => {
    let phaseTitle = '未分类'
    let phaseColor = UNCLASSIFIED_COLOR
    for (let i = 0; i < props.phases.length; i += 1) {
      const phase = props.phases[i]
      if (
        Array.isArray(phase.iterationSeqRange) &&
        phase.iterationSeqRange.length === 2 &&
        row.seq >= phase.iterationSeqRange[0] &&
        row.seq <= phase.iterationSeqRange[1]
      ) {
        phaseTitle = phase.title
        phaseColor = PHASE_COLORS[i % PHASE_COLORS.length]
        break
      }
    }
    return {
      seq: row.seq,
      value: row.thinkSeconds > 0 ? row.thinkSeconds : 0,
      oneLine: row.oneLine ?? '',
      phaseTitle,
      phaseColor
    }
  })
})

const option = computed<ECOption>(() => ({
  tooltip: {
    trigger: 'item',
    backgroundColor: 'rgba(20, 24, 40, 0.92)',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    textStyle: { color: 'rgba(255,255,255,0.92)', fontSize: 12 },
    formatter: (params: unknown) => {
      const p = params as { dataIndex: number }
      const row = items.value[p.dataIndex]
      if (!row) return ''
      const lines = [
        `<strong>iteration #${row.seq}</strong> · ${row.phaseTitle}`,
        `思考时长: ${row.value.toFixed(1)} s`
      ]
      if (row.oneLine) lines.push(`一句话: ${escapeHtml(row.oneLine)}`)
      return lines.join('<br/>')
    }
  },
  grid: {
    left: 16,
    right: 16,
    top: 12,
    bottom: 28,
    containLabel: true
  },
  xAxis: {
    type: 'category',
    data: items.value.map((row) => `#${row.seq}`),
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
    axisLabel: { color: 'rgba(220,224,235,0.7)', fontSize: 11 },
    axisTick: { show: false }
  },
  yAxis: {
    type: 'value',
    name: 'thinkSeconds',
    nameTextStyle: { color: 'rgba(220,224,235,0.55)', fontSize: 11, padding: [0, 0, 0, -8] },
    axisLine: { show: false },
    axisLabel: { color: 'rgba(220,224,235,0.6)', fontSize: 11 },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }
  },
  series: [
    {
      type: 'bar',
      barMaxWidth: 28,
      itemStyle: {
        borderRadius: [4, 4, 0, 0]
      },
      data: items.value.map((row) => ({
        value: row.value,
        itemStyle: { color: row.phaseColor }
      }))
    }
  ]
}))

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
      default:
        return c
    }
  })
}

const legendItems = computed(() =>
  props.phases.map((phase, idx) => ({
    name: phase.title,
    range: `#${phase.iterationSeqRange[0]}–#${phase.iterationSeqRange[1]}`,
    color: PHASE_COLORS[idx % PHASE_COLORS.length]
  }))
)
</script>

<template>
  <section class="aipt-timeline aipt-glass aipt-glass--accent">
    <header v-if="title || subtitle" class="aipt-timeline__header">
      <h3 class="aipt-timeline__title">{{ title }}</h3>
      <p v-if="subtitle" class="aipt-timeline__sub">{{ subtitle }}</p>
    </header>
    <VChart
      class="aipt-timeline__chart"
      :option="option"
      :style="{ height: typeof height === 'number' ? `${height}px` : height }"
      autoresize
    />
    <ul v-if="legendItems.length" class="aipt-timeline__legend">
      <li
        v-for="item in legendItems"
        :key="`${item.name}-${item.range}`"
        class="aipt-timeline__legend-item"
      >
        <span class="aipt-timeline__swatch" :style="{ background: item.color }"></span>
        <span class="aipt-timeline__legend-name">{{ item.name }}</span>
        <span class="aipt-timeline__legend-range">{{ item.range }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.aipt-timeline {
  padding: var(--aipt-space-5) var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aipt-timeline__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-timeline__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aipt-timeline__sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-timeline__chart {
  width: 100%;
}

.aipt-timeline__legend {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
}

.aipt-timeline__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aipt-timeline__swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}

.aipt-timeline__legend-range {
  font-variant-numeric: tabular-nums;
  color: var(--aipt-text-muted);
}
</style>
