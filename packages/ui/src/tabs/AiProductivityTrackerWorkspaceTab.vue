<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  ElButton,
  ElDrawer,
  ElEmpty,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElSlider,
  ElTable,
  ElTableColumn,
  ElTabPane,
  ElTabs,
  ElTooltip
} from 'element-plus'

import {
  fetchSummary,
  getRequirementDetail,
  listRequirements,
  mergeSplitIterations,
  patchRequirement,
  refreshBugs,
  syncJiraTitle,
  type IterationDetail,
  type RequirementDetail,
  type RequirementStatus,
  type RequirementSummary,
  type SummaryMetrics
} from '../api'
import { useNumberFlow } from '../composables/useNumberFlow'
import SparkLine from '../charts/SparkLine.vue'
import RetrospectiveReportPanel from './RetrospectiveReportPanel.vue'
import '../styles/aip-shared.css'

const loading = ref(false)
const requirements = ref<RequirementSummary[]>([])
const summary = ref<SummaryMetrics | null>(null)
const search = ref('')
const statusFilter = ref<'' | RequirementStatus>('')

const drawerOpen = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<RequirementDetail | null>(null)
/**
 * v1.0.0-rc.23 抽屉子 tab:
 *   - overview = 既有 4 段卡片(boost hero / 指标 / 关联 Bug / iteration 时间线)
 *   - retrospective = 单需求复盘报告 panel
 *
 * 抽屉每次重新打开都重置回 'overview',避免上次切到复盘后下次开抽屉直接闪复盘 tab。
 */
const drawerActiveTab = ref<'overview' | 'retrospective'>('overview')
watch(drawerOpen, (open) => {
  if (open) drawerActiveTab.value = 'overview'
})
const bugRefreshing = ref(false)
const detailRefreshing = ref(false)
const mergeSplitRunning = ref(false)

/**
 * 状态下拉的本地受控值。
 *
 * ElSelect 用 `:model-value="currentDetail.status"` 单向绑定时,如果父侧
 * 不更新 currentDetail.status(例如用户在 confirm 弹窗里点了 Cancel),
 * 组件内部 selectedLabel 不会自动回退,UI 会卡在用户刚选的"新值"上,
 * 这会让取消变更的视觉反馈不对。改成 `v-model="statusDraft"` 并通过
 * watch 单向同步 currentDetail.status -> statusDraft,handleStatusChange
 * 在用户取消 / patch 失败时主动把 statusDraft 回滚到 prev,UI 就能立刻
 * 回到原状态。
 */
const statusDraft = ref<RequirementStatus | ''>('')
watch(
  () => currentDetail.value?.status ?? '',
  (val) => {
    statusDraft.value = val as RequirementStatus | ''
  },
  { immediate: true }
)

/**
 * v2.14.0 人工预估时间内联编辑 —— 单位「小时」.
 *
 * 后端存储仍是 `manualEstimateMinutes` 整数,不动 schema.
 * 编辑时把分钟换算成小时(允许 0.5 步进的小数,如 0.5/1.5/2 等),
 * 保存时 Math.round(hours * 60) 写回 manualEstimateMinutes.
 */
const estimateEditing = ref(false)
const estimateHoursDraft = ref(0)
const estimateSaving = ref(false)

/** v2.14.0 标题内联编辑(允许用户在 Jira 拉不到时手填兜底). */
const titleEditing = ref(false)
const titleDraft = ref('')
const titleSaving = ref(false)
const titleSyncing = ref(false)

/**
 * 需求级 wThink 滑块状态。
 *
 * - `wThinkDraftPercent`:滑块绑定的百分比草稿值 ∈ [0, 100],与后端字段
 *   `formulaWThinkOverride ∈ [0, 1]` 1:1 换算。
 * - `wThinkSaving`:保存按钮 loading 态。
 *
 * 抽屉每次打开或切换需求,通过 watch 把 currentDetail 的 effectiveFormula.wThink
 * 同步到草稿(无单独"编辑/取消"按钮,即时编辑 + 显式保存语义)。
 */
const wThinkDraftPercent = ref<number>(70)
const wThinkSaving = ref(false)
watch(
  () => currentDetail.value?.effectiveFormula?.wThink,
  (next) => {
    if (typeof next === 'number' && Number.isFinite(next)) {
      wThinkDraftPercent.value = Math.round(next * 100)
    }
  },
  { immediate: true }
)
const wThinkDirty = computed(() => {
  const current = currentDetail.value?.effectiveFormula?.wThink
  if (typeof current !== 'number') return false
  return Math.round(current * 100) !== wThinkDraftPercent.value
})
const wElapsedDraftPercent = computed(() => 100 - wThinkDraftPercent.value)
/** 已经为当前 jiraKey 触发过一次自动兜底,避免每次 openDetail 都打一次接口 */
const titleAutoSyncedKeys = ref<Set<string>>(new Set())

const filteredRequirements = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return requirements.value.filter((item) => {
    const matchesStatus = !statusFilter.value || item.status === statusFilter.value
    if (!matchesStatus) return false
    if (!keyword) return true
    return (
      item.jiraKey.toLowerCase().includes(keyword) ||
      item.title.toLowerCase().includes(keyword) ||
      item.projectSlug.toLowerCase().includes(keyword)
    )
  })
})

