<script setup lang="ts">
import { computed } from 'vue'

import {
  DEFAULT_USAGE_THRESHOLDS,
  formatCompactUsage,
  usageColorVar,
  usageRatio,
  usageWidthPct,
  type UsageThresholds
} from './usage-bar-logic'

/**
 * 可复用「用量指示条」:条长按 value 相对当前列表 max 归一化,颜色按高低分绿/橙/红三档。
 *
 * - 条长 width% = clamp(value / max, 0, 1) * 100;max<=0 时全部 0 宽。
 * - 颜色:ratio = value / max;ratio >= danger(默认 0.66) → 红;>= warn(默认 0.33) → 橙;否则绿。
 * - 颜色取设计 token(--aipt-usage-low/mid/high,亮暗各一套),不写死色值。
 * - 条上叠加紧凑数值 + aria-label,供「AI 用量」会话列表与「用量测算」记录列表共用。
 */
const props = withDefaults(
  defineProps<{
    value: number
    max: number
    thresholds?: UsageThresholds
  }>(),
  { thresholds: () => ({ ...DEFAULT_USAGE_THRESHOLDS }) }
)

const widthPct = computed(() => usageWidthPct(props.value, props.max))
const colorVar = computed(() => usageColorVar(usageRatio(props.value, props.max), props.thresholds))
const label = computed(() => formatCompactUsage(props.value))
</script>

<template>
  <div
    class="aipt-usage-bar"
    role="meter"
    :aria-valuenow="props.value"
    :aria-valuemin="0"
    :aria-valuemax="props.max > 0 ? props.max : props.value"
    :aria-label="`用量 ${label}`"
  >
    <div class="aipt-usage-bar__track">
      <div class="aipt-usage-bar__fill" :style="{ width: widthPct, background: colorVar }" />
    </div>
    <span class="aipt-usage-bar__num aipt-num">{{ label }}</span>
  </div>
</template>

<style scoped>
.aipt-usage-bar {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  min-width: 0;
}

.aipt-usage-bar__track {
  position: relative;
  flex: 1 1 auto;
  height: 8px;
  min-width: 40px;
  border-radius: var(--aipt-radius-pill);
  background: var(--aipt-surface-strong);
  overflow: hidden;
}

.aipt-usage-bar__fill {
  height: 100%;
  border-radius: var(--aipt-radius-pill);
  transition:
    width var(--aipt-duration-base) var(--aipt-easing-out),
    background var(--aipt-duration-base);
}

.aipt-usage-bar__num {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--aipt-text-secondary);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  text-align: right;
}
</style>
