<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ElButton,
  ElSwitch,
  ElMessage,
  ElRadioGroup,
  ElRadioButton,
  ElSelect,
  ElOption,
  ElEmpty,
  ElTooltip,
  ElPagination
} from 'element-plus'

import { useRouter } from 'vue-router'

import {
  AgentRequestError,
  fetchAiUsage,
  fetchSessionUsage,
  patchAiUsageConfig,
  AI_USAGE_SOURCES,
  type AiUsageDailyView,
  type AiUsageResponse,
  type AiUsageSource,
  type SessionUsageView,
  type SessionUsageSortKey,
  type SessionUsageSortDir
} from '../api'
import AuroraLineCard from '../charts/AuroraLineCard.vue'
import UsageBar from '../components/UsageBar.vue'

const DAYS = 14

const router = useRouter()

/** 展示偏好持久化键:是否把 cacheRead 合并进 token 展示口径。 */
const MERGE_CACHE_READ_KEY = 'aipt:ai-usage:merge-cache-read'

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

/**
 * 是否把 cacheRead 合并进 token 展示口径(纯展示偏好,localStorage 持久化)。
 * 关闭 = 有效用量(totalTokens);开启 = 有效用量 + 缓存读取(≈ 计费口径)。
 */
const mergeCacheRead = ref<boolean>(readMergeCacheRead())

function readMergeCacheRead(): boolean {
  try {
    return localStorage.getItem(MERGE_CACHE_READ_KEY) === '1'
  } catch {
    return false
  }
}

watch(mergeCacheRead, (v) => {
  try {
    localStorage.setItem(MERGE_CACHE_READ_KEY, v ? '1' : '0')
  } catch {
    /* localStorage 不可用时静默降级,仅丢失持久化能力,不影响展示 */
  }
})

/** 统一 token 展示口径:按开关决定是否把 cacheRead 加回 totalTokens。 */
function tokenOf(view: AiUsageDailyView | undefined): number {
  if (!view) return 0
  return view.totalTokens + (mergeCacheRead.value ? view.cacheReadTokens : 0)
}

const enabled = computed(() => data.value?.enabled ?? false)

const todayCards = computed(() =>
  AI_USAGE_SOURCES.map((s) => {
    const view = data.value?.today?.[s.key]
    return {
      key: s.key,
      label: s.label,
      color: SOURCE_COLOR[s.key],
      totalTokens: tokenOf(view),
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
      return metric.value === 'tokens' ? tokenOf(v) : v.turns
    })
  }))
})

const chartSubtitle = computed(() => {
  if (metric.value !== 'tokens') return `近 ${DAYS} 天各 AI 对话次数`
  return mergeCacheRead.value
    ? `近 ${DAYS} 天各 AI token 消耗(含缓存读取)`
    : `近 ${DAYS} 天各 AI 有效 token 消耗`
})

/** 今日卡片单位文案:随合并开关反映口径。 */
const cardTokenUnit = computed(() =>
  mergeCacheRead.value ? '今日 token(含缓存读取)' : '今日 token'
)

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * token 紧凑展示:>=1000 用 K,>=100 万用 M,>=10 亿用 B。
 * 保留至多 1 位小数,并去掉末尾的 .0(如 12.0K → 12K)。
 */
function formatCompactTokens(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  const units: Array<{ value: number; suffix: string }> = [
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

/** token 趋势图的 y 轴 / tooltip 使用 K/M 紧凑单位;对话次数维度保持原值。 */
const chartValueFormatter = computed(() =>
  metric.value === 'tokens' ? formatCompactTokens : undefined
)

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

// ───────────────────────── 会话明细区(会话 Top N) ─────────────────────────

const SOURCE_LABEL: Record<AiUsageSource, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

/** AI 工具 → 标签底色修饰类(与 SOURCE_COLOR 同源,不同工具不同底色)。 */
const SOURCE_TAG_CLASS: Record<AiUsageSource, string> = {
  cursor: 'aip-usage__tag--cursor',
  'claude-code': 'aip-usage__tag--claude',
  codex: 'aip-usage__tag--codex'
}

/**
 * 会话列表筛选 / 排序状态:
 * - sessionSource:AI 平台('all' 全部);
 * - sessionProject:所属项目('all' 全部 / 具体项目名,服务端精确过滤);
 * - sessionRangeDays:时间范围(当天 1 / 近 7 / 30 天);
 * - sessionSortKey:排序依据(用量高低 total / 记录时间 lastAt);
 * - sessionSortDir:排序方向(降序 desc / 升序 asc)。
 */
const sessionSource = ref<'all' | AiUsageSource>('all')
const sessionProject = ref<'all' | string>('all')
const sessionRangeDays = ref<1 | 7 | 30>(1)
const sessionSortKey = ref<SessionUsageSortKey>('lastAt')
const sessionSortDir = ref<SessionUsageSortDir>('desc')
const sessionLoading = ref(false)
const sessions = ref<SessionUsageView[]>([])

/**
 * 会话列表前端分页:服务端一次拉取全量(放大 limit),前端按 pageSize 切片。
 * 任意筛选 / 排序变更后复位到第 1 页。
 */
const currentPage = ref(1)
const pageSize = ref(30)

/** 当前页展示的会话切片(基于全量 sessions + currentPage/pageSize)。 */
const pagedSessions = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return sessions.value.slice(start, start + pageSize.value)
})

