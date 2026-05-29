<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ElButton,
  ElDrawer,
  ElEmpty,
  ElInput,
  ElMessage,
  ElPopconfirm,
  ElSelect,
  ElOption,
  ElTable,
  ElTableColumn,
  ElTooltip
} from 'element-plus'
import { useRoute, useRouter } from 'vue-router'

import {
  AgentRequestError,
  deleteLesson,
  getLessonDetail,
  listHarnessSuggestions,
  listLessons,
  type AggregatedHarnessSuggestion,
  type HarnessSuggestionCategory,
  type LessonDetail,
  type LessonScope,
  type LessonSummary,
  type LessonType
} from '../api'
import DonutMetric from '../charts/DonutMetric.vue'
import {
  HARNESS_CATEGORY_CHIP,
  HARNESS_CATEGORY_LABEL,
  HARNESS_CATEGORY_OPTIONS,
  HARNESS_CATEGORY_ORDER,
  HARNESS_SCOPE_CHIP,
  buildSuggestionMarkdown,
  harnessScopeLabel,
  normalizeHarnessScope
} from '../lib/harness'
import { renderMarkdown } from '../lib/markdown'
import '../styles/aip-shared.css'

/**
 * v2.16.0 P0 复盘经验 Tab
 *
 * 数据源:agent /ai-productivity/lessons (panel-origin 放行,本地直读 INDEX.json)
 * 触发提取:由 IDE 内 LLM 通过 lessons-extract skill + 两个 MCP 工具完成,
 *          看板侧不直接调 LLM,只做展示/筛选/删除
 */

const TYPE_META: Record<LessonType, { label: string; chip: string; tooltip: string }> = {
  pitfall: {
    label: '踩的坑',
    chip: 'aip-chip--danger',
    tooltip: '同一问题反复出现 / 修复路径不稳定 / 错误链路'
  },
  rule: {
    label: '沉淀规则',
    chip: 'aip-chip--primary',
    tooltip: '用户明确说「以后必须」/ 多轮反复重申的硬约束'
  },
  'best-practice': {
    label: '最佳实践',
    chip: 'aip-chip--success',
    tooltip: '高 boost / changeScope 干净 / 一气呵成的复杂改动'
  },
  'split-suggestion': {
    label: '拆分建议',
    chip: 'aip-chip--warning',
    tooltip: '单轮跨多个无关模块 → 拆;相邻轮 changeScope 相似 → 合'
  },
  tooling: {
    label: '工具改进',
    chip: 'aip-chip--muted',
    tooltip: 'watcher / hook / sentinel / 上游 API 等工具链改进'
  }
}
const TYPE_OPTIONS: Array<{ value: LessonType; label: string }> = (
  Object.keys(TYPE_META) as LessonType[]
).map((k) => ({ value: k, label: TYPE_META[k].label }))

const TRUST_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' }
const TRUST_CHIP: Record<string, string> = {
  high: 'aip-chip--success',
  medium: 'aip-chip--primary',
  low: 'aip-chip--muted'
}

const SOURCE_LABEL: Record<string, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  manual: '手动'
}

const TRIGGER_HINT = '需求复盘 当前需求 INSTANT-XXXX'

/**
 * v2.17.0「范围」筛选下拉选项构造规则:
 * - 'all' = 不过滤
 * - 'general' = 仅展示 scope='general'(通用)
 * - 'unscoped' = 仅展示 scope=''(老数据「未分类」)
 * - 其余 = 具体 projectSlug 精确匹配(动态从 lessons 投影得出)
 */
type ScopeFilterValue = 'all' | 'general' | 'unscoped' | string

function normalizeScope(scope: LessonScope | undefined): 'general' | 'project' | '' {
  if (scope === 'general' || scope === 'project') return scope
  return ''
}

const loading = ref(false)
const lessons = ref<LessonSummary[]>([])
const errorMessage = ref('')

const filterType = ref<LessonType | ''>('')
const filterJiraKey = ref<string>('')
const filterTag = ref('')
const filterQ = ref('')
const filterScope = ref<ScopeFilterValue>('all')

const drawerOpen = ref(false)
const detailLoading = ref(false)
const currentDetail = ref<LessonDetail | null>(null)
const deletingId = ref<string | null>(null)

const jiraKeyOptions = computed(() => {
  const set = new Set<string>()
  for (const l of lessons.value) if (l.jiraKey) set.add(l.jiraKey)
  return Array.from(set).sort()
})