async function loadList() {
  loading.value = true
  try {
    const [list, sum] = await Promise.all([listRequirements(), fetchSummary()])
    requirements.value = list
    summary.value = sum
  } catch (err) {
    ElMessage.error((err as Error).message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function openDetail(row: RequirementSummary) {
  drawerOpen.value = true
  detailLoading.value = true
  currentDetail.value = null
  // 退出可能残留的编辑态(用户上一次抽屉编辑后没保存就关闭)
  estimateEditing.value = false
  titleEditing.value = false
  try {
    currentDetail.value = await getRequirementDetail(row.jiraKey)
    void maybeAutoSyncJiraTitle(currentDetail.value)
  } catch (err) {
    ElMessage.error((err as Error).message || '详情加载失败')
  } finally {
    detailLoading.value = false
  }
}

/**
 * v2.14.0 自动兜底:当详情 title 仍等于 jiraKey(init 时未拿到真实 summary),
 * 静默后台触发一次 syncJiraTitle.成功则刷新当前抽屉 + 列表;失败仅 console.warn,
 * 不打扰用户(用户没配 Jira 凭证是常见前置).
 *
 * 每个 jiraKey 仅在当次会话尝试一次,避免每次 openDetail 都发请求.
 */
async function maybeAutoSyncJiraTitle(detail: RequirementDetail | null) {
  if (!detail) return
  if (detail.title !== detail.jiraKey) return
  if (titleAutoSyncedKeys.value.has(detail.jiraKey)) return
  titleAutoSyncedKeys.value.add(detail.jiraKey)
  try {
    const result = await syncJiraTitle(detail.jiraKey)
    if (result.title && currentDetail.value?.jiraKey === detail.jiraKey) {
      currentDetail.value = { ...currentDetail.value, title: result.title }
    }
    await loadList()
  } catch (err) {
    console.warn('[ai-productivity] 自动同步 Jira 标题失败,已忽略:', err)
  }
}

async function handleRefreshDetail() {
  if (!currentDetail.value) return
  detailRefreshing.value = true
  try {
    currentDetail.value = await getRequirementDetail(currentDetail.value.jiraKey)
  } catch (err) {
    ElMessage.error((err as Error).message || '详情刷新失败')
  } finally {
    detailRefreshing.value = false
  }
}

function startEditEstimate() {
  if (!currentDetail.value) return
  estimateHoursDraft.value = Number((currentDetail.value.manualEstimateMinutes / 60).toFixed(2))
  estimateEditing.value = true
}

function cancelEditEstimate() {
  estimateEditing.value = false
}

async function handleSaveEstimate() {
  if (!currentDetail.value) return
  const hours = Number(estimateHoursDraft.value)
  if (!Number.isFinite(hours) || hours < 0) {
    ElMessage.error('请输入 ≥ 0 的小时数')
    return
  }
  const minutes = Math.round(hours * 60)
  estimateSaving.value = true
  try {
    await patchRequirement(currentDetail.value.jiraKey, { manualEstimateMinutes: minutes })
    estimateEditing.value = false
    // 并行刷新当前抽屉详情 + 列表 + 总览,让 boost / 表格 / 汇总实时联动
    await Promise.all([
      getRequirementDetail(currentDetail.value.jiraKey).then((next) => {
        currentDetail.value = next
      }),
      loadList()
    ])
    ElMessage.success('人工预估已更新')
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    estimateSaving.value = false
  }
}

function startEditTitle() {
  if (!currentDetail.value) return
  titleDraft.value = currentDetail.value.title
  titleEditing.value = true
  void nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.aip-drawer__header-title-input input')
    el?.focus()
    el?.select()
  })
}

function cancelEditTitle() {
  titleEditing.value = false
}

async function handleSaveTitle() {
  if (!currentDetail.value) return
  const next = titleDraft.value.trim()
  if (!next) {
    ElMessage.error('标题不能为空')
    return
  }
  titleSaving.value = true
  try {
    await patchRequirement(currentDetail.value.jiraKey, { title: next })
    currentDetail.value = { ...currentDetail.value, title: next }
    titleEditing.value = false
    await loadList()
    ElMessage.success('标题已更新')
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    titleSaving.value = false
  }
}

async function handleSaveWThink() {
  if (!currentDetail.value) return
  const next = Math.max(0, Math.min(1, wThinkDraftPercent.value / 100))
  wThinkSaving.value = true
  try {
    await patchRequirement(currentDetail.value.jiraKey, { formulaWThinkOverride: next })
    // 用最新详情刷新本抽屉 + 列表 + 总览,让 boost / 加权耗时 即时联动
    await Promise.all([
      getRequirementDetail(currentDetail.value.jiraKey).then((detail) => {
        currentDetail.value = detail
      }),
      loadList()
    ])
    ElMessage.success('时间权重已更新,本需求 boost 已重算')
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    wThinkSaving.value = false
  }
}

async function handleSyncJiraTitle() {
  if (!currentDetail.value) return
  titleSyncing.value = true
  try {
    const result = await syncJiraTitle(currentDetail.value.jiraKey)
    currentDetail.value = { ...currentDetail.value, title: result.title }
    await loadList()
    ElMessage.success(`已从 Jira 拉取最新标题:${result.title}`)
  } catch (err) {
    ElMessage.error(
      (err as Error).message || 'Jira 标题拉取失败,请确认已在 Settings Tab 配置 Jira 凭证'
    )
  } finally {
    titleSyncing.value = false
  }
}

async function handleStatusChange(next: RequirementStatus) {
  if (!currentDetail.value) return
  const prev = currentDetail.value.status as RequirementStatus | ''
  if (next === prev) return
  try {
    await ElMessageBox.confirm(`确认将需求状态改为 ${next}?`, '状态变更', { type: 'warning' })
  } catch {
    statusDraft.value = prev
    return
  }
  try {
    await patchRequirement(currentDetail.value.jiraKey, { status: next })
    currentDetail.value.status = next
    await loadList()
    ElMessage.success('状态已更新')
  } catch (err) {
    statusDraft.value = prev
    ElMessage.error((err as Error).message || '更新失败')
  }
}

async function handleRefreshBugs() {
  if (!currentDetail.value) return
  bugRefreshing.value = true
  try {
    const result = await refreshBugs(currentDetail.value.jiraKey)
    currentDetail.value.linkedBugCount = result.linkedBugCount
    currentDetail.value.linkedBugJql = result.linkedBugJql
    currentDetail.value.bugsRefreshedAt = result.bugsRefreshedAt
    ElMessage.success(`已拉取 ${result.linkedBugCount} 条关联 bug`)
  } catch (err) {
    ElMessage.error((err as Error).message || 'Bug 拉取失败')
  } finally {
    bugRefreshing.value = false
  }
}

/**
 * v2.18.0 数据整理:合并 Cursor stop-hook 兜底产生的"前空 + 后满"拆分 iteration 对。
 *
 * 流程:
 * 1. dryRun=true 拉候选数量
 * 2. 候选为 0 → ElMessage.info,直接结束
 * 3. 否则弹 confirm 提示"检测到 N 组拆分,合并后 M 条 → M-N 条,已自动备份";
 *    用户取消则保留现状
 * 4. 用户确认 → 调真合并 → 成功提示 + 备份路径 + 刷新抽屉
 *
 * 失败一律 ElMessage.error;.bak 备份保留在 daemon 数据目录,误判可手动 mv 回来。
 */
async function handleMergeSplitIterations() {
  if (!currentDetail.value) return
  const jiraKey = currentDetail.value.jiraKey
  mergeSplitRunning.value = true
  try {
    const probe = await mergeSplitIterations(jiraKey, { dryRun: true })
    if (probe.mergedPairs.length === 0) {
      ElMessage.info('未检测到需合并的拆分记录,无需整理')
      return
    }
    try {
      await ElMessageBox.confirm(
        `检测到 ${probe.mergedPairs.length} 组疑似拆分对话,合并后将从 ${probe.totalBefore} 条变为 ${probe.totalAfter} 条。合并前会自动写 .bak 备份到 daemon 数据目录,是否继续?`,
        '数据整理',
        { type: 'warning', confirmButtonText: '执行合并', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
    const result = await mergeSplitIterations(jiraKey, { dryRun: false })
    const tip = result.backupPath
      ? `已合并 ${result.mergedPairs.length} 组,备份:${result.backupPath}`
      : `已合并 ${result.mergedPairs.length} 组`
    ElMessage.success(tip)
    currentDetail.value = await getRequirementDetail(jiraKey)
    await loadList()
  } catch (err) {
    ElMessage.error((err as Error).message || '数据整理失败')
  } finally {
    mergeSplitRunning.value = false
  }
}

function formatBoost(value: number | null) {
  if (value == null) return '-'
  return `${value.toFixed(2)}×`
}

function formatMinutes(value: number) {
  /**
   * effectiveMinutes 是后端按权重算出来的浮点,直接 % 60 会出现
   * 50.940000000000055min 这种长尾,先 round 再拆 h/min 显示。
   */
  const total = Math.max(0, Math.round(value))
  if (total < 60) return `${total} min`
  const hours = Math.floor(total / 60)
  const mins = total % 60
  return mins ? `${hours}h ${mins}min` : `${hours}h`
}

function formatThinkSeconds(value: number) {
  if (!value || value <= 0) return '0s'
  if (value < 60) return `${value}s`
  const mins = Math.floor(value / 60)
  const secs = value % 60
  return secs ? `${mins}m ${secs}s` : `${mins}m`
}

/**
 * 累计 AI 思考时间(各 iteration thinkSeconds 之和)展示。数值可达小时级,
 * 因此 ≥1h 时按 h/min 呈现,与 formatMinutes 的口径保持一致;不足 1 分钟回退到秒。
 */
function formatThinkDuration(value: number) {
  if (!value || value <= 0) return '0min'
  if (value < 60) return `${value}s`
  const totalMins = Math.floor(value / 60)
  if (totalMins < 60) return `${totalMins}min`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  return mins ? `${hours}h ${mins}min` : `${hours}h`
}

/**
 * v1.0.0-rc.18 本轮 AI 思考 hover tooltip:
 *  - 主指标:wall time(用户提交 → AI 答完);旧数据 / Cursor 老 hook 走 60s fallback 时也是此口径
 *  - 副指标:纯模型思考(`afterAgentThought.duration_ms` 累加);Claude Code / 老 daemon / 非 thinking
 *    模型 → 字段缺失,tooltip 仅显示 wall time。
 */
function buildThinkSecondsTooltip(iter: IterationDetail): string {
  const wall = `Wall time(用户提交→AI 答完): ${formatThinkSeconds(iter.thinkSeconds)}`
  if (typeof iter.pureThinkSeconds !== 'number') return wall
  return `${wall}\n纯模型思考(thinking 块累加): ${formatThinkSeconds(iter.pureThinkSeconds)}`
}

/**
 * Token 数字本身一旦突破几十万就难以一眼读出量级,本函数按 K / M / B
 * 三档压缩显示,精度遵循「跨档保留更多有效位」原则:
 * - <1K: 原值 + 千位分隔(如 999、12)
 * - 1K~10K: 保留两位小数(如 1.23K)
 * - 10K~1M: 保留一位小数(如 12.5K、613.3K)
 * - 1M~10M: 保留两位小数(如 1.23M)
 * - 10M~1B: 保留一位小数(如 12.5M)
 * - >=1B: 保留两位小数(如 1.23B)
 * 同步提供 formatTokenTitle 用于 hover tooltip 显示精确值。
 */
function formatTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const abs = Math.abs(value)
  if (abs < 1000) return value.toLocaleString()
  if (abs < 10_000) return `${(value / 1000).toFixed(2)}K`
  if (abs < 1_000_000) return `${(value / 1000).toFixed(1)}K`
  if (abs < 10_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}

function formatTokenTitle(value: number) {
  if (!Number.isFinite(value)) return '0'
  return `${value.toLocaleString()} tokens`
}

/**
 * v2.7.0 时间线仅保留「本次对话变更」(自上一轮 iteration 以来的增量),
 * 移除可读性差的「总变更」行;后端字段保留兼容,不删数据
 */
const expandedIterFiles = ref<Set<number>>(new Set())

/**
 * v2.7.1 时间线 Token 行展示「本轮 · 累计」双数值。
 * 后端 iteration 字段只存 cumulativeToken(累计),本轮 delta = 相邻 iteration 做差;
 * 老数据(包括混入 v2.7.0 前 Cursor 旧算法导致的偏高 cumulativeToken)的 delta 仍能正确反映「本轮增量趋势」,
 * 但绝对数值受历史口径影响,需要用户清空 ai-productivity 目录后才会完全回归新口径。
 */
const iterationTokenDeltas = computed<Map<number, number>>(() => {
  const map = new Map<number, number>()
  const iterations = currentDetail.value?.iterations
  if (!iterations || iterations.length === 0) return map
  const sorted = [...iterations].sort((a, b) => a.seq - b.seq)
  let prev = 0
  for (const iter of sorted) {
    const delta = Math.max(0, iter.cumulativeToken - prev)
    map.set(iter.seq, delta)
    prev = iter.cumulativeToken
  }
  return map
})

function toggleIterFiles(id: number) {
  const next = new Set(expandedIterFiles.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIterFiles.value = next
}

function statusChipClass(status: string) {
  if (status === 'in_progress') return 'aip-chip--warning'
  if (status === 'finished') return 'aip-chip--success'
  if (status === 'abandoned') return 'aip-chip--muted'
  return 'aip-chip--muted'
}

function statusLabel(status: string) {
  if (status === 'in_progress') return '进行中'
  if (status === 'finished') return '已完成'
  if (status === 'abandoned') return '已放弃'
  return status
}

function iterationChipClass(kind: string) {
  if (kind === 'first_coding') return 'aip-chip--success'
  if (kind === 'milestone') return 'aip-chip--warning'
  return 'aip-chip--primary'
}

/**
 * 14 天 metric 趋势:基于 requirements 数组按 `latestIterationAt` 分桶。
 *
 * daemon 暂未提供按日聚合接口,前端做一次轻量分桶用于 sparkline / trend chart。
 * 数据稀疏时(< 14 天)前面 padding 0,保持长度恒为 14。
 */
function bucketByDays<T>(
  list: T[],
  days: number,
  pick: (item: T) => { date: string | null; value: number }
): number[] {
  const buckets = new Array<number>(days).fill(0)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const cutoffMs = now.getTime() - (days - 1) * 86400_000
  for (const item of list) {
    const { date, value } = pick(item)
    if (!date) continue
    const t = Date.parse(date)
    if (Number.isNaN(t)) continue
    if (t < cutoffMs) continue
    const dayStart = new Date(t)
    dayStart.setHours(0, 0, 0, 0)
    const idx = Math.floor((dayStart.getTime() - cutoffMs) / 86400_000)
    if (idx < 0 || idx >= days) continue
    buckets[idx] += value
  }
  return buckets
}

const TREND_DAYS = 14

const trendRequirements = computed<number[]>(() =>
  bucketByDays(requirements.value, TREND_DAYS, (r) => ({
    date: r.createdAt,
    value: 1
  }))
)

const trendBoostAvg = computed<number[]>(() => {
  const sums = new Array<number>(TREND_DAYS).fill(0)
  const counts = new Array<number>(TREND_DAYS).fill(0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoffMs = today.getTime() - (TREND_DAYS - 1) * 86400_000
  for (const r of requirements.value) {
    if (r.metrics.boost == null) continue
    const t = r.latestIterationAt ? Date.parse(r.latestIterationAt) : Date.parse(r.updatedAt)
    if (Number.isNaN(t) || t < cutoffMs) continue
    const idx = Math.floor((t - cutoffMs) / 86400_000)
    if (idx < 0 || idx >= TREND_DAYS) continue
    sums[idx] += r.metrics.boost
    counts[idx] += 1
  }
  return sums.map((s, i) => (counts[i] ? Number((s / counts[i]).toFixed(2)) : 0))
})

const trendBugs = computed<number[]>(() =>
  bucketByDays(requirements.value, TREND_DAYS, (r) => ({
    date: r.bugsRefreshedAt ?? r.updatedAt,
    value: r.linkedBugCount
  }))
)

const trendToken = computed<number[]>(() =>
  bucketByDays(requirements.value, TREND_DAYS, (r) => ({
    date: r.latestIterationAt ?? r.updatedAt,
    value: r.metrics.latestCumulativeToken
  }))
)

/** v1.0 数字滚动:首屏从 0 滚到目标值,后续指标变化亦有平滑过渡 */
const totalReqFlow = useNumberFlow(
  computed(() => summary.value?.totalRequirements ?? 0),
  { duration: 900 }
)
const totalBugFlow = useNumberFlow(
  computed(() => summary.value?.totalBugCount ?? 0),
  { duration: 900 }
)
const totalTokenFlow = useNumberFlow(
  computed(() => summary.value?.totalToken ?? 0),
  { duration: 1200 }
)
const avgBoostFlow = useNumberFlow(
  computed(() => summary.value?.averageBoost ?? 0),
  { duration: 900 }
)

onMounted(() => {
  loadList()
})
</script>

<template>
  <section class="aip-workspace">
    <!-- 页面 header:标题 + 副标题 + 主操作 -->
    <header class="aip-workspace__header">
      <div class="aip-workspace__heading">
        <h1 class="aip-workspace__page-title aipt-aurora-text">需求看板</h1>
        <p class="aip-workspace__page-sub">
          全部由本机 daemon 实时聚合 · 共追踪 {{ summary?.totalRequirements ?? 0 }} 个 Jira 需求
        </p>
      </div>
      <div class="aip-workspace__heading-actions">
        <button
          type="button"
          class="aip-workspace__icon-btn"
          :class="{ 'is-loading': loading }"
          title="刷新需求列表与汇总"
          @click="loadList"
        >
          <i class="i-lucide-refresh-cw"></i>
        </button>
      </div>
    </header>

    <!-- 指标卡 (内嵌 sparkline) -->
    <div class="aip-workspace__metrics">
      <article class="aip-metric aip-metric--with-spark">
        <div class="aip-metric__top">
          <div class="aip-metric__icon aip-metric__icon--primary">
            <i class="i-lucide-layout-list"></i>
          </div>
          <div class="aip-metric__body">
            <span class="aip-metric__label">跟踪需求数</span>
            <strong class="aip-metric__value aipt-num">{{ Math.round(totalReqFlow) }}</strong>
            <span class="aip-metric__hint"
              >进行中 {{ summary?.inProgressCount ?? 0 }} · 已完成
              {{ summary?.finishedCount ?? 0 }}</span
            >
          </div>
        </div>
        <SparkLine :data="trendRequirements" color="#6ea7f5" :height="36" />
      </article>

      <article class="aip-metric aip-metric--with-spark aip-metric--highlight">
        <div class="aip-metric__top">
          <div class="aip-metric__icon aip-metric__icon--success">
            <i class="i-lucide-zap"></i>
          </div>
          <div class="aip-metric__body">
            <span class="aip-metric__label">平均提效倍数</span>
            <strong class="aip-metric__value aipt-num">{{
              summary?.averageBoost == null ? '-' : `${avgBoostFlow.toFixed(2)}×`
            }}</strong>
            <span class="aip-metric__hint">公式可在 设置 · 基础 调整</span>
          </div>
        </div>
        <SparkLine :data="trendBoostAvg" color="#9fe5d4" :height="36" />
      </article>

      <article class="aip-metric aip-metric--with-spark">
        <div class="aip-metric__top">
          <div class="aip-metric__icon aip-metric__icon--warm">
            <i class="i-lucide-bug"></i>
          </div>
          <div class="aip-metric__body">
            <span class="aip-metric__label">总关联 Bug</span>
            <strong class="aip-metric__value aipt-num">{{ Math.round(totalBugFlow) }}</strong>
            <span class="aip-metric__hint">来自 Jira 关联查询</span>
          </div>
        </div>
        <SparkLine :data="trendBugs" color="#f0a6c8" :height="36" />
      </article>

      <article class="aip-metric aip-metric--with-spark">
        <div class="aip-metric__top">
          <div class="aip-metric__icon aip-metric__icon--muted">
            <i class="i-lucide-coins"></i>
          </div>
          <div class="aip-metric__body">
            <span class="aip-metric__label">总 Token</span>
            <strong
              class="aip-metric__value aipt-num"
              :title="formatTokenTitle(summary?.totalToken ?? 0)"
              >{{ formatTokenCount(Math.round(totalTokenFlow)) }}</strong
            >
            <span class="aip-metric__hint">Hook 自动累计</span>
          </div>
        </div>
        <SparkLine :data="trendToken" color="#86c5e8" :height="36" />
      </article>
    </div>

    <!-- 工具栏 -->
    <div class="aip-toolbar">
      <ElInput
        v-model="search"
        placeholder="搜索 Jira Key / 标题 / 项目"
        clearable
        style="width: 320px"
      />
      <ElSelect v-model="statusFilter" placeholder="状态筛选" clearable style="width: 180px">
        <ElOption label="进行中" value="in_progress" />
        <ElOption label="已完成" value="finished" />
        <ElOption label="已放弃" value="abandoned" />
      </ElSelect>
      <span class="aip-workspace__toolbar-count">
        共 {{ filteredRequirements.length }} 条需求
      </span>
    </div>

    <!-- 表格 -->
    <div class="aip-table-wrap aip-workspace__table">
      <ElTable
        :data="filteredRequirements"
        v-loading="loading"
        style="width: 100%"
        :empty-text="loading ? '加载中...' : '暂无需求，等待 skill 上报'"
        @row-click="openDetail"
      >
        <ElTableColumn prop="jiraKey" label="Jira Key" width="140" />
        <ElTableColumn label="标题" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="aip-workspace__title-cell">
              <span class="aip-workspace__title-cell-text">{{ row.title }}</span>
              <ElTooltip
                v-if="row.title === row.jiraKey"
                placement="top"
                content="标题未从 Jira 同步,打开详情后将自动尝试刷新;也可点击「从 Jira 刷新」按钮手动拉取"
              >
                <span class="aip-chip aip-chip--warning aip-workspace__title-cell-badge"
                  >未同步</span
                >
              </ElTooltip>
            </span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="提效倍数" width="130">
          <template #default="{ row }">
            <span class="aip-workspace__boost">{{ formatBoost(row.metrics.boost) }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="对话次数" width="110" align="center">
          <template #default="{ row }">{{ row.metrics.codingRuns }}</template>
        </ElTableColumn>
        <ElTableColumn label="Token" width="140" align="right">
          <template #default="{ row }">
            <span :title="formatTokenTitle(row.metrics.latestCumulativeToken)">
              {{ formatTokenCount(row.metrics.latestCumulativeToken) }}
            </span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="耗时" width="110" align="right">
          <template #default="{ row }">{{
            formatMinutes(row.metrics.latestElapsedMinutes)
          }}</template>
        </ElTableColumn>
        <ElTableColumn label="Bug" width="80" align="center">
          <template #default="{ row }">{{ row.linkedBugCount }}</template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="110">
          <template #default="{ row }">
            <span class="aip-chip" :class="statusChipClass(row.status)">{{
              statusLabel(row.status)
            }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="项目" width="140">
          <template #default="{ row }">{{ row.projectSlug || '—' }}</template>
        </ElTableColumn>
      </ElTable>
    </div>

    <!-- 抽屉详情 -->
    <ElDrawer
      v-model="drawerOpen"
      size="880"
      destroy-on-close
      class="aip-drawer"
      :with-header="true"
    >
      <template #header>
        <div class="aip-drawer__header">
          <div class="aip-drawer__header-main">
            <span v-if="currentDetail" class="aip-chip aip-chip--primary aip-drawer__header-chip">{{
              currentDetail.jiraKey
            }}</span>
            <template v-if="currentDetail && !titleEditing">
              <h3 class="aip-drawer__header-title" :title="currentDetail.title">
                {{ currentDetail.title }}
              </h3>
              <button
                type="button"
                class="aip-drawer__iconbtn"
                title="编辑标题"
                @click="startEditTitle"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                class="aip-drawer__iconbtn"
                title="从 Jira 刷新标题"
                :disabled="titleSyncing"
                @click="handleSyncJiraTitle"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  :class="{ 'aip-workspace__refresh-spin': titleSyncing }"
                >
                  <path
                    d="M21 12a9 9 0 1 1-3.6-7.2"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                  <path
                    d="M21 4v5h-5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </template>
            <template v-else-if="currentDetail && titleEditing">
              <ElInput
                v-model="titleDraft"
                size="small"
                class="aip-drawer__header-title-input"
                :maxlength="200"
                @keyup.enter="handleSaveTitle"
                @keyup.esc="cancelEditTitle"
              />
              <button
                type="button"
                class="aip-drawer__iconbtn aip-drawer__iconbtn--primary"
                :disabled="titleSaving"
                title="保存"
                @click="handleSaveTitle"
              >
                保存
              </button>
              <button
                type="button"
                class="aip-drawer__iconbtn"
                :disabled="titleSaving"
                title="取消"
                @click="cancelEditTitle"
              >
                取消
              </button>
            </template>
          </div>
          <div class="aip-drawer__header-actions">
            <button
              v-if="currentDetail"
              type="button"
              class="aip-drawer__iconbtn"
              title="刷新详情(公式或数据变更后联动)"
              :disabled="detailRefreshing"
              @click="handleRefreshDetail"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                :class="{ 'aip-workspace__refresh-spin': detailRefreshing }"
              >
                <path
                  d="M21 12a9 9 0 1 1-3.6-7.2"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <path
                  d="M21 4v5h-5"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <a
              v-if="currentDetail?.jiraUrl"
              :href="currentDetail.jiraUrl"
              target="_blank"
              class="aip-drawer__jira-link"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M14 3h7v7M21 3l-9 9M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>Jira</span>
            </a>
          </div>
        </div>
      </template>

      <div v-if="detailLoading" class="aip-drawer__placeholder">
        <div class="aip-state">
          <div class="aip-state__icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              class="aip-workspace__refresh-spin"
            >
              <path
                d="M21 12a9 9 0 1 1-3.6-7.2"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </div>
          <p>加载中…</p>
        </div>
      </div>
      <div v-else-if="!currentDetail" class="aip-drawer__placeholder">
        <ElEmpty description="暂无数据" />
      </div>
      <div v-else class="aip-drawer__body">
        <ElTabs v-model="drawerActiveTab" class="aip-drawer__tabs">
          <ElTabPane label="需求概览" name="overview">
            <!-- Boost Hero -->
            <div class="aip-drawer__boost">
              <div class="aip-drawer__boost-side">
                <span class="aip-drawer__boost-label">人工预估</span>
                <div v-if="!estimateEditing" class="aip-drawer__boost-value-row">
                  <span class="aip-drawer__boost-value">{{
                    formatMinutes(currentDetail.manualEstimateMinutes)
                  }}</span>
                  <button
                    type="button"
                    class="aip-drawer__iconbtn aip-drawer__iconbtn--ghost"
                    title="编辑人工预估时间"
                    @click="startEditEstimate"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  </button>
                </div>
                <div v-else class="aip-drawer__boost-edit">
                  <ElInputNumber
                    v-model="estimateHoursDraft"
                    :min="0"
                    :step="0.5"
                    :precision="1"
                    size="small"
                    controls-position="right"
                    class="aip-drawer__boost-input"
                  />
                  <span class="aip-drawer__boost-unit">小时</span>
                  <button
                    type="button"
                    class="aip-drawer__iconbtn aip-drawer__iconbtn--primary"
                    :disabled="estimateSaving"
                    @click="handleSaveEstimate"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    class="aip-drawer__iconbtn"
                    :disabled="estimateSaving"
                    @click="cancelEditEstimate"
                  >
                    取消
                  </button>
                </div>
                <span class="aip-drawer__boost-sub">作为提效公式的分子</span>
              </div>
              <div class="aip-drawer__boost-arrow" aria-hidden="true">
                <svg width="20" height="10" viewBox="0 0 20 10" fill="none">
                  <path
                    d="M1 5h18m0 0-4-4m4 4-4 4"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <div class="aip-drawer__boost-center">
                <span class="aip-drawer__boost-label aip-drawer__boost-label--center"
                  >提效倍数</span
                >
                <span class="aip-drawer__boost-main">{{
                  formatBoost(currentDetail.metrics.boost)
                }}</span>
                <span class="aip-drawer__boost-formula" title="boost = 人工预估 / 加权耗时"
                  >人工预估 ÷ 加权耗时</span
                >
              </div>
              <div class="aip-drawer__boost-arrow" aria-hidden="true">
                <svg width="20" height="10" viewBox="0 0 20 10" fill="none">
                  <path
                    d="M19 5H1m0 0 4-4M1 5l4 4"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <div class="aip-drawer__boost-side aip-drawer__boost-side--right">
                <span class="aip-drawer__boost-label">
                  墙钟耗时
                  <span
                    v-if="currentDetail.finishedAt"
                    class="aip-drawer__frozen-chip"
                    :title="`需求已于 ${new Date(currentDetail.finishedAt).toLocaleString()} 定格,墙钟与 boost 不再随完成后的自动上报变动`"
                    >已定格</span
                  >
                </span>
                <span
                  class="aip-drawer__boost-value"
                  :title="
                    currentDetail.finishedAt
                      ? '需求已完成,墙钟耗时定格在完成时刻,不再随后续自动上报膨胀'
                      : '任务从开始到现在的墙钟耗时(含用户离开 / 阅读 / 并行其它任务的空闲);并行多任务时墙钟会膨胀,新公式通过权重削减它的影响'
                  "
                >
                  {{ formatMinutes(currentDetail.metrics.latestElapsedMinutes) }}
                </span>
                <span
                  class="aip-drawer__boost-sub"
                  title="各轮对话 thinkSeconds(用户提交 → AI 答完)的累加值,剔除空闲后 AI 实际参与的时长。在并行多任务场景下比墙钟更准。"
                >
                  AI 工作累计
                  <strong class="aipt-num">{{
                    formatThinkDuration(currentDetail.metrics.totalThinkSeconds)
                  }}</strong>
                </span>
              </div>
            </div>

            <!-- 指标 -->
            <article class="aip-card aip-card--flat aip-drawer__section">
              <header class="aip-card__header">
                <h3 class="aip-card__title">指标</h3>
                <span class="aip-card__meta">含 boost 公式的核心输入</span>
              </header>
              <div class="aip-drawer__metric-grid">
                <div class="aip-drawer__metric-tile">
                  <span class="aip-drawer__metric-label">对话次数</span>
                  <strong class="aip-drawer__metric-num aipt-num">{{
                    currentDetail.metrics.codingRuns
                  }}</strong>
                </div>
                <div class="aip-drawer__metric-tile">
                  <span class="aip-drawer__metric-label">累计 Token</span>
                  <strong
                    class="aip-drawer__metric-num aipt-num"
                    :title="formatTokenTitle(currentDetail.metrics.latestCumulativeToken)"
                    >{{ formatTokenCount(currentDetail.metrics.latestCumulativeToken) }}</strong
                  >
                </div>
                <div class="aip-drawer__metric-tile">
                  <span
                    class="aip-drawer__metric-label"
                    title="boost 公式分母 = 加权耗时 × tokenPenalty"
                    >加权耗时</span
                  >
                  <strong
                    class="aip-drawer__metric-num aipt-num"
                    :title="`= (1 − wThink) × 墙钟 + wThink × (AI 工作累计 / 60),单位:分钟。当前本需求 wThink = ${Math.round((currentDetail.effectiveFormula?.wThink ?? 0) * 100)}%`"
                    >{{ formatMinutes(currentDetail.metrics.effectiveMinutes) }}</strong
                  >
                </div>
                <div class="aip-drawer__metric-tile">
                  <span
                    class="aip-drawer__metric-label"
                    title="可选 token 软上限惩罚,默认关闭时恒为 ×1"
                    >Token 惩罚</span
                  >
                  <strong class="aip-drawer__metric-num aipt-num"
                    >×{{ currentDetail.metrics.tokenPenalty }}</strong
                  >
                </div>
              </div>
              <div class="aip-drawer__status-row">
                <span class="aip-drawer__status-label">状态</span>
                <ElSelect
                  v-model="statusDraft"
                  size="small"
                  class="aip-drawer__status-select"
                  @change="handleStatusChange"
                >
                  <ElOption label="进行中" value="in_progress" />
                  <ElOption label="已完成" value="finished" />
                  <ElOption label="已放弃" value="abandoned" />
                </ElSelect>
              </div>
            </article>

            <!-- 提效公式(本需求) -->
            <article class="aip-card aip-card--flat aip-drawer__section aip-drawer__formula">
              <header class="aip-card__header">
                <h3 class="aip-card__title">提效公式(本需求)</h3>
                <span class="aip-card__meta"
                  >仅影响本需求 boost · Token 软上限仍在设置页全局配置</span
                >
              </header>
              <p class="aip-card__caption aip-drawer__formula-caption">
                新建需求时会把当下全局 wThink 快照写入本需求,之后调全局不再影响这里。
                串行需求建议把权重往墙钟推,并行多任务建议把权重往 AI 工作时间推。
              </p>
              <section class="aip-drawer__formula-panel">
                <header class="aip-drawer__formula-legend">
                  <span class="aip-drawer__formula-legend-title">时间权重</span>
                  <span class="aip-drawer__formula-legend-hint">
                    AI 工作 <strong>{{ wThinkDraftPercent }}%</strong>
                    <span class="aip-drawer__formula-legend-sep">·</span>
                    墙钟 <strong>{{ wElapsedDraftPercent }}%</strong>
                  </span>
                </header>
                <div class="aip-drawer__formula-slider">
                  <ElSlider
                    v-model="wThinkDraftPercent"
                    :min="0"
                    :max="100"
                    :step="5"
                    :marks="{ 0: '0%', 25: '25%', 50: '50%', 75: '75%', 100: '100%' }"
                  />
                  <div class="aip-drawer__formula-slider-tips">
                    <span>← 纯墙钟(单线程)</span>
                    <span>50 / 50</span>
                    <span>纯 AI 工作(强并行) →</span>
                  </div>
                </div>
              </section>
              <div class="aip-drawer__formula-actions">
                <ElButton
                  type="primary"
                  size="small"
                  :loading="wThinkSaving"
                  :disabled="!wThinkDirty"
                  @click="handleSaveWThink"
                >
                  保存权重
                </ElButton>
              </div>
            </article>

            <!-- 关联 Bug -->
            <article class="aip-card aip-card--flat aip-drawer__section">
              <header class="aip-card__header">
                <h3 class="aip-card__title">关联 Bug</h3>
                <button
                  type="button"
                  class="aip-drawer__refresh-btn"
                  :disabled="bugRefreshing"
                  @click="handleRefreshBugs"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    :class="{ 'aip-workspace__refresh-spin': bugRefreshing }"
                  >
                    <path
                      d="M21 12a9 9 0 1 1-3.6-7.2"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                    <path
                      d="M21 4v5h-5"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  {{ bugRefreshing ? '拉取中…' : '刷新' }}
                </button>
              </header>
              <div class="aip-drawer__bug">
                <div class="aip-drawer__bug-main">
                  <span class="aip-drawer__bug-num aipt-num">{{
                    currentDetail.linkedBugCount
                  }}</span>
                  <span class="aip-drawer__bug-caption">来自 Jira 关联查询的 Bug 数量</span>
                </div>
                <dl class="aip-drawer__bug-meta">
                  <div class="aip-drawer__bug-meta-row">
                    <dt>JQL</dt>
                    <dd>
                      <code class="aip-inline-code">{{
                        currentDetail.linkedBugJql || '(未配置)'
                      }}</code>
                    </dd>
                  </div>
                  <div class="aip-drawer__bug-meta-row">
                    <dt>最近刷新</dt>
                    <dd>
                      <code class="aip-inline-code">{{
                        currentDetail.bugsRefreshedAt ?? '从未'
                      }}</code>
                    </dd>
                  </div>
                </dl>
              </div>
            </article>

            <!-- Iteration 时间线 -->
            <article class="aip-card aip-card--flat aip-drawer__section">
              <header class="aip-card__header">
                <h3 class="aip-card__title">Iteration 时间线</h3>
                <div class="aip-drawer__timeline-header-actions">
                  <span class="aip-card__meta">共 {{ currentDetail.iterations.length }} 条</span>
                  <button
                    type="button"
                    class="aip-drawer__refresh-btn"
                    :disabled="mergeSplitRunning"
                    title="合并 Cursor stop-hook 兜底产生的拆分对话(前空 + 后满)"
                    @click="handleMergeSplitIterations"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M8 6v8a4 4 0 0 0 4 4h4M16 18l-3-3m3 3-3 3"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                      <path
                        d="M16 6v8a4 4 0 0 1-4 4H8"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    {{ mergeSplitRunning ? '整理中…' : '数据整理' }}
                  </button>
                </div>
              </header>
              <ol v-if="currentDetail.iterations.length" class="aip-flow">
                <li v-for="iter in currentDetail.iterations" :key="iter.seq" class="aip-flow-step">
                  <span class="aip-flow-dot" />
                  <div class="aip-flow-body">
                    <div class="aip-drawer__timeline-head">
                      <span class="aip-chip" :class="iterationChipClass(iter.kind)"
                        >#{{ iter.seq }} {{ iter.kind }}</span
                      >
                      <span
                        v-if="iter.source && iter.source !== 'unknown'"
                        class="aip-chip"
                        :class="
                          iter.source === 'cursor'
                            ? 'aip-chip--source-cursor'
                            : 'aip-chip--source-claude'
                        "
                        >{{ iter.source === 'cursor' ? 'Cursor' : 'Claude Code' }}</span
                      >
                      <span
                        v-if="iter.modelName"
                        class="aip-chip aip-chip--muted aip-drawer__timeline-model"
                        >{{ iter.modelName }}</span
                      >
                      <span class="aip-drawer__timeline-time">{{
                        new Date(iter.reportedAt).toLocaleString()
                      }}</span>
                    </div>
                    <div class="aip-drawer__timeline-body">
                      <div>
                        Token:
                        <span
                          class="aip-drawer__timeline-token-current"
                          :title="`本轮: ${formatTokenTitle(iterationTokenDeltas.get(iter.seq) ?? 0)} / 累计: ${formatTokenTitle(iter.cumulativeToken)}`"
                          >本轮
                          {{ formatTokenCount(iterationTokenDeltas.get(iter.seq) ?? 0) }}</span
                        >
                        <span class="aip-drawer__timeline-token-sep"> · 累计 </span>
                        <span :title="formatTokenTitle(iter.cumulativeToken)">{{
                          formatTokenCount(iter.cumulativeToken)
                        }}</span>
                        · 累计耗时: {{ formatMinutes(iter.elapsedMinutes) }} ·
                        <span :title="buildThinkSecondsTooltip(iter)">
                          本轮 AI 思考: {{ formatThinkSeconds(iter.thinkSeconds) }}
                        </span>
                      </div>
                      <div
                        v-if="iter.diffFiles || iter.changedFiles.length"
                        class="aip-drawer__timeline-diff-row"
                      >
                        <span
                          class="aip-drawer__timeline-diff-label aip-drawer__timeline-diff-label--accent"
                          >本轮变更</span
                        >
                        <span>
                          {{ iter.diffFiles }} files +{{ iter.diffInsertions }} -{{
                            iter.diffDeletions
                          }}
                        </span>
                        <button
                          v-if="iter.changedFiles.length"
                          type="button"
                          class="aip-drawer__linkbtn aip-drawer__timeline-files-btn"
                          @click="toggleIterFiles(iter.seq)"
                        >
                          {{
                            expandedIterFiles.has(iter.seq)
                              ? '收起'
                              : `展开 ${iter.changedFiles.length} 个改动文件`
                          }}
                        </button>
                      </div>
                      <div
                        v-if="iter.changedFiles.length && expandedIterFiles.has(iter.seq)"
                        class="aip-drawer__timeline-files"
                      >
                        <span
                          v-for="file in iter.changedFiles"
                          :key="`iter-${file.path}`"
                          class="aip-chip aip-chip--muted aip-drawer__timeline-file"
                          :title="file.path"
                          ><b>{{ file.status }}</b
                          >{{ file.path }}</span
                        >
                      </div>
                      <div v-if="iter.conversationSummary" class="aip-drawer__timeline-summary">
                        <div class="aip-drawer__timeline-summary-header">
                          <span class="aip-drawer__timeline-summary-label">AI 对话总结</span>
                          <span
                            class="aip-chip"
                            :class="
                              iter.conversationSummary.type === 'coding'
                                ? 'aip-chip--primary'
                                : 'aip-chip--muted'
                            "
                            >{{
                              iter.conversationSummary.type === 'coding' ? '代码改动' : '沟通讨论'
                            }}</span
                          >
                        </div>
                        <div class="aip-drawer__timeline-summary-oneline">
                          {{ iter.conversationSummary.oneLine }}
                        </div>
                        <div
                          v-if="
                            iter.conversationSummary.type === 'coding' &&
                            iter.conversationSummary.changeScope
                          "
                          class="aip-drawer__timeline-summary-body"
                        >
                          <span class="aip-drawer__timeline-summary-subtitle">改动范围</span>
                          <p>{{ iter.conversationSummary.changeScope }}</p>
                        </div>
                        <div
                          v-else-if="
                            iter.conversationSummary.type === 'communication' &&
                            iter.conversationSummary.discussion
                          "
                          class="aip-drawer__timeline-summary-body"
                        >
                          <span class="aip-drawer__timeline-summary-subtitle">讨论内容</span>
                          <p>{{ iter.conversationSummary.discussion }}</p>
                        </div>
                      </div>
                      <div
                        v-else-if="iter.kind !== 'init'"
                        class="aip-drawer__timeline-summary aip-drawer__timeline-summary--empty"
                      >
                        本轮无 AI 对话总结
                      </div>
                    </div>
                  </div>
                </li>
              </ol>
              <p v-else class="aip-drawer__empty-hint">暂无上报</p>
            </article>
          </ElTabPane>
          <ElTabPane label="复盘报告" name="retrospective" lazy>
            <RetrospectiveReportPanel
              :jira-key="currentDetail.jiraKey"
              :open="drawerActiveTab === 'retrospective'"
              :requirement="currentDetail"
              :iterations="currentDetail.iterations"
            />
          </ElTabPane>
        </ElTabs>
      </div>
    </ElDrawer>
  </section>
</template>

<style scoped>
.aip-workspace {
  display: grid;
  gap: var(--aipt-space-5);
  padding: 0;
  max-width: var(--aipt-content-max-w);
  margin: 0 auto;
}

/* ===== Page header ===== */
.aip-workspace__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-workspace__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-workspace__page-title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.aip-workspace__page-sub {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-muted);
}

.aip-workspace__heading-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
}

.aip-workspace__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  color: var(--aipt-text-secondary);
  cursor: pointer;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-workspace__icon-btn:hover {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}

.aip-workspace__icon-btn i {
  font-size: 16px;
}

.aip-workspace__icon-btn.is-loading i {
  animation: aip-spin 1s linear infinite;
}

/* ===== Metrics ===== */
.aip-workspace__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--aipt-space-3);
}

.aip-metric--with-spark {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-2);
  padding: var(--aipt-space-4) var(--aipt-space-4);
}

.aip-metric__top {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
}

.aip-metric__top .aip-metric__body {
  flex: 1;
}

.aip-metric__top .aip-metric__icon i {
  font-size: 18px;
}

.aip-workspace__toolbar-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-workspace__refresh-spin {
  animation: aip-spin 1s linear infinite;
}

@keyframes aip-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 表格 wrap 调整 progress 条颜色 */
.aip-workspace__table :deep(.el-progress-bar__inner) {
  background: var(--aipt-gradient-aurora);
}

.aip-workspace__table :deep(.el-progress) {
  margin-right: 8px;
}

.aip-workspace__table :deep(.el-progress-bar__outer) {
  background: var(--aipt-surface-strong);
}

.aip-workspace__table :deep(.el-table__row) {
  cursor: pointer;
  transition: background var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-workspace__table :deep(.el-table__row:hover) {
  box-shadow: inset 0 0 0 1px rgba(110, 167, 245, 0.2);
}

.aip-workspace__boost {
  font-weight: 700;
  font-size: 14px;
  background: var(--aipt-gradient-mint);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  font-variant-numeric: tabular-nums;
}

.aip-workspace__title-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.aip-workspace__title-cell-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aip-workspace__title-cell-badge {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 6px;
}

/* ===== Drawer ===== */
.aip-drawer :deep(.el-drawer__header) {
  margin-bottom: 0;
  padding: 16px 24px 14px;
  border-bottom: 1px solid var(--aipt-border);
  background: var(--aipt-surface-soft);
  align-items: center;
  gap: var(--aipt-space-3);
}

.aip-drawer :deep(.el-drawer__close-btn) {
  width: 32px;
  height: 32px;
  border-radius: var(--aipt-radius-sm);
  color: var(--aipt-text-muted);
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer :deep(.el-drawer__close-btn:hover) {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}

.aip-drawer :deep(.el-drawer__body) {
  padding: 0 !important;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.aip-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-3);
  flex: 1;
  min-width: 0;
}

.aip-drawer__header-main {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  flex-wrap: wrap;
  min-width: 0;
  flex: 1;
}

.aip-drawer__header-chip {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  font-weight: 600;
  flex-shrink: 0;
}

.aip-drawer__header-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  line-height: 1.4;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 460px;
}

.aip-drawer__header-title-input {
  width: 320px;
}

.aip-drawer__header-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
  flex-shrink: 0;
}

