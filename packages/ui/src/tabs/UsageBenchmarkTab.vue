<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDialog,
  ElDrawer,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElEmpty,
  ElRadioButton,
  ElRadioGroup,
  ElTag
} from 'element-plus'
import { useRouter } from 'vue-router'

import {
  AgentRequestError,
  fetchUsageBenchmark,
  fetchSessionUsage,
  startUsageBenchmark,
  stopUsageBenchmark,
  cancelUsageBenchmark,
  deleteUsageBenchmark,
  AI_USAGE_SOURCES,
  type AiUsageSource,
  type SessionUsageView,
  type UsageBenchmarkSession,
  type UsageBenchmarkState
} from '../api'
import { useChartTheme } from '../composables/useChartTheme'
import { VChart, type ECOption } from '../charts/echarts'
import SessionUsageRow from '../components/SessionUsageRow.vue'
import UsageBar from '../components/UsageBar.vue'

const router = useRouter()

const SOURCE_COLOR: Record<AiUsageSource, string> = {
  cursor: '#6ea7f5',
  'claude-code': '#f0a6c8',
  codex: '#9fe5d4'
}
const SOURCE_LABEL: Record<AiUsageSource, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

const loading = ref(false)
const starting = ref(false)
const stopping = ref(false)
const error = ref<string | null>(null)
const state = ref<UsageBenchmarkState | null>(null)

/** 启动表单:多选工具 + 可选标签。默认全选,便于一键测算。 */
const selectedSources = ref<AiUsageSource[]>(['cursor', 'claude-code', 'codex'])
const label = ref('')

/** 实时计时:每秒刷新一个 now 时间戳驱动 elapsed 展示。 */
const nowTs = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 历史对比:被勾选参与对比的记录 id 集合。 */
const compareIds = ref<Set<string>>(new Set())

/** 对比用量弹窗开关:勾选 ≥2 条后点「对比用量」按钮打开。 */
const compareOpen = ref(false)

const active = computed(() => state.value?.active ?? null)
const sessions = computed(() => state.value?.sessions ?? [])
const hasActive = computed(() => active.value !== null)

const elapsedMs = computed(() => {
  if (!active.value) return 0
  const started = Date.parse(active.value.startedAt)
  if (!Number.isFinite(started)) return 0
  return Math.max(0, nowTs.value - started)
})

/** 进行中会话各工具滚动用量(按所选 sources 顺序)。 */
const activeRows = computed(() => {
  const a = active.value
  if (!a) return []
  return a.sources.map((s) => {
    const t = a.totals[s]
    return {
      key: s,
      label: SOURCE_LABEL[s],
      color: SOURCE_COLOR[s],
      total: t?.total ?? 0,
      turns: t?.turns ?? 0
    }
  })
})

const compareSessions = computed(() => sessions.value.filter((s) => compareIds.value.has(s.id)))

const canCompare = computed(() => compareSessions.value.length >= 2)

/** 历史记录排序:最近(既有 endedAt 倒序)/ 用量高→低 / 用量低→高(前端本地排序)。 */
const historySort = ref<'recent' | 'usage-desc' | 'usage-asc'>('recent')

const sortedSessions = computed(() => {
  const list = [...sessions.value]
  if (historySort.value === 'usage-desc') list.sort((a, b) => sessionGrand(b) - sessionGrand(a))
  else if (historySort.value === 'usage-asc') list.sort((a, b) => sessionGrand(a) - sessionGrand(b))
  // 'recent' 保持服务端 endedAt 倒序原序
  return list
})

/** 历史记录列表内最大 grandTotal,作 UsageBar 归一化 max。 */
const historyMaxGrand = computed(() =>
  sessions.value.reduce((m, s) => (sessionGrand(s) > m ? sessionGrand(s) : m), 0)
)

/** 对比区内最大 grandTotal,作 UsageBar 归一化 max。 */
const compareMaxGrand = computed(() =>
  compareSessions.value.reduce((m, s) => (sessionGrand(s) > m ? sessionGrand(s) : m), 0)
)

const { tokens: themeTokens } = useChartTheme()