/** v2.17.0 投影出曾经出现过的 projectSlug,用于「范围」下拉动态选项 */
const projectSlugOptions = computed(() => {
  const set = new Set<string>()
  for (const l of lessons.value) {
    if (normalizeScope(l.scope) === 'project' && l.projectSlug) set.add(l.projectSlug)
  }
  return Array.from(set).sort()
})

const hasUnscopedLessons = computed(() => lessons.value.some((l) => normalizeScope(l.scope) === ''))

const filteredLessons = computed(() => {
  const tagLower = filterTag.value.trim().toLowerCase()
  const qLower = filterQ.value.trim().toLowerCase()
  const scopeFilter = filterScope.value
  return lessons.value.filter((row) => {
    if (filterType.value && row.type !== filterType.value) return false
    if (filterJiraKey.value && row.jiraKey !== filterJiraKey.value) return false
    if (tagLower && !row.tags.some((t) => t.toLowerCase().includes(tagLower))) return false
    if (
      qLower &&
      !(row.title.toLowerCase().includes(qLower) || row.jiraKey.toLowerCase().includes(qLower))
    )
      return false
    if (scopeFilter !== 'all') {
      const normalized = normalizeScope(row.scope)
      if (scopeFilter === 'general' && normalized !== 'general') return false
      if (scopeFilter === 'unscoped' && normalized !== '') return false
      if (
        scopeFilter !== 'general' &&
        scopeFilter !== 'unscoped' &&
        !(normalized === 'project' && row.projectSlug === scopeFilter)
      )
        return false
    }
    return true
  })
})

const stats = computed(() => {
  const counts: Record<LessonType, number> = {
    pitfall: 0,
    rule: 0,
    'best-practice': 0,
    'split-suggestion': 0,
    tooling: 0
  }
  for (const row of lessons.value) counts[row.type] = (counts[row.type] ?? 0) + 1
  return counts
})

const TYPE_COLOR: Record<LessonType, string> = {
  pitfall: '#f08597',
  rule: '#6ea7f5',
  'best-practice': '#9fe5d4',
  'split-suggestion': '#f5c489',
  tooling: 'rgba(255,255,255,0.28)'
}

const typeDistribution = computed(() => {
  const slices: Array<{ name: string; value: number; color: string }> = []
  for (const opt of TYPE_OPTIONS) {
    const v = stats.value[opt.value]
    if (v <= 0) continue
    slices.push({
      name: TYPE_META[opt.value].label,
      value: v,
      color: TYPE_COLOR[opt.value]
    })
  }
  return slices
})

// ── harness 沉淀(跨需求聚合各复盘报告的护栏建议)──────────────────
type ViewMode = 'lessons' | 'harness'
const viewMode = ref<ViewMode>('lessons')

const harnessLoading = ref(false)
const harnessLoaded = ref(false)
const harnessError = ref('')
const harnessSuggestions = ref<AggregatedHarnessSuggestion[]>([])

const filterCategory = ref<HarnessSuggestionCategory | ''>('')
const filterHarnessJiraKey = ref<string>('')
// harness scope 筛选:'all' / 'general'(通用) / 'project'(项目专属,任意 slug) / 具体 projectSlug
const filterHarnessScope = ref<string>('all')

const HARNESS_CATEGORY_COLOR: Record<HarnessSuggestionCategory, string> = {
  'guardrail-rule': '#6ea7f5',
  'check-script': '#9fe5d4',
  checklist: '#f5c489',
  baseline: 'rgba(255,255,255,0.28)',
  manifest: '#b89ff5',
  'self-evolution': '#f08597'
}

const harnessStats = computed(() => {
  const counts = {} as Record<HarnessSuggestionCategory, number>
  for (const cat of HARNESS_CATEGORY_ORDER) counts[cat] = 0
  for (const s of harnessSuggestions.value) {
    counts[s.category] = (counts[s.category] ?? 0) + 1
  }
  return counts
})

const harnessJiraKeyOptions = computed(() => {
  const set = new Set<string>()
  for (const s of harnessSuggestions.value) if (s.jiraKey) set.add(s.jiraKey)
  return Array.from(set).sort()
})

// harness scope 下拉:固定「通用」+ 各项目专属 slug;有老数据(scope='')时补「未分类」
const harnessProjectSlugOptions = computed(() => {
  const set = new Set<string>()
  for (const s of harnessSuggestions.value) {
    if (normalizeHarnessScope(s.scope) === 'project' && s.projectSlug) set.add(s.projectSlug)
  }
  return Array.from(set).sort()
})

const hasUnscopedHarness = computed(() =>
  harnessSuggestions.value.some((s) => normalizeHarnessScope(s.scope) === '')
)

