<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElButton, ElSwitch, ElMessage, ElRadioGroup, ElRadioButton, ElEmpty } from 'element-plus'

import {
  AgentRequestError,
  fetchAiUsage,
  patchAiUsageConfig,
  AI_USAGE_SOURCES,
  type AiUsageResponse,
  type AiUsageSource
} from '../api'
import AuroraLineCard from '../charts/AuroraLineCard.vue'

const DAYS = 14

/** 各 AI 趋势线配色(与卡片左侧色点一致)。 */
const SOURCE_COLOR: Record<AiUsageSource, string> = {
  cursor: '#6ea7f5',
  'claude-code': '#f0a6c8',
  codex: '#9fe5d4'
}

const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const data = ref<AiUsageResponse | null>(null)

/** 趋势图维度:token 总量(默认)或对话次数。 */
const metric = ref<'tokens' | 'turns'>('tokens')

const enabled = computed(() => data.value?.enabled ?? false)

const todayCards = computed(() =>
  AI_USAGE_SOURCES.map((s) => {
    const view = data.value?.today?.[s.key]
    return {
      key: s.key,
      label: s.label,
      color: SOURCE_COLOR[s.key],
      totalTokens: view?.totalTokens ?? 0,
      turns: view?.turns ?? 0
    }
  })
)

/** 是否已有任何用量数据(决定空态展示)。 */
const hasAnyData = computed(() => {
  const d = data.value
  if (!d) return false
  const todayHas = AI_USAGE_SOURCES.some((s) => {
    const v = d.today[s.key]
    return v && (v.totalTokens > 0 || v.turns > 0)
  })
  if (todayHas) return true
  return d.series.some((point) =>
    AI_USAGE_SOURCES.some((s) => {
      const v = point[s.key]
      return v && (v.totalTokens > 0 || v.turns > 0)
    })
  )
})

const chartCategories = computed(
  () => (data.value?.series ?? []).map((p) => p.date.slice(5)) // MM-DD
)

const chartSeries = computed(() => {
  const series = data.value?.series ?? []
  return AI_USAGE_SOURCES.map((s) => ({
    name: s.label,
    color: SOURCE_COLOR[s.key],
    data: series.map((point) => {
      const v = point[s.key]
      if (!v) return 0
      return metric.value === 'tokens' ? v.totalTokens : v.turns
    })
  }))
})

const chartSubtitle = computed(() =>
  metric.value === 'tokens' ? `近 ${DAYS} 天各 AI 有效 token 消耗` : `近 ${DAYS} 天各 AI 对话次数`
)

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchAiUsage(DAYS)
  } catch (err) {
    error.value = err instanceof AgentRequestError ? err.message : (err as Error).message
  } finally {
    loading.value = false
  }
}

async function onToggle(next: boolean) {
  saving.value = true
  try {
    const config = await patchAiUsageConfig({ enabled: next })
    if (data.value) data.value.enabled = config.enabled
    ElMessage.success(config.enabled ? '已开启 AI 整体用量监控' : '已关闭 AI 整体用量监控')
    // 重新拉取,保证开关与数据一致
    await load()
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
    // 切换失败时回滚 UI 状态
    if (data.value) data.value.enabled = !next
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <section class="aip-usage">
    <header class="aip-usage__page-header">
      <div class="aip-usage__heading">
        <h1 class="aip-usage__page-title aipt-aurora-text">AI 用量</h1>
        <p class="aip-usage__page-sub">
          跨需求、跨分支的全局视图:每个 AI 工具当天与近 {{ DAYS }} 天的 token 消耗与对话次数
        </p>
      </div>
      <div class="aip-usage__heading-actions">
        <div class="aip-usage__switch">
          <span class="aip-usage__switch-label">采集监控</span>
          <ElSwitch
            :model-value="enabled"
            :loading="saving"
            :disabled="loading"
            @update:model-value="(v: string | number | boolean) => onToggle(Boolean(v))"
          />
        </div>
        <ElButton size="small" :loading="loading" type="primary" @click="load">刷新</ElButton>
      </div>
    </header>

    <div v-if="error" class="aip-usage__error aipt-glass">
      <span>{{ error }}</span>
      <ElButton size="small" @click="load">重试</ElButton>
    </div>

    <template v-else>
      <div class="aip-usage__cards">
        <article
          v-for="card in todayCards"
          :key="card.key"
          class="aip-usage__card aipt-glass aipt-glow"
        >
          <div class="aip-usage__card-head">
            <span class="aip-usage__card-dot" :style="{ background: card.color }" />
            <span class="aip-usage__card-label">{{ card.label }}</span>
          </div>
          <div class="aip-usage__card-metric">
            <span class="aip-usage__card-value aipt-num">{{ formatNumber(card.totalTokens) }}</span>
            <span class="aip-usage__card-unit">今日 token</span>
          </div>
          <div class="aip-usage__card-foot">
            <span class="aipt-num">{{ formatNumber(card.turns) }}</span> 次对话
          </div>
        </article>
      </div>

      <div class="aip-usage__chart-section">
        <div class="aip-usage__chart-head">
          <div class="aip-usage__chart-title">用量趋势</div>
          <ElRadioGroup v-model="metric" size="small">
            <ElRadioButton value="tokens">Token</ElRadioButton>
            <ElRadioButton value="turns">对话次数</ElRadioButton>
          </ElRadioGroup>
        </div>

        <div v-if="!enabled && !hasAnyData" class="aip-usage__empty aipt-glass">
          <ElEmpty description="尚未开启 AI 整体用量监控">
            <ElButton type="primary" :loading="saving" @click="onToggle(true)">开启监控</ElButton>
          </ElEmpty>
        </div>
        <div v-else-if="!hasAnyData" class="aip-usage__empty aipt-glass">
          <ElEmpty description="监控已开启,产生新对话后这里会显示用量趋势" />
        </div>
        <AuroraLineCard
          v-else
          :categories="chartCategories"
          :series="chartSeries"
          :subtitle="chartSubtitle"
          :height="300"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.aip-usage {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-5);
  padding: var(--aipt-space-5);
}

.aip-usage__page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-usage__heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.aip-usage__page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.aip-usage__page-sub {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-muted);
}

.aip-usage__heading-actions {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-4);
}

.aip-usage__switch {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aip-usage__switch-label {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-usage__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-4) var(--aipt-space-5);
  color: var(--aipt-text-strong);
  font-size: 13px;
}

.aip-usage__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--aipt-space-4);
}

.aip-usage__card {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-5);
}

.aip-usage__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aip-usage__card-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 8px currentColor;
}

.aip-usage__card-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong);
}

.aip-usage__card-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aip-usage__card-value {
  font-size: 28px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--aipt-text-strong);
}

.aip-usage__card-unit {
  font-size: 11px;
  color: var(--aipt-text-muted);
}

.aip-usage__card-foot {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-usage__chart-section {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aip-usage__chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-usage__chart-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-usage__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  padding: var(--aipt-space-5);
}
</style>