/** 「所属项目」下拉的动态选项(由当前时间范围 + 平台、不带 project 的会话集合派生)。 */
const projectOptions = ref<string[]>([])

/**
 * 当前列表所有会话 total 的最大值,作 UsageBar 归一化 max:条长 = value/max。
 * 用量最高的会话条满 100%,其余按各自占比等比放大。max=0 时 UsageBar 安全归零。
 */
const sessionMaxTotal = computed(() =>
  sessions.value.reduce((m, s) => (s.totalTokens > m ? s.totalTokens : m), 0)
)

function sessionFromIso(): string {
  const d = new Date()
  d.setDate(d.getDate() - (sessionRangeDays.value - 1))
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

async function loadSessions() {
  sessionLoading.value = true
  try {
    const res = await fetchSessionUsage({
      from: sessionFromIso(),
      source: sessionSource.value === 'all' ? undefined : sessionSource.value,
      project: sessionProject.value === 'all' ? undefined : sessionProject.value,
      sort: sessionSortKey.value,
      dir: sessionSortDir.value,
      limit: 1000
    })
    sessions.value = res.sessions
    // 数据刷新后若当前页越界(典型:筛选收窄后总数变少),回退到第 1 页
    if ((currentPage.value - 1) * pageSize.value >= sessions.value.length) {
      currentPage.value = 1
    }
  } catch {
    // 会话明细加载失败不阻断主页面,留空列表(空态引导兜底)
    sessions.value = []
  } finally {
    sessionLoading.value = false
  }
}

/**
 * 派生「所属项目」下拉选项:按当前时间范围 + AI 平台、不带 project 过滤拉一份较大集合,
 * distinct 出非空 projectName(无项目名会话不产生选项)。若当前选中的项目在新选项中不存在
 * (典型:切换平台后该项目无会话),回退到「全部」。
 */
async function loadProjectOptions() {
  try {
    const res = await fetchSessionUsage({
      from: sessionFromIso(),
      source: sessionSource.value === 'all' ? undefined : sessionSource.value,
      sort: 'total',
      dir: 'desc',
      limit: 200
    })
    const names = Array.from(
      new Set(
        res.sessions
          .map((s) => s.projectName)
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      )
    ).sort((a, b) => a.localeCompare(b))
    projectOptions.value = names
    if (sessionProject.value !== 'all' && !names.includes(sessionProject.value)) {
      sessionProject.value = 'all'
    }
  } catch {
    projectOptions.value = []
  }
}

// 平台 / 时间范围变更:复位页码 → 先重算项目下拉选项(可能回退选中项),再刷新列表。
watch([sessionSource, sessionRangeDays], async () => {
  currentPage.value = 1
  await loadProjectOptions()
  void loadSessions()
})

// 项目 / 排序依据 / 方向变更:复位页码后仅刷新列表。
watch([sessionProject, sessionSortKey, sessionSortDir], () => {
  currentPage.value = 1
  void loadSessions()
})

// 每页条数变更:复位到第 1 页(纯前端,不需重新拉取)。
watch(pageSize, () => {
  currentPage.value = 1
})

/** 会话展示标识:title 优先;否则短会话 ID + 工具(回退在模板里附时间窗)。 */
function sessionLabel(s: SessionUsageView): string {
  if (s.title && s.title.trim()) return s.title
  const shortId = s.sessionId ? s.sessionId.slice(0, 8) : '—'
  return `${SOURCE_LABEL[s.source]} · ${shortId}`
}

/** 绝对时间窗「MM-DD HH:mm → MM-DD HH:mm」,作时长标签的 title 兜底悬浮。 */
function formatTimeWindowAbsolute(s: SessionUsageView): string {
  const fmt = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const from = fmt(s.firstAt)
  const to = fmt(s.lastAt)
  return from && to ? `${from} → ${to}` : from || to
}

/**
 * 会话持续时长(firstAt → lastAt)紧凑展示,比绝对起止时间更直观:
 * < 1 分钟 → `Ns`;< 60 分钟 → `Nmin`;否则 `Xh` 或 `XhYmin`(不足 1h 余数)。
 * 时间无法解析 / 起止相同 → `0s`。
 */
function formatDuration(s: SessionUsageView): string {
  const from = Date.parse(s.firstAt)
  const to = Date.parse(s.lastAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '0s'
  const totalSec = Math.round((to - from) / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin}min`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${hours}h` : `${hours}h${min}min`
}

function gotoRequirement(jiraKey: string) {
  void router.push({ path: '/workspace', query: { jira: jiraKey } })
}

onMounted(() => {
  void load()
  void loadProjectOptions()
  void loadSessions()
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
          <span class="aip-usage__switch-label">合并缓存读取(cacheRead)</span>
          <ElTooltip placement="bottom" :show-after="100">
            <template #content>
              <div class="aip-usage__help-tip">
                默认统计的是「有效用量」口径(input + output + cacheCreation),已剔除缓存读取
                (cacheRead)—— 因为 cacheRead 计费仅约 0.1x,且同一上下文会被反复命中,直接累加会让
                数值虚高数倍。<br />
                开启本开关后,卡片与趋势图的 token 改为展示「有效用量 + cacheRead」,更接近 AI
                平台账单 口径。该选项仅影响展示,不改变已采集的原始数据,且仅作用于 token
                维度(对话次数不受影响)。
              </div>
            </template>
            <span class="aip-usage__help" role="img" aria-label="说明">?</span>
          </ElTooltip>
          <ElSwitch v-model="mergeCacheRead" />
        </div>
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
            <span
              class="aip-usage__card-value aipt-num"
              :title="`${formatNumber(card.totalTokens)} token`"
              >{{ formatCompactTokens(card.totalTokens) }}</span
            >
            <span class="aip-usage__card-unit">{{ cardTokenUnit }}</span>
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
          :value-formatter="chartValueFormatter"
          :height="300"
        />
      </div>

      <div class="aip-usage__sessions aipt-glass">
        <div class="aip-usage__sessions-head">
          <div class="aip-usage__chart-title">会话用量明细</div>
          <div class="aip-usage__sessions-filters">
            <ElSelect
              v-model="sessionSource"
              size="small"
              class="aip-usage__filter-select"
              aria-label="AI 平台"
            >
              <ElOption label="全部平台" value="all" />
              <ElOption label="Cursor" value="cursor" />
              <ElOption label="Claude" value="claude-code" />
              <ElOption label="Codex" value="codex" />
            </ElSelect>
            <ElSelect
              v-if="projectOptions.length > 0"
              v-model="sessionProject"
              size="small"
              class="aip-usage__filter-select aip-usage__filter-select--project"
              aria-label="所属项目"
            >
              <ElOption label="全部项目" value="all" />
              <ElOption v-for="p in projectOptions" :key="p" :label="p" :value="p" />
            </ElSelect>
            <ElSelect
              v-model="sessionRangeDays"
              size="small"
              class="aip-usage__filter-select"
              aria-label="时间范围"
            >
              <ElOption label="当天" :value="1" />
              <ElOption label="近 7 天" :value="7" />
              <ElOption label="近 30 天" :value="30" />
            </ElSelect>
            <ElSelect
              v-model="sessionSortKey"
              size="small"
              class="aip-usage__filter-select"
              aria-label="排序依据"
            >
              <ElOption label="用量高低" value="total" />
              <ElOption label="记录时间" value="lastAt" />
            </ElSelect>
            <ElSelect
              v-model="sessionSortDir"
              size="small"
              class="aip-usage__filter-select"
              aria-label="排序方向"
            >
              <ElOption label="降序" value="desc" />
              <ElOption label="升序" value="asc" />
            </ElSelect>
          </div>
        </div>

        <div v-if="sessions.length === 0" class="aip-usage__sessions-empty">
          <ElEmpty
            :description="
              enabled
                ? '当前筛选下暂无会话,产生新对话后这里会按会话展示 token 明细'
                : '开启 AI 整体用量采集后,这里会按会话展示 token 明细'
            "
          />
        </div>

        <div v-else class="aip-usage__session-list">
          <article v-for="s in pagedSessions" :key="s.key" class="aip-usage__session-row">
            <div class="aip-usage__session-main">
              <div class="aip-usage__session-title-line">
                <span class="aip-usage__session-title" :title="s.title || s.sessionId">{{
                  sessionLabel(s)
                }}</span>
                <button
                  v-if="s.jiraKey"
                  type="button"
                  class="aip-usage__session-jira"
                  :title="`跳转到需求 ${s.jiraKey}`"
                  @click="gotoRequirement(s.jiraKey)"
                >
                  {{ s.jiraKey }}
                </button>
              </div>
              <div class="aip-usage__session-meta">
                <span class="aip-usage__tag" :class="SOURCE_TAG_CLASS[s.source]">{{
                  SOURCE_LABEL[s.source]
                }}</span>
                <span
                  v-if="s.projectName"
                  class="aip-usage__tag aip-usage__tag--ellipsis"
                  :title="`项目 ${s.projectName}`"
                  >{{ s.projectName }}</span
                >
                <span
                  v-if="s.branch"
                  class="aip-usage__tag aip-usage__tag--ellipsis"
                  :title="`分支 ${s.branch}`"
                  >{{ s.branch }}</span
                >
                <span
                  v-if="s.model"
                  class="aip-usage__tag aip-usage__tag--ellipsis aip-usage__tag--model"
                  :title="s.model"
                  >{{ s.model }}</span
                >
                <span class="aip-usage__tag" :title="formatTimeWindowAbsolute(s)">{{
                  formatDuration(s)
                }}</span>
                <span class="aip-usage__tag">{{ formatNumber(s.turns) }} 轮</span>
              </div>
            </div>
            <div class="aip-usage__session-bar">
              <UsageBar :value="s.totalTokens" :max="sessionMaxTotal" color-mode="absolute" />
            </div>
          </article>
        </div>

        <div v-if="sessions.length > 0" class="aip-usage__sessions-pager">
          <ElPagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            size="small"
            background
            layout="prev, pager, next, sizes, total"
            :page-sizes="[30, 50, 100]"
            :total="sessions.length"
          />
        </div>
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

.aip-usage__help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--aipt-text-muted);
  color: var(--aipt-text-muted);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  user-select: none;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}

.aip-usage__help:hover {
  color: var(--aipt-text-strong);
  border-color: var(--aipt-text-strong);
}

.aip-usage__help-tip {
  max-width: 320px;
  line-height: 1.6;
  font-size: 12px;
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

.aip-usage__sessions {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-5);
}

.aip-usage__sessions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-usage__sessions-filters {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  flex-wrap: wrap;
}

.aip-usage__filter-select {
  width: 116px;
}

.aip-usage__filter-select--project {
  width: 148px;
}

.aip-usage__sessions-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.aip-usage__session-list {
  display: flex;
  flex-direction: column;
}

.aip-usage__session-row {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-3) 0;
  border-bottom: 1px solid var(--aipt-border-faint);
}

.aip-usage__session-row:last-child {
  border-bottom: none;
}

.aip-usage__session-main {
  flex: 1 1 60%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-usage__session-title-line {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  min-width: 0;
}

.aip-usage__session-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aip-usage__session-jira {
  flex: 0 0 auto;
  border: 1px solid var(--aipt-border-strong);
  background: var(--aipt-surface);
  color: var(--aipt-text-secondary);
  border-radius: var(--aipt-radius-pill);
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition:
    color var(--aipt-duration-fast),
    border-color var(--aipt-duration-fast);
}

.aip-usage__session-jira:hover {
  color: var(--aipt-text-on-accent);
  background: var(--aipt-primary);
  border-color: var(--aipt-primary);
}

.aip-usage__session-meta {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  font-size: 11px;
  color: var(--aipt-text-muted);
  flex-wrap: wrap;
}

.aip-usage__tag {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: var(--aipt-radius-pill);
  background: var(--aipt-surface-strong);
  color: var(--aipt-text-secondary);
  border: 1px solid transparent;
  line-height: 1.5;
}

.aip-usage__tag--ellipsis {
  max-width: 160px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aip-usage__tag--model {
  max-width: 180px;
}

/* AI 工具标签按工具着色(半透明底 + 同色边/文字,与 SOURCE_COLOR 同源) */
.aip-usage__tag--cursor {
  background: rgba(110, 167, 245, 0.16);
  border-color: rgba(110, 167, 245, 0.4);
  color: #6ea7f5;
}

.aip-usage__tag--claude {
  background: rgba(240, 166, 200, 0.16);
  border-color: rgba(240, 166, 200, 0.4);
  color: #f0a6c8;
}

.aip-usage__tag--codex {
  background: rgba(159, 229, 212, 0.16);
  border-color: rgba(159, 229, 212, 0.4);
  color: #9fe5d4;
}

.aip-usage__sessions-pager {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--aipt-space-2);
}

.aip-usage__session-bar {
  flex: 1 1 40%;
  min-width: 140px;
  max-width: 320px;
}
</style>