const filteredHarness = computed(() => {
  const scopeFilter = filterHarnessScope.value
  return harnessSuggestions.value.filter((s) => {
    if (filterCategory.value && s.category !== filterCategory.value) return false
    if (filterHarnessJiraKey.value && s.jiraKey !== filterHarnessJiraKey.value) return false
    if (scopeFilter !== 'all') {
      const normalized = normalizeHarnessScope(s.scope)
      if (scopeFilter === 'general' && normalized !== 'general') return false
      else if (scopeFilter === 'unscoped' && normalized !== '') return false
      else if (
        scopeFilter !== 'general' &&
        scopeFilter !== 'unscoped' &&
        !(normalized === 'project' && s.projectSlug === scopeFilter)
      ) {
        return false
      }
    }
    return true
  })
})

const harnessCategoryDistribution = computed(() => {
  const slices: Array<{ name: string; value: number; color: string }> = []
  for (const cat of HARNESS_CATEGORY_ORDER) {
    const v = harnessStats.value[cat]
    if (v <= 0) continue
    slices.push({ name: HARNESS_CATEGORY_LABEL[cat], value: v, color: HARNESS_CATEGORY_COLOR[cat] })
  }
  return slices
})

function renderMd(text: string): string {
  return renderMarkdown(text)
}

function selectLessonType(type: LessonType): void {
  viewMode.value = 'lessons'
  filterType.value = filterType.value === type ? '' : type
}

function selectHarnessCategory(category: HarnessSuggestionCategory): void {
  viewMode.value = 'harness'
  filterCategory.value = filterCategory.value === category ? '' : category
  if (!harnessLoaded.value) void loadHarness()
}

async function loadHarness(): Promise<void> {
  harnessLoading.value = true
  harnessError.value = ''
  try {
    const res = await listHarnessSuggestions()
    harnessSuggestions.value = res.suggestions
    harnessLoaded.value = true
  } catch (err) {
    harnessError.value = err instanceof AgentRequestError ? err.message : (err as Error).message
    harnessSuggestions.value = []
  } finally {
    harnessLoading.value = false
  }
}

async function copyToClipboard(text: string, okMsg: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      ElMessage.success(okMsg)
    } else {
      ElMessage.info('当前环境不支持剪贴板,请手动复制')
    }
  } catch {
    ElMessage.info('复制失败,请手动复制')
  }
}

function copyOneHarness(s: AggregatedHarnessSuggestion): void {
  void copyToClipboard(buildSuggestionMarkdown(s), '已复制该护栏建议,可贴进项目 harness')
}

function copyAllHarness(): void {
  const list = filteredHarness.value
  if (!list.length) return
  const parts: string[] = ['# Harness 增量建议（来自需求复盘）', '']
  for (const s of list) parts.push(buildSuggestionMarkdown(s), '')
  void copyToClipboard(parts.join('\n').trimEnd() + '\n', '已复制全部护栏建议为 Markdown')
}

async function refresh(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    lessons.value = await listLessons()
  } catch (err) {
    errorMessage.value = err instanceof AgentRequestError ? err.message : (err as Error).message
    lessons.value = []
  } finally {
    loading.value = false
  }
  // harness 聚合数据已加载过 / 当前正处于 harness 视图时,刷新按钮一并刷新
  if (harnessLoaded.value || viewMode.value === 'harness') void loadHarness()
}

async function openDetail(row: LessonSummary): Promise<void> {
  drawerOpen.value = true
  detailLoading.value = true
  currentDetail.value = null
  try {
    currentDetail.value = await getLessonDetail(row.id)
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
    drawerOpen.value = false
  } finally {
    detailLoading.value = false
  }
}

async function handleDelete(row: LessonSummary): Promise<void> {
  if (deletingId.value) return
  deletingId.value = row.id
  try {
    await deleteLesson(row.id)
    ElMessage.success('已删除该条经验')
    if (currentDetail.value?.id === row.id) drawerOpen.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  } finally {
    deletingId.value = null
  }
}

async function copyTriggerHint(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(TRIGGER_HINT)
      ElMessage.success('已复制触发口令到剪贴板')
    } else {
      ElMessage.info(TRIGGER_HINT)
    }
  } catch {
    ElMessage.info(TRIGGER_HINT)
  }
}

function formatDate(value: string): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

/**
 * v1.0.0-rc.23 复盘报告联动:
 * 复盘 panel 里点击引用经验卡片会 push `/lessons?focus=<lessonId>`,
 * 这里在 mount + route 变更时探一次 query.focus,自动打开对应详情抽屉。
 * 打开后立即清除 query 参数,避免用户手动关闭抽屉后又被同一个 focus 重复打开。
 */