/** 对比柱状图:x 轴 = 记录,series = 各 AI 工具 token 合计。 */
const compareOption = computed<ECOption>(() => {
  const list = compareSessions.value
  const tk = themeTokens.value
  const cats = list.map((s, i) => s.label || `记录 ${i + 1}`)
  const series = AI_USAGE_SOURCES.map((src) => ({
    name: src.label,
    type: 'bar' as const,
    itemStyle: {
      color: SOURCE_COLOR[src.key],
      borderRadius: [4, 4, 0, 0] as [number, number, number, number]
    },
    data: list.map((s) => s.totals[src.key]?.total ?? 0)
  }))
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: tk.tooltipBg,
      borderColor: tk.tooltipBorder,
      textStyle: { color: tk.tooltipText },
      valueFormatter: (v) => formatNumber(Number(v))
    },
    legend: { textStyle: { color: tk.subtle }, top: 0 },
    grid: { left: 12, right: 16, bottom: 8, top: 36, containLabel: true },
    xAxis: {
      type: 'category',
      data: cats,
      axisLabel: { color: tk.text },
      axisLine: { lineStyle: { color: tk.axisLine } }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: tk.text, formatter: (v: number) => formatCompactTokens(v) },
      splitLine: { lineStyle: { color: tk.faint } }
    },
    series
  }
})

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatCompactTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const units = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' }
  ]
  for (const { value, suffix } of units) {
    if (abs >= value) {
      const scaled = Math.round((n / value) * 10) / 10
      return `${scaled}${suffix}`
    }
  }
  return String(n)
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sessionGrand(session: UsageBenchmarkSession): number {
  return session.grandTotal?.total ?? 0
}

async function load() {
  loading.value = true
  error.value = null
  try {
    state.value = await fetchUsageBenchmark()
  } catch (err) {
    error.value = err instanceof AgentRequestError ? err.message : (err as Error).message
  } finally {
    loading.value = false
  }
}

async function onStart() {
  if (selectedSources.value.length === 0) {
    ElMessage.warning('至少选择一个 AI 工具')
    return
  }
  starting.value = true
  try {
    await startUsageBenchmark({
      label: label.value.trim() || undefined,
      sources: selectedSources.value
    })
    label.value = ''
    await load()
    ElMessage.success('已开始记录')
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  } finally {
    starting.value = false
  }
}

async function onStop() {
  stopping.value = true
  try {
    await stopUsageBenchmark()
    await load()
    ElMessage.success('已结束记录')
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  } finally {
    stopping.value = false
  }
}

async function onCancel() {
  try {
    await ElMessageBox.confirm('取消后本次记录将被丢弃,确定?', '取消记录', {
      type: 'warning',
      confirmButtonText: '取消记录',
      cancelButtonText: '继续记录'
    })
  } catch {
    return
  }
  try {
    await cancelUsageBenchmark()
    await load()
    ElMessage.success('已取消记录')
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  }
}