/* 统一的 icon button — header / boost / metric 都用同一个 */
.aip-drawer__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--aipt-radius-sm);
  border: 1px solid var(--aipt-border);
  background: var(--aipt-surface);
  color: var(--aipt-text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer__iconbtn:hover:not(:disabled) {
  background: var(--aipt-surface-hover);
  border-color: var(--aipt-border-strong);
  color: var(--aipt-aurora-1);
}

.aip-drawer__iconbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.aip-drawer__iconbtn--primary {
  background: var(--aipt-gradient-aurora);
  border-color: transparent;
  color: var(--aipt-text-on-accent);
  box-shadow: var(--aipt-shadow-glow);
}

.aip-drawer__iconbtn--primary:hover:not(:disabled) {
  color: var(--aipt-text-on-accent);
  box-shadow: var(--aipt-shadow-glow-strong);
}

.aip-drawer__iconbtn--ghost {
  background: transparent;
  border-color: transparent;
}

.aip-drawer__iconbtn--ghost:hover:not(:disabled) {
  background: var(--aipt-surface);
  border-color: var(--aipt-border);
}

.aip-drawer__jira-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--aipt-radius-sm);
  background: rgba(110, 167, 245, 0.12);
  border: 1px solid rgba(110, 167, 245, 0.28);
  color: var(--aipt-aurora-1);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer__jira-link:hover {
  background: rgba(110, 167, 245, 0.2);
}