const router = useRouter()
const route = useRoute()
async function consumeFocusQuery(): Promise<void> {
  const focusId = typeof route.query.focus === 'string' ? route.query.focus.trim() : ''
  if (!focusId) return
  // 等列表加载完再打开,确保 currentDetail 渲染时 lessons 索引已有该项
  if (loading.value || lessons.value.length === 0) {
    try {
      await refresh()
    } catch {
      // refresh 失败时也尝试拉详情(直接走 getLessonDetail,容忍列表为空)
    }
  }
  const target = lessons.value.find((l) => l.id === focusId) ?? ({ id: focusId } as LessonSummary)
  await openDetail(target)
  // 清除 query.focus 让用户后续手动关抽屉后不会被同一参数重复打开
  void router.replace({ path: route.path, query: { ...route.query, focus: undefined } })
}

onMounted(() => {
  void (async () => {
    await refresh()
    await consumeFocusQuery()
  })()
  // 挂载即拉一次 harness 聚合,让「harness 沉淀」分类卡常驻显示真实计数
  void loadHarness()
})

watch(
  () => route.query.focus,
  () => {
    void consumeFocusQuery()
  }
)
</script>

<template>
  <section class="aip-lessons">
    <header class="aip-lessons__page-header">
      <div class="aip-lessons__heading">
        <h1 class="aip-lessons__page-title aipt-aurora-text">复盘经验</h1>
        <p class="aip-lessons__page-sub">
          每个需求结束时触发「需求复盘」,沉淀于此的可复用经验与 harness 护栏建议持续优化 AI
        </p>
      </div>
      <div class="aip-lessons__heading-actions">
        <ElButton size="small" plain @click="copyTriggerHint">复制触发口令</ElButton>
        <ElButton size="small" :loading="loading" type="primary" @click="refresh">刷新</ElButton>
      </div>
    </header>

    <div class="aip-lessons__overview">
      <div class="aip-lessons__stat-stack">
        <div class="aip-lessons__stat-group">
          <span class="aip-lessons__group-label">经验沉淀</span>
          <div class="aip-lessons__metrics">
            <button
              v-for="meta in TYPE_OPTIONS"
              :key="meta.value"
              type="button"
              class="aip-lessons__metric aipt-glass aipt-glow"
              :class="{ 'is-active': viewMode === 'lessons' && filterType === meta.value }"
              @click="selectLessonType(meta.value)"
            >
              <span
                class="aip-lessons__metric-dot"
                :style="{ background: TYPE_COLOR[meta.value] }"
              />
              <span class="aip-lessons__metric-label">{{ meta.label }}</span>
              <span class="aip-lessons__metric-count aipt-num">{{ stats[meta.value] }}</span>
            </button>
          </div>
        </div>
        <div class="aip-lessons__stat-group">
          <span class="aip-lessons__group-label">harness 沉淀</span>
          <div class="aip-lessons__metrics">
            <button
              v-for="opt in HARNESS_CATEGORY_OPTIONS"
              :key="opt.value"
              type="button"
              class="aip-lessons__metric aipt-glass aipt-glow"
              :class="{ 'is-active': viewMode === 'harness' && filterCategory === opt.value }"
              @click="selectHarnessCategory(opt.value)"
            >
              <span
                class="aip-lessons__metric-dot"
                :style="{ background: HARNESS_CATEGORY_COLOR[opt.value] }"
              />
              <span class="aip-lessons__metric-label">{{ opt.label }}</span>
              <span class="aip-lessons__metric-count aipt-num">{{ harnessStats[opt.value] }}</span>
            </button>
          </div>
        </div>
      </div>
      <DonutMetric
        v-if="viewMode === 'lessons'"
        title="经验类型占比"
        subtitle="点击左侧分类卡可一键筛选"
        :data="typeDistribution"
        :center-value="lessons.length"
        center-label="总数"
        :height="180"
      />
      <DonutMetric
        v-else
        title="harness 分类占比"
        subtitle="来自各需求复盘沉淀的护栏建议"
        :data="harnessCategoryDistribution"
        :center-value="harnessSuggestions.length"
        center-label="总数"
        :height="180"
      />
    </div>

    <div v-show="viewMode === 'lessons'" class="aip-toolbar aip-lessons__toolbar">
      <ElSelect
        v-model="filterType"
        clearable
        placeholder="全部类型"
        size="small"
        style="width: 140px"
      >
        <ElOption
          v-for="opt in TYPE_OPTIONS"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </ElSelect>
      <ElSelect
        v-model="filterJiraKey"
        clearable
        placeholder="全部需求"
        size="small"
        style="width: 180px"
        filterable
      >
        <ElOption v-for="key in jiraKeyOptions" :key="key" :label="key" :value="key" />
      </ElSelect>
      <ElSelect v-model="filterScope" placeholder="全部范围" size="small" style="width: 180px">
        <ElOption label="全部范围" value="all" />
        <ElOption label="通用经验" value="general" />
        <ElOption v-if="hasUnscopedLessons" label="未分类（老数据）" value="unscoped" />
        <ElOption
          v-for="slug in projectSlugOptions"
          :key="slug"
          :label="`项目: ${slug}`"
          :value="slug"
        />
      </ElSelect>
      <ElInput
        v-model="filterTag"
        placeholder="按标签筛选"
        size="small"
        clearable
        style="width: 160px"
      />
      <ElInput
        v-model="filterQ"
        placeholder="搜索 标题 / Jira Key"
        size="small"
        clearable
        style="width: 220px"
      />
      <span class="aip-lessons__toolbar-count"
        >共 {{ filteredLessons.length }} / {{ lessons.length }} 条</span
      >
    </div>

    <p
      v-if="viewMode === 'lessons' && errorMessage"
      class="aip-card__caption aip-card__caption--inline"
    >
      <span class="aip-chip aip-chip--danger">错误</span>
      {{ errorMessage }}
    </p>

    <ElTable
      v-show="viewMode === 'lessons'"
      :data="filteredLessons"
      :empty-text="
        loading ? '加载中…' : '暂无经验。在需求详情里触发「需求复盘」即可沉淀可复用经验。'
      "
      class="aip-lessons__table"
      stripe
      @row-click="openDetail"
    >
      <ElTableColumn label="标题" min-width="280">
        <template #default="{ row }">
          <span class="aip-lessons__title">{{ row.title }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="类型" width="120">
        <template #default="{ row }">
          <ElTooltip :content="TYPE_META[row.type as LessonType]?.tooltip ?? ''" placement="top">
            <span class="aip-chip" :class="TYPE_META[row.type as LessonType]?.chip ?? ''">
              {{ TYPE_META[row.type as LessonType]?.label ?? row.type }}
            </span>
          </ElTooltip>
        </template>
      </ElTableColumn>
      <ElTableColumn label="范围" width="150">
        <template #default="{ row }">
          <template v-if="normalizeScope(row.scope) === 'general'">
            <ElTooltip content="通用经验,跨项目可复用" placement="top">
              <span class="aip-chip aip-chip--primary">通用</span>
            </ElTooltip>
          </template>
          <template v-else-if="normalizeScope(row.scope) === 'project'">
            <ElTooltip :content="`项目专属:${row.projectSlug || '未知'}`" placement="top">
              <span class="aip-chip aip-chip--muted aip-lessons__scope-chip">{{
                row.projectSlug || '项目'
              }}</span>
            </ElTooltip>
          </template>
          <template v-else>
            <ElTooltip
              content="老数据(v2.16.x 落盘)未带 scope,可重新提取以补齐分类"
              placement="top"
            >
              <span class="aip-chip aip-chip--muted">未分类</span>
            </ElTooltip>
          </template>
        </template>
      </ElTableColumn>
      <ElTableColumn label="来源需求" width="160">
        <template #default="{ row }">
          <span class="aip-chip aip-chip--muted">{{ row.jiraKey }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="标签" min-width="180">
        <template #default="{ row }">
          <span v-if="!row.tags?.length" class="aip-chip aip-chip--muted">—</span>
          <span
            v-for="tag in row.tags"
            v-else
            :key="tag"
            class="aip-chip aip-chip--muted aip-lessons__tag"
            >{{ tag }}</span
          >
        </template>
      </ElTableColumn>
      <ElTableColumn label="可信度" width="90">
        <template #default="{ row }">
          <span class="aip-chip" :class="TRUST_CHIP[row.trust] ?? 'aip-chip--muted'">{{
            TRUST_LABEL[row.trust] ?? row.trust
          }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="创建时间" width="170">
        <template #default="{ row }">
          <span class="aip-lessons__time">{{ formatDate(row.createdAt) }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <ElPopconfirm
            title="确认删除该条经验?(无法恢复)"
            confirm-button-text="删除"
            cancel-button-text="取消"
            @confirm.stop="handleDelete(row)"
          >
            <template #reference>
              <ElButton size="small" type="danger" link :loading="deletingId === row.id" @click.stop
                >删除</ElButton
              >
            </template>
          </ElPopconfirm>
        </template>
      </ElTableColumn>
      <template #empty>
        <ElEmpty description="暂无沉淀经验" />
      </template>
    </ElTable>

    <!-- harness 视图:跨需求聚合各复盘报告的护栏建议 -->
    <template v-if="viewMode === 'harness'">
      <div class="aip-toolbar aip-lessons__toolbar">
        <ElSelect
          v-model="filterCategory"
          clearable
          placeholder="全部分类"
          size="small"
          style="width: 150px"
        >
          <ElOption
            v-for="opt in HARNESS_CATEGORY_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value"
          />
        </ElSelect>
        <ElSelect
          v-model="filterHarnessScope"
          placeholder="全部范围"
          size="small"
          style="width: 170px"
        >
          <ElOption label="全部范围" value="all" />
          <ElOption label="通用（跨项目）" value="general" />
          <ElOption
            v-for="slug in harnessProjectSlugOptions"
            :key="slug"
            :label="`项目: ${slug}`"
            :value="slug"
          />
          <ElOption v-if="hasUnscopedHarness" label="未分类（老数据）" value="unscoped" />
        </ElSelect>
        <ElSelect
          v-model="filterHarnessJiraKey"
          clearable
          placeholder="全部需求"
          size="small"
          style="width: 180px"
          filterable
        >
          <ElOption v-for="key in harnessJiraKeyOptions" :key="key" :label="key" :value="key" />
        </ElSelect>
        <ElButton size="small" plain :disabled="!filteredHarness.length" @click="copyAllHarness"
          >复制全部为 Markdown</ElButton
        >
        <span class="aip-lessons__toolbar-count"
          >共 {{ filteredHarness.length }} / {{ harnessSuggestions.length }} 条</span
        >
      </div>

      <p v-if="harnessError" class="aip-card__caption aip-card__caption--inline">
        <span class="aip-chip aip-chip--danger">错误</span>
        {{ harnessError }}
      </p>

      <div v-if="harnessLoading" class="aip-lessons__harness-loading">加载中…</div>
      <ElEmpty
        v-else-if="!filteredHarness.length"
        description="暂无 harness 沉淀。在需求详情里触发「需求复盘」，复盘报告生成的护栏建议会汇总到此。"
      />
      <ul v-else class="aip-lessons__harness-list">
        <li
          v-for="(s, idx) in filteredHarness"
          :key="`${s.jiraKey}-${idx}`"
          class="aip-lessons__harness-item aipt-glass"
        >
          <header class="aip-lessons__harness-head">
            <span class="aip-chip" :class="HARNESS_CATEGORY_CHIP[s.category]">
              {{ HARNESS_CATEGORY_LABEL[s.category] }}
            </span>
            <span
              v-if="normalizeHarnessScope(s.scope)"
              class="aip-chip"
              :class="HARNESS_SCOPE_CHIP[normalizeHarnessScope(s.scope)]"
              :title="
                normalizeHarnessScope(s.scope) === 'general'
                  ? '通用护栏,跨项目可复用'
                  : '项目专属护栏'
              "
            >
              {{ harnessScopeLabel(s.scope, s.projectSlug) }}
            </span>
            <span class="aip-lessons__harness-title">{{ s.title }}</span>
            <ElButton size="small" text @click="copyOneHarness(s)">复制</ElButton>
          </header>
          <p v-if="s.signal" class="aip-lessons__harness-signal">
            <span class="aip-lessons__harness-label">信号</span>{{ s.signal }}
          </p>
          <div class="aip-lessons__harness-content" v-html="renderMd(s.content)" />
          <footer class="aip-lessons__harness-foot">
            <span class="aip-chip aip-chip--muted">{{ s.jiraKey }}</span>
            <span v-if="s.jiraTitle" class="aip-lessons__harness-source-title">{{
              s.jiraTitle
            }}</span>
            <code v-if="s.targetFile" class="aip-lessons__harness-target">{{ s.targetFile }}</code>
            <span
              v-if="s.anchorSeqs && s.anchorSeqs.length"
              class="aip-lessons__harness-seqs aipt-num"
            >
              <span v-for="seq in s.anchorSeqs" :key="seq">#{{ seq }}</span>
            </span>
          </footer>
        </li>
      </ul>
    </template>

    <ElDrawer
      v-model="drawerOpen"
      direction="rtl"
      size="640px"
      :show-close="true"
      :with-header="false"
    >
      <div v-if="detailLoading" class="aip-lessons__drawer-loading">加载中…</div>
      <article v-else-if="currentDetail" class="aip-lessons__drawer">
        <header class="aip-lessons__drawer-header">
          <div class="aip-lessons__drawer-meta">
            <span class="aip-chip" :class="TYPE_META[currentDetail.type]?.chip ?? ''">
              {{ TYPE_META[currentDetail.type]?.label ?? currentDetail.type }}
            </span>
            <ElTooltip
              v-if="normalizeScope(currentDetail.scope) === 'general'"
              content="通用经验,跨项目可复用"
              placement="top"
            >
              <span class="aip-chip aip-chip--primary">通用</span>
            </ElTooltip>
            <ElTooltip
              v-else-if="normalizeScope(currentDetail.scope) === 'project'"
              :content="`项目专属:${currentDetail.projectSlug || '未知'}`"
              placement="top"
            >
              <span class="aip-chip aip-chip--muted aip-lessons__scope-chip">
                项目: {{ currentDetail.projectSlug || '未知' }}
              </span>
            </ElTooltip>
            <ElTooltip
              v-else
              content="老数据(v2.16.x 落盘)未带 scope,可重新提取以补齐分类"
              placement="top"
            >
              <span class="aip-chip aip-chip--muted">未分类</span>
            </ElTooltip>
            <span class="aip-chip aip-chip--muted">{{ currentDetail.jiraKey }}</span>
            <span class="aip-chip" :class="TRUST_CHIP[currentDetail.trust] ?? 'aip-chip--muted'">
              可信度 {{ TRUST_LABEL[currentDetail.trust] ?? currentDetail.trust }}
            </span>
          </div>
          <h3 class="aip-lessons__drawer-title">{{ currentDetail.title }}</h3>
          <p v-if="currentDetail.jiraTitle" class="aip-lessons__drawer-subtitle">
            {{ currentDetail.jiraTitle }}
          </p>
        </header>

        <section class="aip-lessons__drawer-section">
          <h4>正文</h4>
          <p>{{ currentDetail.content }}</p>
        </section>

        <section v-if="currentDetail.rootCause" class="aip-lessons__drawer-section">
          <h4>根因</h4>
          <p>{{ currentDetail.rootCause }}</p>
        </section>

        <section v-if="currentDetail.fix" class="aip-lessons__drawer-section">
          <h4>修复 / 改进建议</h4>
          <p>{{ currentDetail.fix }}</p>
        </section>

        <section v-if="currentDetail.reusableWhen" class="aip-lessons__drawer-section">
          <h4>复用条件</h4>
          <p>{{ currentDetail.reusableWhen }}</p>
        </section>

        <section v-if="currentDetail.tags?.length" class="aip-lessons__drawer-section">
          <h4>标签</h4>
          <div class="aip-lessons__drawer-chips">
            <span v-for="tag in currentDetail.tags" :key="tag" class="aip-chip aip-chip--muted">{{
              tag
            }}</span>
          </div>
        </section>

        <section v-if="currentDetail.affectedFiles?.length" class="aip-lessons__drawer-section">
          <h4>涉及文件</h4>
          <ul class="aip-lessons__drawer-files">
            <li v-for="file in currentDetail.affectedFiles" :key="file">
              <code>{{ file }}</code>
            </li>
          </ul>
        </section>

        <section v-if="currentDetail.iterationSeqs?.length" class="aip-lessons__drawer-section">
          <h4>引用 iterations</h4>
          <div class="aip-lessons__drawer-chips">
            <span
              v-for="seq in currentDetail.iterationSeqs"
              :key="seq"
              class="aip-chip aip-chip--primary"
              >#{{ seq }}</span
            >
          </div>
        </section>

        <footer class="aip-lessons__drawer-footer">
          <span class="aip-chip aip-chip--muted">{{
            SOURCE_LABEL[currentDetail.source.extractedBy] ?? currentDetail.source.extractedBy
          }}</span>
          <span>{{ formatDate(currentDetail.createdAt) }}</span>
          <span class="aip-lessons__drawer-id">{{ currentDetail.id }}</span>
        </footer>
      </article>
      <div v-else class="aip-lessons__drawer-loading">无数据</div>
    </ElDrawer>
  </section>
</template>

<style scoped>
.aip-lessons {
  display: grid;
  gap: var(--aipt-space-5);
  max-width: var(--aipt-content-max-w);
  margin: 0 auto;
}

.aip-lessons__page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  flex-wrap: wrap;
}

.aip-lessons__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-lessons__page-title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.aip-lessons__page-sub {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-muted);
}

.aip-lessons__heading-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
}

.aip-lessons__overview {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--aipt-space-3);
  align-items: stretch;
}