async function onDelete(session: UsageBenchmarkSession) {
  try {
    await ElMessageBox.confirm('删除该测算记录?此操作不可恢复', '删除记录', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await deleteUsageBenchmark(session.id)
    compareIds.value.delete(session.id)
    await load()
    ElMessage.success('已删除')
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  }
}

function toggleCompare(id: string) {
  const next = new Set(compareIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  compareIds.value = next
}

// ───────────────────────── 记录详情(下钻窗口内各会话实际消耗) ─────────────────────────

/** 详情抽屉开关 + 当前记录 + 反查到的会话明细(按 total 倒序)。 */
const detailOpen = ref(false)
const detailSession = ref<UsageBenchmarkSession | null>(null)
const detailLoading = ref(false)
const detailRows = ref<SessionUsageView[]>([])
/** 记录落盘的 sessionId 总数(跨来源 keys 数量),用于「不可解析」计数。 */
const detailTotalSessions = ref(0)

/** 详情头部:各来源 token 合计(按记录 sources 顺序)+ 跨来源合计。 */
const detailSourceRows = computed(() => {
  const s = detailSession.value
  if (!s) return []
  return s.sources.map((src) => ({
    key: src,
    label: SOURCE_LABEL[src],
    color: SOURCE_COLOR[src],
    total: s.totals[src]?.total ?? 0
  }))
})

const detailGrand = computed(() => detailSession.value?.grandTotal?.total ?? 0)

/** 详情会话列表 total 最大值,作 UsageBar 归一化 max。 */
const detailMaxTotal = computed(() =>
  detailRows.value.reduce((m, s) => (s.totalTokens > m ? s.totalTokens : m), 0)
)

/** 记录持有但会话维度 store 反查不到的 sessionId 数(采集开关曾关 / 已被保留上限裁剪)。 */
const detailUnresolved = computed(() =>
  Math.max(0, detailTotalSessions.value - detailRows.value.length)
)

/** 把记录各来源去重 sessionId 汇总成 `${source}:${sessionId}` key 集合。 */
function collectSessionKeys(session: UsageBenchmarkSession): string[] {
  const keys: string[] = []
  for (const [src, totals] of Object.entries(session.totals)) {
    const ids = totals?.sessionIds
    if (!Array.isArray(ids)) continue
    for (const id of ids) {
      if (typeof id === 'string' && id) keys.push(`${src}:${id}`)
    }
  }
  return keys
}

async function openDetail(session: UsageBenchmarkSession) {
  detailSession.value = session
  detailOpen.value = true
  detailLoading.value = true
  detailRows.value = []
  const keys = collectSessionKeys(session)
  detailTotalSessions.value = keys.length
  if (keys.length === 0) {
    detailLoading.value = false
    return
  }
  try {
    // Path A:按记录落盘 sessionId 精确反查,不依赖时间窗近似;keys 在服务端排序/截断之前施加。
    const res = await fetchSessionUsage({ keys, limit: 1000 })
    detailRows.value = [...res.sessions].sort((a, b) => b.totalTokens - a.totalTokens)
  } catch {
    // 反查失败不阻断面板,留空走兜底空态
    detailRows.value = []
  } finally {
    detailLoading.value = false
  }
}

function onDetailClosed() {
  detailSession.value = null
  detailRows.value = []
  detailTotalSessions.value = 0
}

function gotoRequirement(jiraKey: string) {
  void router.push({ path: '/workspace', query: { jira: jiraKey } })
}

onMounted(() => {
  void load()
  tickTimer = setInterval(() => {
    nowTs.value = Date.now()
  }, 1000)
  // 进行中时轮询刷新滚动用量
  pollTimer = setInterval(() => {
    if (hasActive.value && !loading.value) void load()
  }, 4000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <section class="aip-bmk">
    <header class="aip-bmk__page-header">
      <div class="aip-bmk__heading">
        <h1 class="aip-bmk__page-title aipt-aurora-text">用量测算</h1>
        <p class="aip-bmk__page-sub">
          秒表式圈定一段时间窗,测量选定 AI 工具的 token 用量;调整 skill / prompt
          后再测一段,并排对比提效效果
        </p>
      </div>
      <ElButton size="small" :loading="loading" @click="load">刷新</ElButton>
    </header>

    <div v-if="error" class="aip-bmk__error aipt-glass">
      <span>{{ error }}</span>
      <ElButton size="small" @click="load">重试</ElButton>
    </div>

    <!-- 控制区 -->
    <div class="aip-bmk__control aipt-glass aipt-glow">
      <template v-if="!hasActive">
        <div class="aip-bmk__control-row">
          <span class="aip-bmk__control-label">记录工具</span>
          <ElCheckboxGroup v-model="selectedSources">
            <ElCheckbox v-for="s in AI_USAGE_SOURCES" :key="s.key" :value="s.key">
              {{ s.label }}
            </ElCheckbox>
          </ElCheckboxGroup>
        </div>
        <div class="aip-bmk__control-row">
          <span class="aip-bmk__control-label">标签</span>
          <ElInput
            v-model="label"
            placeholder="可选,如「优化前」"
            size="default"
            maxlength="60"
            style="max-width: 280px"
          />
        </div>
        <div class="aip-bmk__control-actions">
          <ElButton
            type="primary"
            :loading="starting"
            :disabled="selectedSources.length === 0"
            @click="onStart"
          >
            <span class="i-lucide-play aip-bmk__btn-icon" />开始记录
          </ElButton>
        </div>
      </template>

      <template v-else>
        <div class="aip-bmk__running">
          <div class="aip-bmk__running-left">
            <div class="aip-bmk__running-status">
              <span class="aip-bmk__pulse" />
              <span class="aip-bmk__running-text">记录进行中</span>
              <span v-if="active?.label" class="aip-bmk__running-label">{{ active.label }}</span>
            </div>
            <div class="aip-bmk__timer aipt-num">{{ formatDuration(elapsedMs) }}</div>
            <div class="aip-bmk__running-sources">
              <ElTag
                v-for="row in activeRows"
                :key="row.key"
                size="small"
                effect="plain"
                :style="{ borderColor: row.color, color: row.color }"
              >
                {{ row.label }}
              </ElTag>
            </div>
          </div>
          <div class="aip-bmk__running-actions">
            <ElButton type="primary" :loading="stopping" @click="onStop">
              <span class="i-lucide-square aip-bmk__btn-icon" />结束记录
            </ElButton>
            <ElButton @click="onCancel">取消</ElButton>
          </div>
        </div>

        <div class="aip-bmk__live-cards">
          <article v-for="row in activeRows" :key="row.key" class="aip-bmk__live-card">
            <div class="aip-bmk__live-head">
              <span class="aip-bmk__dot" :style="{ background: row.color }" />
              <span class="aip-bmk__live-label">{{ row.label }}</span>
            </div>
            <div class="aip-bmk__live-value aipt-num" :title="`${formatNumber(row.total)} token`">
              {{ formatCompactTokens(row.total) }}
            </div>
            <div class="aip-bmk__live-foot">
              <span class="aipt-num">{{ formatNumber(row.turns) }}</span> 次对话
            </div>
          </article>
        </div>
      </template>
    </div>

    <!-- 历史记录列表 -->
    <div class="aip-bmk__history">
      <div class="aip-bmk__history-head">
        <div class="aip-bmk__section-title">历史记录</div>
        <div class="aip-bmk__history-tools">
          <ElButton
            type="primary"
            size="small"
            :disabled="!canCompare"
            :title="canCompare ? '查看勾选记录的用量对比' : '勾选 ≥2 条记录进行对比'"
            @click="compareOpen = true"
          >
            对比用量{{ compareSessions.length > 0 ? ` (${compareSessions.length})` : '' }}
          </ElButton>
          <ElRadioGroup v-if="sessions.length > 0" v-model="historySort" size="small">
            <ElRadioButton value="recent">最近</ElRadioButton>
            <ElRadioButton value="usage-desc">用量高→低</ElRadioButton>
            <ElRadioButton value="usage-asc">用量低→高</ElRadioButton>
          </ElRadioGroup>
        </div>
      </div>
      <div v-if="sessions.length === 0" class="aip-bmk__empty aipt-glass">
        <ElEmpty description="还没有测算记录,选择工具并「开始记录」一次试试" />
      </div>
      <div v-else class="aip-bmk__cards">
        <article
          v-for="s in sortedSessions"
          :key="s.id"
          class="aip-bmk__card aipt-glass aip-bmk__card--clickable"
          :class="{ 'aip-bmk__card--checked': compareIds.has(s.id) }"
          role="button"
          tabindex="0"
          :title="`查看「${s.label || '(未命名)'}」的会话明细`"
          @click="openDetail(s)"
          @keydown.enter="openDetail(s)"
        >
          <div class="aip-bmk__card-head">
            <span class="aip-bmk__card-check" @click.stop>
              <ElCheckbox :model-value="compareIds.has(s.id)" @change="() => toggleCompare(s.id)" />
            </span>
            <div class="aip-bmk__card-head-main">
              <span class="aip-bmk__card-title" :title="s.label || '(未命名)'">{{
                s.label || '(未命名)'
              }}</span>
              <span class="aip-bmk__card-time"
                >{{ formatDateTime(s.startedAt) }} · {{ formatDuration(s.durationMs) }}</span
              >
            </div>
            <ElButton
              size="small"
              text
              type="danger"
              class="aip-bmk__card-del"
              @click.stop="onDelete(s)"
            >
              删除
            </ElButton>
          </div>
          <div class="aip-bmk__card-grand">
            <span
              class="aip-bmk__card-grand-value aipt-num"
              :title="`${formatNumber(sessionGrand(s))} token`"
            >
              {{ formatCompactTokens(sessionGrand(s)) }}
            </span>
            <span class="aip-bmk__card-grand-unit"
              >总 token · {{ formatNumber(s.grandTotal?.turns ?? 0) }} 次对话</span
            >
          </div>
          <UsageBar :value="sessionGrand(s)" :max="historyMaxGrand" />
          <div class="aip-bmk__card-sources">
            <span v-for="src in s.sources" :key="src" class="aip-bmk__card-source">
              <span class="aip-bmk__dot" :style="{ background: SOURCE_COLOR[src] }" />
              {{ SOURCE_LABEL[src] }}
              <b class="aipt-num">{{ formatCompactTokens(s.totals[src]?.total ?? 0) }}</b>
            </span>
          </div>
        </article>
      </div>
    </div>

    <!-- 对比用量弹窗:勾选 ≥2 条记录后展示图表 + 对比表格 -->
    <ElDialog
      v-model="compareOpen"
      title="用量对比"
      width="860px"
      align-center
      append-to-body
      class="aip-bmk-compare-dialog"
    >
      <div v-if="canCompare" class="aip-bmk__compare">
        <VChart
          class="aip-bmk__chart"
          :option="compareOption"
          autoresize
          :style="{ height: '260px' }"
        />
        <div class="aip-bmk__compare-table-wrap">
          <table class="aip-bmk__table">
            <thead>
              <tr>
                <th>指标</th>
                <th v-for="s in compareSessions" :key="s.id">
                  {{ s.label || formatDateTime(s.startedAt) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>总 token</td>
                <td v-for="s in compareSessions" :key="s.id" class="aipt-num">
                  {{ formatNumber(sessionGrand(s)) }}
                </td>
              </tr>
              <tr>
                <td>用量对比</td>
                <td v-for="s in compareSessions" :key="s.id">
                  <UsageBar :value="sessionGrand(s)" :max="compareMaxGrand" />
                </td>
              </tr>
              <tr>
                <td>对话次数</td>
                <td v-for="s in compareSessions" :key="s.id" class="aipt-num">
                  {{ formatNumber(s.grandTotal?.turns ?? 0) }}
                </td>
              </tr>
              <tr>
                <td>时长</td>
                <td v-for="s in compareSessions" :key="s.id" class="aipt-num">
                  {{ formatDuration(s.durationMs) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <ElEmpty v-else description="请勾选至少 2 条记录后再对比" />
    </ElDialog>

    <!-- 记录详情抽屉:窗口内各会话实际消耗 -->
    <ElDrawer
      v-model="detailOpen"
      size="720"
      destroy-on-close
      class="aip-bmk-drawer"
      :with-header="true"
      @closed="onDetailClosed"
    >
      <template #header>
        <div class="aip-bmk-drawer__header">
          <h3 class="aip-bmk-drawer__title">
            {{ detailSession?.label || '(未命名)' }}
          </h3>
          <span v-if="detailSession" class="aip-bmk-drawer__time">
            {{ formatDateTime(detailSession.startedAt) }} →
            {{ formatDateTime(detailSession.endedAt) }} ·
            {{ formatDuration(detailSession.durationMs) }}
          </span>
        </div>
      </template>

      <div v-if="detailSession" class="aip-bmk-drawer__body">
        <!-- 记录窗口口径合计(窗口内累加值) -->
        <section class="aip-bmk-drawer__totals">
          <div class="aip-bmk-drawer__grand">
            <span class="aip-bmk-drawer__grand-value aipt-num">{{
              formatNumber(detailGrand)
            }}</span>
            <span class="aip-bmk-drawer__grand-unit">窗口内合计 token</span>
          </div>
          <div class="aip-bmk-drawer__source-list">
            <span v-for="row in detailSourceRows" :key="row.key" class="aip-bmk-drawer__source">
              <span class="aip-bmk__dot" :style="{ background: row.color }" />
              {{ row.label }}
              <b class="aipt-num">{{ formatCompactTokens(row.total) }}</b>
            </span>
          </div>
        </section>

        <!-- 会话累计口径说明 -->
        <p class="aip-bmk-drawer__note">
          下列为窗口内涉及的各会话的<b>会话累计</b>用量(会话生命周期 firstAt→lastAt
          的累计),可能与上方「窗口内合计」不完全一致 —— 会话可能在测算窗口之外仍有活动。
        </p>
        <p v-if="detailUnresolved > 0" class="aip-bmk-drawer__warn">
          另有 {{ detailUnresolved }} 个会话无可用明细(采集开关曾关闭,或已被会话用量保留上限裁剪)。
        </p>

        <div v-if="detailLoading" class="aip-bmk-drawer__loading">加载会话明细…</div>
        <div v-else-if="detailRows.length === 0" class="aip-bmk-drawer__empty">
          <ElEmpty
            :description="
              detailTotalSessions === 0
                ? '该记录窗口内未捕获到任何会话 sessionId,无法展示会话明细'
                : '该记录的会话明细均无法解析(采集开关曾关闭或已被保留上限裁剪)'
            "
          />
        </div>
        <section v-else class="aip-bmk-drawer__sessions-wrap">
          <div class="aip-bmk-drawer__sessions-label">
            会话明细 · <span class="aipt-num">{{ detailRows.length }}</span> 个
          </div>
          <div class="aip-bmk-drawer__sessions">
            <SessionUsageRow
              v-for="row in detailRows"
              :key="row.key"
              :session="row"
              :max-total="detailMaxTotal"
              @goto-requirement="gotoRequirement"
            />
          </div>
        </section>
      </div>
    </ElDrawer>
  </section>
</template>

<style scoped>
.aip-bmk {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-5);
  padding: var(--aipt-space-5);
}

.aip-bmk__page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-bmk__heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.aip-bmk__page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.aip-bmk__page-sub {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-muted);
  max-width: 680px;
}

.aip-bmk__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-4) var(--aipt-space-5);
  color: var(--aipt-text-strong);
  font-size: 13px;
}

.aip-bmk__control {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-5);
}

.aip-bmk__control-row {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-4);
}

.aip-bmk__control-label {
  font-size: 13px;
  color: var(--aipt-text-muted);
  width: 64px;
  flex-shrink: 0;
}

.aip-bmk__control-actions {
  display: flex;
  gap: var(--aipt-space-3);
}

.aip-bmk__btn-icon {
  margin-right: 6px;
}

.aip-bmk__running {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-bmk__running-left {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-5);
  flex-wrap: wrap;
}

.aip-bmk__running-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aip-bmk__pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ff5d6c;
  box-shadow: 0 0 0 0 rgba(255, 93, 108, 0.6);
  animation: aip-bmk-pulse 1.4s infinite;
}

@keyframes aip-bmk-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 93, 108, 0.55);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(255, 93, 108, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 93, 108, 0);
  }
}