.aip-drawer__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.aip-drawer__placeholder {
  padding: var(--aipt-space-6);
}

/* Tabs — 紧贴 header 下沿,做成"工具栏 tab"风格 */
.aip-drawer__tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.aip-drawer__tabs :deep(.el-tabs__header) {
  margin: 0;
  padding: 0 24px;
  background: var(--aipt-surface-soft);
  border-bottom: 1px solid var(--aipt-border);
}

.aip-drawer__tabs :deep(.el-tabs__nav-wrap)::after {
  display: none;
}

.aip-drawer__tabs :deep(.el-tabs__nav) {
  border: none !important;
}

.aip-drawer__tabs :deep(.el-tabs__item) {
  height: 42px;
  line-height: 42px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-muted);
  padding: 0 var(--aipt-space-4) !important;
  border: none !important;
  transition: color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer__tabs :deep(.el-tabs__item:hover) {
  color: var(--aipt-text);
}

.aip-drawer__tabs :deep(.el-tabs__item.is-active) {
  color: var(--aipt-aurora-1);
}

.aip-drawer__tabs :deep(.el-tabs__active-bar) {
  background: var(--aipt-gradient-aurora) !important;
  height: 2px;
  border-radius: 1px;
  box-shadow: 0 0 12px rgba(110, 167, 245, 0.5);
}