@media (max-width: 960px) {
  .aip-lessons__overview {
    grid-template-columns: 1fr;
  }
}

.aip-lessons__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--aipt-space-3);
  align-content: start;
}

.aip-lessons__metric {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-3) var(--aipt-space-4);
  cursor: pointer;
  border-radius: var(--aipt-radius-md);
  font: inherit;
  color: inherit;
  text-align: left;
}

.aip-lessons__metric.is-active {
  border-color: rgba(110, 167, 245, 0.5);
  background: rgba(110, 167, 245, 0.14);
  box-shadow: var(--aipt-shadow-glow);
}

.aip-lessons__metric-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 12px currentColor;
}

.aip-lessons__metric-label {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--aipt-text-secondary);
}

.aip-lessons__metric.is-active .aip-lessons__metric-label {
  color: var(--aipt-text);
}

.aip-lessons__metric-count {
  font-size: 18px;
  font-weight: 800;
  color: var(--aipt-text-strong);
  letter-spacing: -0.02em;
}

.aip-lessons__stat-stack {
  display: grid;
  gap: var(--aipt-space-3);
  align-content: start;
}

.aip-lessons__stat-group {
  display: grid;
  gap: var(--aipt-space-2);
}

.aip-lessons__group-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--aipt-text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* ── harness 视图 ────────────────────────────────────────── */
.aip-lessons__harness-loading {
  padding: 36px;
  text-align: center;
  color: var(--aipt-text-secondary);
}