.aip-bmk__running-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-bmk__running-label {
  font-size: 12px;
  color: var(--aipt-text-muted);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--aipt-surface-2, rgba(255, 255, 255, 0.06));
}

.aip-bmk__timer {
  font-size: 30px;
  font-weight: 800;
  line-height: 1;
  color: var(--aipt-text-strong);
  font-variant-numeric: tabular-nums;
}

.aip-bmk__running-sources {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.aip-bmk__running-actions {
  display: flex;
  gap: var(--aipt-space-3);
}

.aip-bmk__live-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--aipt-space-4);
  margin-top: var(--aipt-space-3);
}

.aip-bmk__live-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--aipt-space-4);
  border-radius: var(--aipt-radius-3, 12px);
  background: var(--aipt-surface-2, rgba(255, 255, 255, 0.04));
}

.aip-bmk__live-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aip-bmk__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}

.aip-bmk__live-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--aipt-text-strong);
}

.aip-bmk__live-value {
  font-size: 24px;
  font-weight: 800;
  color: var(--aipt-text-strong);
}

.aip-bmk__live-foot {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-bmk__compare {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
}

.aip-bmk__section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-bmk__chart {
  width: 100%;
}

.aip-bmk__compare-table-wrap {
  overflow-x: auto;
}

.aip-bmk__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.aip-bmk__table th,
.aip-bmk__table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--aipt-border, rgba(255, 255, 255, 0.08));
  color: var(--aipt-text-strong);
  white-space: nowrap;
}