.aip-drawer__tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  padding: var(--aipt-space-5) var(--aipt-space-6) var(--aipt-space-6);
  overflow-y: auto;
}

.aip-drawer__tabs :deep(.el-tab-pane) {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
}

.aip-drawer__section {
  padding: var(--aipt-space-4) var(--aipt-space-5);
}

/* ===== Boost Hero ===== */
.aip-drawer__boost {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto 1.05fr auto 1fr;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-5) var(--aipt-space-6);
  border-radius: var(--aipt-radius-lg);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  backdrop-filter: blur(var(--aipt-blur-md)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--aipt-blur-md)) saturate(140%);
  overflow: hidden;
  box-shadow: var(--aipt-shadow-soft);
}

.aip-drawer__boost::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: var(--aipt-gradient-aurora);
  opacity: 0.55;
}

.aip-drawer__boost::after {
  content: '';
  position: absolute;
  right: -120px;
  top: -120px;
  width: 280px;
  height: 280px;
  background: var(--aipt-gradient-mint);
  opacity: 0.14;
  filter: blur(70px);
  pointer-events: none;
  border-radius: 50%;
}

.aip-drawer__boost > * {
  position: relative;
  z-index: 1;
}

.aip-drawer__boost-side {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.aip-drawer__boost-side--right {
  align-items: flex-end;
  text-align: right;
}

.aip-drawer__boost-label {
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 600;
}

.aip-drawer__boost-label--center {
  text-align: center;
}

.aip-drawer__frozen-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--aipt-fill-muted, rgba(100, 116, 139, 0.14));
  color: var(--aipt-text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  vertical-align: middle;
  cursor: help;
}