.aip-lessons__harness-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--aipt-space-3);
}

.aip-lessons__harness-item {
  padding: 12px 14px;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.aip-lessons__harness-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.aip-lessons__harness-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  flex: 1;
}

.aip-lessons__harness-signal {
  font-size: 12px;
  line-height: 1.6;
  color: var(--aipt-text-secondary);
  margin: 0;
}

.aip-lessons__harness-label {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  background: rgba(245, 196, 137, 0.16);
  color: #f5c489;
}

.aip-lessons__harness-content {
  font-size: 13px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
}

.aip-lessons__harness-content :deep(p) {
  margin: 0 0 6px;
}

.aip-lessons__harness-content :deep(pre) {
  margin: 4px 0;
  overflow-x: auto;
}

.aip-lessons__harness-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.aip-lessons__harness-source-title {
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aip-lessons__harness-target {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(110, 167, 245, 0.14);
  color: #6ea7f5;
}

.aip-lessons__harness-seqs {
  display: inline-flex;
  gap: 6px;
  font-size: 11px;
  color: var(--aipt-text-tertiary, rgba(255, 255, 255, 0.45));
}

.aip-lessons__toolbar {
  flex-wrap: wrap;
  gap: var(--aipt-space-2);
}

.aip-lessons__toolbar-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-lessons__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.aip-lessons__tag {
  margin-right: 4px;
}

.aip-lessons__scope-chip {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aip-lessons__time {
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aip-lessons__table {
  border-radius: var(--aipt-radius-lg);
  overflow: hidden;
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  backdrop-filter: blur(var(--aipt-blur-md)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--aipt-blur-md)) saturate(140%);
}

.aip-lessons__table :deep(.el-table__row) {
  cursor: pointer;
}

.aip-lessons__drawer-loading {
  padding: 36px;
  text-align: center;
  color: var(--aipt-text-secondary);
}

.aip-lessons__drawer {
  display: grid;
  gap: 20px;
  padding: 28px 32px;
}

.aip-lessons__drawer-header {
  display: grid;
  gap: 10px;
  border-bottom: 1px solid var(--aipt-border);
  padding-bottom: 18px;
}

.aip-lessons__drawer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.aip-lessons__drawer-title {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  color: var(--aipt-text-strong);
  line-height: 1.35;
  letter-spacing: -0.02em;
}

.aip-lessons__drawer-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-secondary);
  line-height: 1.55;
}

.aip-lessons__drawer-section h4 {
  margin: 0 0 6px 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--aipt-text-muted);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.aip-lessons__drawer-section p {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
}

.aip-lessons__drawer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.aip-lessons__drawer-files {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}

.aip-lessons__drawer-files code {
  font-size: 12px;
  color: var(--aipt-text);
  background: var(--aipt-surface);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--aipt-border-faint);
}

.aip-lessons__drawer-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--aipt-text-muted);
  border-top: 1px solid var(--aipt-border);
  padding-top: 14px;
}

.aip-lessons__drawer-id {
  margin-left: auto;
  font-family: 'Menlo', 'Monaco', monospace;
  letter-spacing: 0.04em;
}

@media (max-width: 640px) {
  .aip-lessons {
    gap: var(--aipt-space-4);
  }
  .aip-lessons__page-title {
    font-size: 22px;
  }
}
</style>