.aip-bmk__table th:first-child,
.aip-bmk__table td:first-child {
  color: var(--aipt-text-muted);
}

.aip-bmk__history {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aip-bmk__history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-bmk__history-tools {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  flex-wrap: wrap;
}

.aip-bmk__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  padding: var(--aipt-space-5);
}

.aip-bmk__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--aipt-space-4);
}

.aip-bmk__card {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-4);
  transition: border-color 0.15s ease;
}

.aip-bmk__card--checked {
  border-color: var(--aipt-accent, #6ea7f5);
}

.aip-bmk__card--clickable {
  cursor: pointer;
}

.aip-bmk__card--clickable:hover {
  border-color: var(--aipt-accent, #6ea7f5);
}

.aip-bmk__card-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

/* 对比复选框包裹:阻断卡片点击冒泡,仅切换对比态 */
.aip-bmk__card-check {
  display: inline-flex;
  align-items: center;
  height: 20px;
  cursor: default;
}

.aip-bmk__card-head-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aip-bmk__card-title {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--aipt-text-strong);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.aip-bmk__card-time {
  font-size: 11px;
  color: var(--aipt-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.aip-bmk__card-del {
  flex-shrink: 0;
}

.aip-bmk__card-grand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.aip-bmk__card-grand-value {
  font-size: 26px;
  font-weight: 800;
  color: var(--aipt-text-strong);
}

.aip-bmk__card-grand-unit {
  font-size: 11px;
  color: var(--aipt-text-muted);
}

.aip-bmk__card-sources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aipt-space-3);
}

.aip-bmk__card-source {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-bmk__card-source b {
  color: var(--aipt-text-strong);
  font-weight: 700;
}

/* ───────── 记录详情抽屉 ───────── */
.aip-bmk-drawer__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.aip-bmk-drawer__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aip-bmk-drawer__time {
  font-size: 12px;
  color: var(--aipt-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 抽屉 body 全局被重置为 padding:0,这里恢复内边距,避免内容贴边 */
.aip-bmk-drawer__body {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-6);
}

.aip-bmk-drawer__totals {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
  padding: var(--aipt-space-5);
  border-radius: var(--aipt-radius-lg);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border-faint);
}

.aip-bmk-drawer__grand {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aip-bmk-drawer__grand-value {
  font-size: 28px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--aipt-text-strong);
  font-variant-numeric: tabular-nums;
}

.aip-bmk-drawer__grand-unit {
  font-size: 11px;
  color: var(--aipt-text-muted);
}

.aip-bmk-drawer__source-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aipt-space-2);
}

.aip-bmk-drawer__source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--aipt-text-muted);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  border-radius: var(--aipt-radius-pill);
}

