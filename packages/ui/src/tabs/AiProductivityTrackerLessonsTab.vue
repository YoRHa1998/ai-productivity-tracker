<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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

import {
  AgentRequestError,
  deleteLesson,
  getLessonDetail,
  listLessons,
  type LessonDetail,
  type LessonScope,
  type LessonSummary,
  type LessonType
} from '../api'
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

const TRIGGER_HINT = '经验提取 当前需求 INSTANT-XXXX'

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

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section class="aip-lessons">
    <header class="aip-hero aip-hero--compact aip-lessons__hero">
      <div class="aip-hero__left">
        <div class="aip-hero__icon" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 19a2 2 0 0 1 2-2h14"></path>
            <path d="M5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14V5z"></path>
            <path d="M9 9h6"></path>
            <path d="M9 13h4"></path>
          </svg>
        </div>
        <div class="aip-hero__info">
          <div class="aip-hero__title-row">
            <h2>复盘经验</h2>
            <span class="aip-chip aip-chip--solid aip-hero__badge">P0</span>
          </div>
          <p>
            每个需求结束时使用关键词「经验提取」由 IDE LLM 触发 lessons-extract
            skill,落盘的多维度经验在此统一展示。
          </p>
        </div>
      </div>
      <div class="aip-hero__cta">
        <ElButton size="small" @click="copyTriggerHint">复制触发口令</ElButton>
        <ElButton size="small" :loading="loading" type="primary" @click="refresh">刷新</ElButton>
      </div>
    </header>

    <div class="aip-lessons__metrics">
      <div
        v-for="meta in TYPE_OPTIONS"
        :key="meta.value"
        class="aip-lessons__metric"
        @click="filterType = filterType === meta.value ? '' : meta.value"
        :class="{ 'aip-lessons__metric--active': filterType === meta.value }"
      >
        <span class="aip-chip" :class="TYPE_META[meta.value].chip">{{ meta.label }}</span>
        <span class="aip-lessons__metric-count">{{ stats[meta.value] }}</span>
      </div>
    </div>

    <div class="aip-toolbar aip-lessons__toolbar">
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

    <p v-if="errorMessage" class="aip-card__caption aip-card__caption--inline">
      <span class="aip-chip aip-chip--danger">错误</span>
      {{ errorMessage }}
    </p>

    <ElTable
      :data="filteredLessons"
      :empty-text="
        loading ? '加载中…' : '暂无经验。在 jiraKey 分支下让 IDE LLM 跑「经验提取」即可生成。'
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
  gap: 16px;
  padding: 24px;
}

.aip-lessons__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.aip-lessons__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.aip-lessons__metric {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle, rgba(96, 114, 153, 0.12));
  background: var(--surface-elevated, #fff);
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s,
    border-color 0.2s;
}

.aip-lessons__metric:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
}

.aip-lessons__metric--active {
  border-color: var(--accent-primary, #4f6ef5);
  box-shadow: 0 4px 14px rgba(79, 110, 245, 0.18);
}

.aip-lessons__metric-count {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.aip-lessons__toolbar {
  flex-wrap: wrap;
  gap: 10px;
}

.aip-lessons__toolbar-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-soft);
}

.aip-lessons__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
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
  color: var(--text-secondary);
}

.aip-lessons__table :deep(.el-table__row) {
  cursor: pointer;
}

.aip-lessons__drawer-loading {
  padding: 36px;
  text-align: center;
  color: var(--text-secondary);
}

.aip-lessons__drawer {
  display: grid;
  gap: 18px;
  padding: 28px 32px;
}

.aip-lessons__drawer-header {
  display: grid;
  gap: 8px;
  border-bottom: 1px solid var(--border-subtle, rgba(96, 114, 153, 0.12));
  padding-bottom: 16px;
}

.aip-lessons__drawer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.aip-lessons__drawer-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.45;
}

.aip-lessons__drawer-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.55;
}

.aip-lessons__drawer-section h4 {
  margin: 0 0 6px 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.aip-lessons__drawer-section p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
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
  color: var(--text-primary);
  background: rgba(96, 114, 153, 0.08);
  padding: 2px 6px;
  border-radius: 4px;
}

.aip-lessons__drawer-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-soft);
  border-top: 1px solid var(--border-subtle, rgba(96, 114, 153, 0.1));
  padding-top: 14px;
}

.aip-lessons__drawer-id {
  margin-left: auto;
  font-family: 'Menlo', 'Monaco', monospace;
  letter-spacing: 0.04em;
}
</style>