.aip-drawer__boost-value-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.aip-drawer__boost-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1.1;
}

.aip-drawer__boost-sub {
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.aip-drawer__boost-sub strong {
  color: var(--aipt-text-secondary);
  font-weight: 700;
  font-size: 12px;
  margin-left: 4px;
}

.aip-drawer__boost-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.aip-drawer__boost-input {
  width: 110px;
}

.aip-drawer__boost-unit {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-drawer__boost-arrow {
  color: var(--aipt-text-faint);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.aip-drawer__boost-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0 var(--aipt-space-2);
}

.aip-drawer__boost-main {
  font-size: 44px;
  font-weight: 800;
  background: var(--aipt-gradient-mint);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  filter: drop-shadow(0 4px 24px rgba(159, 229, 212, 0.32));
}

.aip-drawer__boost-formula {
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.02em;
}

/* ===== 指标网格 ===== */
.aip-drawer__metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--aipt-space-3);
}

.aip-drawer__metric-tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer__metric-tile:hover {
  background: var(--aipt-surface);
  border-color: var(--aipt-border);
}

.aip-drawer__metric-label {
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 600;
}

.aip-drawer__metric-num {
  color: var(--aipt-text-strong);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.01em;
}

.aip-drawer__status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-3);
  margin-top: var(--aipt-space-3);
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
}