.aip-bmk-drawer__source b {
  color: var(--aipt-text-strong);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.aip-bmk-drawer__note {
  margin: 0;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  font-size: 12px;
  line-height: 1.7;
  color: var(--aipt-text-muted);
  background: var(--aipt-surface-soft);
  border-left: 2px solid var(--aipt-border-strong);
  border-radius: var(--aipt-radius-md);
}

.aip-bmk-drawer__note b {
  color: var(--aipt-text-secondary);
  font-weight: 700;
}

.aip-bmk-drawer__warn {
  margin: 0;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  font-size: 12px;
  line-height: 1.7;
  color: #d99a3c;
  background: rgba(245, 188, 110, 0.1);
  border-left: 2px solid rgba(245, 188, 110, 0.5);
  border-radius: var(--aipt-radius-md);
}

.aip-bmk-drawer__loading {
  padding: var(--aipt-space-8);
  text-align: center;
  font-size: 13px;
  color: var(--aipt-text-muted);
}

.aip-bmk-drawer__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  padding: var(--aipt-space-5);
  border-radius: var(--aipt-radius-lg);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
}

.aip-bmk-drawer__sessions-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-2);
}

.aip-bmk-drawer__sessions-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--aipt-text-muted);
}

.aip-bmk-drawer__sessions-label .aipt-num {
  color: var(--aipt-text-strong);
}

.aip-bmk-drawer__sessions {
  display: flex;
  flex-direction: column;
  padding: 0 var(--aipt-space-4);
  border-radius: var(--aipt-radius-lg);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border-faint);
}
</style>