.aip-drawer__status-label {
  font-size: 12px;
  color: var(--aipt-text-secondary);
  font-weight: 600;
}

.aip-drawer__status-select {
  width: 140px;
}

/* ===== 提效公式(本需求)===== */
.aip-drawer__formula-caption {
  margin: 0 0 var(--aipt-space-3);
}

.aip-drawer__formula-panel {
  padding: var(--aipt-space-3) var(--aipt-space-4) var(--aipt-space-4);
  border: 1px solid var(--aipt-border-faint);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
}

.aip-drawer__formula-legend {
  display: inline-flex;
  align-items: baseline;
  gap: var(--aipt-space-2);
}

.aip-drawer__formula-legend-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong, var(--aipt-text));
}

.aip-drawer__formula-legend-hint {
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aip-drawer__formula-legend-hint strong {
  font-weight: 600;
  color: var(--aipt-text-strong, var(--aipt-text));
  font-variant-numeric: tabular-nums;
}

.aip-drawer__formula-legend-sep {
  margin: 0 4px;
  color: var(--aipt-text-muted);
}

.aip-drawer__formula-slider {
  padding: 0 12px;
  margin-top: 6px;
}

.aip-drawer__formula-slider :deep(.el-slider__marks-text) {
  font-size: 11px;
  color: var(--aipt-text-muted);
  font-variant-numeric: tabular-nums;
}

.aip-drawer__formula-slider :deep(.el-slider) {
  --el-slider-main-bg-color: var(--aipt-aurora-2, #4f7cff);
  margin-bottom: 4px;
}

.aip-drawer__formula-slider-tips {
  display: flex;
  justify-content: space-between;
  margin-top: 24px;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-drawer__formula-slider-tips span:nth-child(2) {
  color: var(--aipt-text-secondary);
}

.aip-drawer__formula-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--aipt-space-3);
}

/* ===== Bug ===== */
.aip-drawer__bug {
  display: flex;
  gap: var(--aipt-space-5);
  flex-wrap: wrap;
}

.aip-drawer__bug-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-state-warning-soft);
  border: 1px solid rgba(245, 196, 137, 0.3);
  min-width: 160px;
}

.aip-drawer__bug-num {
  font-size: 28px;
  font-weight: 800;
  color: var(--aipt-state-warning);
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.aip-drawer__bug-caption {
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.02em;
}

.aip-drawer__bug-meta {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-2);
  margin: 0;
}

.aip-drawer__bug-meta-row {
  display: flex;
  align-items: baseline;
  gap: var(--aipt-space-3);
}

.aip-drawer__bug-meta-row dt {
  flex-shrink: 0;
  width: 72px;
  font-size: 11px;
  color: var(--aipt-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 600;
}

.aip-drawer__bug-meta-row dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.aip-drawer__refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(110, 167, 245, 0.28);
  border-radius: var(--aipt-radius-sm);
  background: rgba(110, 167, 245, 0.1);
  color: var(--aipt-aurora-1);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-drawer__refresh-btn:hover:not(:disabled) {
  background: rgba(110, 167, 245, 0.18);
  border-color: rgba(110, 167, 245, 0.42);
}

.aip-drawer__refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* 时间线 header 操作区:meta 与「数据整理」按钮并排靠右 */
.aip-drawer__timeline-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

/* 时间线 */
.aip-drawer__timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.aip-drawer__timeline-time {
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.aip-drawer__timeline-model {
  font-size: 10.5px;
  letter-spacing: 0.02em;
  text-transform: lowercase;
}

.aip-drawer__timeline-files-btn {
  margin-left: 8px;
}

.aip-drawer__timeline-diff-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.aip-drawer__timeline-diff-label {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(96, 114, 153, 0.1);
  color: var(--text-soft);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.aip-drawer__timeline-diff-label--accent {
  background: rgba(79, 110, 245, 0.12);
  color: var(--accent-primary, #4f6ef5);
}

.aip-drawer__timeline-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(96, 114, 153, 0.05);
  border: 1px dashed rgba(96, 114, 153, 0.18);
}

.aip-drawer__timeline-file {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  letter-spacing: 0;
}

.aip-drawer__timeline-file b {
  display: inline-block;
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(79, 110, 245, 0.12);
  color: var(--accent-primary, #4f6ef5);
  font-weight: 700;
  font-size: 10px;
}

.aip-drawer__timeline-token-current {
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.aip-drawer__timeline-token-sep {
  color: var(--text-muted);
}

.aip-drawer__timeline-body {
  display: grid;
  gap: 3px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.aip-drawer__timeline-note {
  margin-top: 4px;
  padding: 6px 10px;
  background: rgba(79, 110, 245, 0.06);
  border-left: 3px solid var(--accent-primary, #4f6ef5);
  border-radius: 4px;
}

.aip-drawer__timeline-summary {
  margin-top: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(52, 199, 89, 0.06);
  border-left: 3px solid rgba(52, 199, 89, 0.5);
}

.aip-drawer__timeline-summary--empty {
  background: rgba(96, 114, 153, 0.04);
  border-left-color: rgba(96, 114, 153, 0.25);
  color: var(--text-muted);
  font-style: italic;
  font-size: 12px;
}

.aip-drawer__timeline-summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.aip-drawer__timeline-summary-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #2d9a53;
  text-transform: uppercase;
}

.aip-drawer__timeline-summary-oneline {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.5;
  margin-bottom: 6px;
  word-break: break-word;
}

.aip-drawer__timeline-summary-body {
  margin: 0;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
  word-break: break-word;
}

.aip-drawer__timeline-summary-body p {
  margin: 2px 0 0;
  white-space: pre-wrap;
}

.aip-drawer__timeline-summary-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.aip-drawer__linkbtn {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-primary, #4f6ef5);
  cursor: pointer;
}

.aip-drawer__linkbtn:hover {
  text-decoration: underline;
}

.aip-drawer__empty-hint {
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

@media (max-width: 720px) {
  .aip-drawer__boost {
    grid-template-columns: 1fr;
    gap: var(--aipt-space-3);
    text-align: center;
  }
  .aip-drawer__boost-side,
  .aip-drawer__boost-side--right {
    align-items: center;
    text-align: center;
  }
  .aip-drawer__boost-arrow {
    transform: rotate(90deg);
    margin: 0 auto;
  }
  .aip-drawer__header-title {
    max-width: 220px;
  }
  .aip-drawer__tabs :deep(.el-tabs__content) {
    padding: var(--aipt-space-4);
  }
}

@media (max-width: 640px) {
  .aip-workspace {
    gap: var(--aipt-space-4);
  }
  .aip-workspace__page-title {
    font-size: 22px;
  }
}
</style>
