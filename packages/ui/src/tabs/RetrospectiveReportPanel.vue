<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ElButton,
  ElCollapse,
  ElCollapseItem,
  ElEmpty,
  ElMessage,
  ElPopconfirm,
  ElTooltip
} from 'element-plus'
import { useRouter } from 'vue-router'

import {
  AgentRequestError,
  deleteRetrospective,
  getLessonDetail,
  getRetrospective,
  type IterationDetail,
  type LessonDetail,
  type RequirementDetail,
  type StoredRetrospective
} from '../api'
import DonutMetric from '../charts/DonutMetric.vue'
import IterationPhaseTimeline, {
  type IterationTimelinePhase,
  type IterationTimelineRow
} from '../charts/IterationPhaseTimeline.vue'
import RadarMetric, { type RadarDimension } from '../charts/RadarMetric.vue'
import { VChart, type ECOption } from '../charts/echarts'
import { useChartTheme } from '../composables/useChartTheme'
import { renderMarkdown } from '../lib/markdown'
import '../styles/aip-shared.css'

/**
 * v1.0.0-rc.23 单需求复盘报告 Panel。
 *
 * 数据流(纯展示,无 LLM 推理):
 * - props:jiraKey + 父组件已拉好的 requirement detail / iterations(避免重复请求)
 * - 当 open=true 时按需拉 GET /requirements/:jiraKey/retrospective + 引用的 lesson detail
 * - 看板侧不直接触发生成报告,通过「复制触发口令」让用户回 IDE 跑 retrospective-report skill
 */

interface Props {
  jiraKey: string
  open: boolean
  requirement: RequirementDetail | null
  iterations: IterationDetail[]
}

const props = defineProps<Props>()

const router = useRouter()

const loading = ref(false)
const errorMessage = ref('')
const report = ref<StoredRetrospective | null>(null)
const referencedLessons = ref<LessonDetail[]>([])
const lessonsLoading = ref(false)
const deleting = ref(false)
const expandedSections = ref<string[]>(['overview', 'phases'])

const TYPE_LABEL: Record<string, string> = {
  pitfall: '踩的坑',
  rule: '沉淀规则',
  'best-practice': '最佳实践',
  'split-suggestion': '拆分建议',
  tooling: '工具改进'
}
const TYPE_CHIP: Record<string, string> = {
  pitfall: 'aip-chip--danger',
  rule: 'aip-chip--primary',
  'best-practice': 'aip-chip--success',
  'split-suggestion': 'aip-chip--warning',
  tooling: 'aip-chip--muted'
}

const triggerHint = computed(() => `需求复盘 当前需求 ${props.jiraKey}`)

const hasReport = computed(() => !!report.value)

watch(
  () => [props.open, props.jiraKey] as const,
  ([isOpen, jiraKey]) => {
    if (isOpen && jiraKey) {
      void load()
    }
  },
  { immediate: true }
)

async function load(): Promise<void> {
  if (!props.jiraKey) return
  loading.value = true
  errorMessage.value = ''
  report.value = null
  referencedLessons.value = []
  try {
    report.value = await getRetrospective(props.jiraKey)
    if (report.value && report.value.referencedLessonIds.length > 0) {
      void loadReferencedLessons(report.value.referencedLessonIds)
    }
  } catch (err) {
    errorMessage.value =
      err instanceof AgentRequestError ? err.message : (err as Error).message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function loadReferencedLessons(ids: string[]): Promise<void> {
  lessonsLoading.value = true
  try {
    const results = await Promise.allSettled(ids.map((id) => getLessonDetail(id)))
    const out: LessonDetail[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') out.push(r.value)
    }
    referencedLessons.value = out
  } finally {
    lessonsLoading.value = false
  }
}

async function copyTriggerHint(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(triggerHint.value)
      ElMessage.success('已复制触发口令到剪贴板,粘到 IDE 即可生成')
    } else {
      ElMessage.info(triggerHint.value)
    }
  } catch {
    ElMessage.info(triggerHint.value)
  }
}

async function handleDelete(): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  try {
    await deleteRetrospective(props.jiraKey)
    ElMessage.success('已删除复盘报告')
    report.value = null
    referencedLessons.value = []
  } catch (err) {
    ElMessage.error(err instanceof AgentRequestError ? err.message : (err as Error).message)
  } finally {
    deleting.value = false
  }
}

function jumpToLesson(id: string): void {
  void router.push({ path: '/lessons', query: { focus: id } })
}

function formatDate(value: string): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat().format(Math.round(value))
}

function formatThink(seconds: number): string {
  if (!seconds || seconds <= 0) return '0s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = seconds / 60
  if (m < 60) return `${m.toFixed(1)} 分`
  return `${(m / 60).toFixed(1)} 小时`
}

// ─── 雷达图 5 维归一化 ───────────────────────────────────
//
// 维度选择遵循「越大越好」+「max 是看板上认为的"满分线"」原则:
// - 提效倍率(boost):0..10 区间,>10 直接 clamp 到 10
// - AI 思考密度(totalThinkSeconds / 60min):0..120(2 小时)区间
// - 关键文件集中度(top1 churn 触碰轮数 / iterationCount):0..1(占比),× 100 后 0..100
// - 拆分干净度(异常 stop 越少越好):4 - abnormalStopReasonsCount,0..4
// - 经验密度(lessonsCount):0..5(5 条认为饱和)
//
// 注:value 超过 max 由 RadarMetric 内部 clamp;value < 0 也会归零。

const radarDimensions = computed<RadarDimension[]>(() => {
  if (!report.value) return []
  const snap = report.value.snapshot
  const iterCount = report.value.generatedAtIterationCount || props.iterations.length || 0

  // 关键文件集中度:近似为 top churn 文件触碰轮数占比;无 churn 数据时给 0
  // 这里只能从 props.iterations 反推一个粗略值(daemon 端已算更精确的,但 panel 不带 computedSignals)
  const fileTouchCount = new Map<string, number>()
  for (const it of props.iterations) {
    const seen = new Set<string>()
    for (const f of it.changedFiles ?? []) {
      const p = (f.path ?? '').trim()
      if (p && !seen.has(p)) {
        seen.add(p)
        fileTouchCount.set(p, (fileTouchCount.get(p) ?? 0) + 1)
      }
    }
  }
  let topChurn = 0
  for (const v of fileTouchCount.values()) if (v > topChurn) topChurn = v
  const churnRatio = iterCount > 0 ? topChurn / iterCount : 0

  return [
    { name: '提效倍率', value: snap.boost ?? 0, max: 10 },
    { name: 'AI 思考密度', value: (snap.totalThinkSeconds ?? 0) / 60, max: 120 },
    { name: '关键文件集中度', value: churnRatio * 100, max: 100 },
    {
      name: '拆分干净度',
      value: 4 - Math.min(snap.abnormalStopReasonsCount ?? 0, 4),
      max: 4
    },
    { name: '经验密度', value: snap.lessonsCount ?? 0, max: 5 }
  ]
})

// ─── iteration 阶段时间线 ────────────────────────────────

const timelineRows = computed<IterationTimelineRow[]>(() =>
  props.iterations
    .filter((it) => it.kind !== 'init')
    .map((it) => ({
      seq: it.seq,
      thinkSeconds: it.thinkSeconds ?? 0,
      oneLine: it.conversationSummary?.oneLine ?? ''
    }))
)

const timelinePhases = computed<IterationTimelinePhase[]>(() => {
  if (!report.value) return []
  return report.value.narrative.phases.map((p) => ({
    title: p.title,
    iterationSeqRange: p.iterationSeqRange
  }))
})

// ─── 累积曲线(token / think 双 Y 轴)───────────────────

const { tokens: chartTokens } = useChartTheme()

const cumulativeOption = computed<ECOption>(() => {
  const rows = props.iterations.filter((it) => it.kind !== 'init')
  const t = chartTokens.value
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: t.tooltipText, fontSize: 12 }
    },
    legend: {
      textStyle: { color: t.text },
      top: 0,
      right: 12
    },
    grid: { left: 16, right: 16, top: 36, bottom: 24, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => `#${r.seq}`),
      axisLabel: { color: t.text, fontSize: 11 },
      axisLine: { lineStyle: { color: t.axisLine } },
      axisTick: { show: false }
    },
    yAxis: [
      {
        type: 'value',
        name: 'token',
        nameTextStyle: { color: t.subtle, fontSize: 11 },
        axisLabel: { color: t.text, fontSize: 11 },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: t.faint } }
      },
      {
        type: 'value',
        name: '累计思考(s)',
        position: 'right',
        nameTextStyle: { color: t.subtle, fontSize: 11 },
        axisLabel: { color: t.text, fontSize: 11 },
        axisLine: { show: false },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        type: 'line',
        name: '累计 token',
        data: rows.map((r) => r.cumulativeToken ?? 0),
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2, color: '#6ea7f5' },
        itemStyle: { color: '#6ea7f5' },
        areaStyle: { color: 'rgba(110,167,245,0.12)' }
      },
      {
        type: 'line',
        name: '累计 thinkSeconds',
        yAxisIndex: 1,
        data: (() => {
          let acc = 0
          return rows.map((r) => {
            acc += r.thinkSeconds ?? 0
            return acc
          })
        })(),
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2, color: '#9fe5d4' },
        itemStyle: { color: '#9fe5d4' }
      }
    ]
  }
})

// ─── 引用 lessons 类型分布 donut ───────────────────────

const lessonsDonutData = computed(() => {
  const counts: Record<string, number> = {}
  for (const l of referencedLessons.value) {
    const t = l.type
    counts[t] = (counts[t] ?? 0) + 1
  }
  const TYPE_COLOR: Record<string, string> = {
    pitfall: '#f08597',
    rule: '#6ea7f5',
    'best-practice': '#9fe5d4',
    'split-suggestion': '#f5c489',
    tooling: 'rgba(255,255,255,0.28)'
  }
  return Object.entries(counts).map(([type, value]) => ({
    name: TYPE_LABEL[type] ?? type,
    value,
    color: TYPE_COLOR[type] ?? '#86c5e8'
  }))
})

// ─── markdown 渲染 ────────────────────────────────────

function renderMd(text: string): string {
  return renderMarkdown(text)
}
</script>

<template>
  <section class="aip-retro">
    <!-- 加载态 -->
    <div v-if="loading" class="aip-state">
      <p>加载复盘报告中…</p>
    </div>

    <!-- 错误态(只在没有 report 时展示;有 report 时展示 stale 报告 + 错误 banner) -->
    <p v-else-if="errorMessage && !hasReport" class="aip-card__caption aip-card__caption--inline">
      <span class="aip-chip aip-chip--danger">错误</span>
      {{ errorMessage }}
    </p>

    <!-- 空态:没有报告 -->
    <div v-else-if="!hasReport" class="aip-retro__empty aipt-glass aipt-glass--accent">
      <div class="aip-retro__empty-icon" aria-hidden="true">
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <h4 class="aip-retro__empty-title">本需求暂无复盘报告</h4>
      <p class="aip-retro__empty-desc">
        回到 IDE 粘贴下方触发口令,即可由 LLM 通过 <code>retrospective-report</code> skill
        基于本需求全部 iteration 自动生成结构化复盘。
      </p>
      <div class="aip-retro__empty-token" @click="copyTriggerHint">
        <span class="aip-retro__empty-token-text">{{ triggerHint }}</span>
        <span class="aip-retro__empty-token-action">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4M15 11H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          复制
        </span>
      </div>
      <p class="aip-retro__empty-hint">
        建议在需求 status 切到 <strong>finished</strong> 后触发,开发中阶段亦可生成预览版。
      </p>
    </div>

    <!-- 有报告 -->
    <div v-else-if="report" class="aip-retro__body">
      <!-- 顶部 hero -->
      <header class="aip-retro__hero aipt-glass aipt-glass--accent">
        <div class="aip-retro__hero-meta">
          <h3 class="aip-retro__hero-title aipt-aurora-text">复盘报告</h3>
          <p class="aip-retro__hero-sub">
            基于第 <strong class="aipt-num">{{ report.generatedAtIterationSeq }}</strong> 轮 / 共
            <strong class="aipt-num">{{ report.generatedAtIterationCount }}</strong> 轮 iteration ·
            {{ formatDate(report.generatedAt) }}
          </p>
          <div class="aip-retro__hero-snapshot">
            <span
              v-if="report.snapshot.boost != null"
              class="aip-chip aip-chip--success"
              title="提效倍率(snapshot)"
            >
              boost {{ report.snapshot.boost.toFixed(2) }}x
            </span>
            <span class="aip-chip aip-chip--primary" title="累计 token(snapshot)">
              {{ formatNumber(report.snapshot.cumulativeToken) }} tokens
            </span>
            <span class="aip-chip aip-chip--muted" title="AI 累计思考时长(snapshot)">
              {{ formatThink(report.snapshot.totalThinkSeconds) }}
            </span>
            <span
              v-if="report.snapshot.linkedBugCount > 0"
              class="aip-chip aip-chip--warning"
              title="关联 Bug 总数(snapshot)"
            >
              {{ report.snapshot.linkedBugCount }} bugs
            </span>
            <span class="aip-chip aip-chip--muted" title="累计 diff(snapshot)">
              +{{ report.snapshot.cumulativeDiffInsertions }} / -{{
                report.snapshot.cumulativeDiffDeletions
              }}
              ({{ report.snapshot.cumulativeDiffFiles }} files)
            </span>
            <span
              v-if="report.snapshot.lessonsCount > 0"
              class="aip-chip aip-chip--success"
              title="本需求已沉淀经验数(snapshot)"
            >
              {{ report.snapshot.lessonsCount }} 条经验
            </span>
          </div>
        </div>
        <div class="aip-retro__hero-actions">
          <ElTooltip content="复制触发口令到剪贴板,粘到 IDE 触发 LLM 重新生成" placement="top">
            <ElButton size="small" plain @click="copyTriggerHint">重新生成</ElButton>
          </ElTooltip>
          <ElPopconfirm
            title="确认删除该复盘报告?可重新触发生成"
            confirm-button-text="删除"
            cancel-button-text="取消"
            @confirm="handleDelete"
          >
            <template #reference>
              <ElButton size="small" :loading="deleting" type="danger" plain>删除报告</ElButton>
            </template>
          </ElPopconfirm>
        </div>
      </header>

      <!-- 4 张图表(2 列 grid) -->
      <div class="aip-retro__charts">
        <RadarMetric
          title="复盘 5 维"
          subtitle="提效 / 思考密度 / 文件集中度 / 拆分干净度 / 经验密度"
          :dimensions="radarDimensions"
          :height="280"
        />
        <DonutMetric
          v-if="lessonsDonutData.length"
          title="引用经验类型"
          :subtitle="`共 ${referencedLessons.length} 条 lesson`"
          :data="lessonsDonutData"
          :center-value="referencedLessons.length"
          center-label="lessons"
          :height="220"
        />
        <div v-else class="aip-retro__chart-placeholder aipt-glass">
          <p class="aip-retro__chart-placeholder-text">本复盘未引用任何已沉淀经验</p>
          <p class="aip-retro__chart-placeholder-sub">
            如有可复用经验,可在 IDE 中跑「经验提取」单独沉淀
          </p>
        </div>
        <IterationPhaseTimeline
          class="aip-retro__chart--span2"
          title="iteration 阶段时间线"
          subtitle="高度 = 该轮 thinkSeconds,颜色 = 复盘报告划分的阶段"
          :iterations="timelineRows"
          :phases="timelinePhases"
          :height="220"
        />
        <section class="aipt-glass aipt-glass--accent aip-retro__chart--span2 aip-retro__cumchart">
          <header class="aip-retro__chart-header">
            <h3 class="aip-retro__chart-title">累积 token / 思考时长</h3>
            <p class="aip-retro__chart-sub">两条折线对照:成本 vs AI 实际投入时长</p>
          </header>
          <VChart class="aip-retro__cumchart-canvas" :option="cumulativeOption" autoresize />
        </section>
      </div>

      <!-- markdown 叙事区(每段独立 collapsible) -->
      <ElCollapse v-model="expandedSections" class="aip-retro__sections">
        <ElCollapseItem name="overview" title="总览">
          <div class="aip-retro__markdown" v-html="renderMd(report.narrative.overview)" />
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.phases.length"
          name="phases"
          :title="`阶段拆分(${report.narrative.phases.length})`"
        >
          <ol class="aip-retro__phases">
            <li
              v-for="(phase, idx) in report.narrative.phases"
              :key="`${phase.title}-${idx}`"
              class="aip-retro__phase-item"
            >
              <header class="aip-retro__phase-head">
                <span class="aip-retro__phase-title">{{ phase.title }}</span>
                <span class="aip-retro__phase-range aipt-num">
                  #{{ phase.iterationSeqRange[0] }} – #{{ phase.iterationSeqRange[1] }}
                </span>
              </header>
              <div class="aip-retro__markdown" v-html="renderMd(phase.summary)" />
            </li>
          </ol>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.highlights.length"
          name="highlights"
          :title="`亮点(${report.narrative.highlights.length})`"
        >
          <ul class="aip-retro__bullets aip-retro__bullets--success">
            <li v-for="(b, idx) in report.narrative.highlights" :key="idx" v-html="renderMd(b)" />
          </ul>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.issues.length"
          name="issues"
          :title="`暴露的问题(${report.narrative.issues.length})`"
        >
          <ul class="aip-retro__bullets aip-retro__bullets--danger">
            <li v-for="(b, idx) in report.narrative.issues" :key="idx" v-html="renderMd(b)" />
          </ul>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.improvements.length"
          name="improvements"
          :title="`改进建议(${report.narrative.improvements.length})`"
        >
          <ul class="aip-retro__bullets aip-retro__bullets--primary">
            <li v-for="(b, idx) in report.narrative.improvements" :key="idx" v-html="renderMd(b)" />
          </ul>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.pitfallsObserved.length"
          name="pitfalls"
          :title="`观察到的坑(${report.narrative.pitfallsObserved.length})`"
        >
          <ul class="aip-retro__bullets aip-retro__bullets--warning">
            <li
              v-for="(b, idx) in report.narrative.pitfallsObserved"
              :key="idx"
              v-html="renderMd(b)"
            />
          </ul>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.nextSteps.length"
          name="nextSteps"
          :title="`下次预热建议(${report.narrative.nextSteps.length})`"
        >
          <ul class="aip-retro__bullets">
            <li v-for="(b, idx) in report.narrative.nextSteps" :key="idx" v-html="renderMd(b)" />
          </ul>
        </ElCollapseItem>
        <ElCollapseItem
          v-if="report.narrative.splitSuggestions && report.narrative.splitSuggestions.length"
          name="splits"
          :title="`对话拆分建议(${report.narrative.splitSuggestions.length})`"
        >
          <ul class="aip-retro__bullets aip-retro__bullets--muted">
            <li
              v-for="(b, idx) in report.narrative.splitSuggestions"
              :key="idx"
              v-html="renderMd(b)"
            />
          </ul>
        </ElCollapseItem>
      </ElCollapse>

      <!-- 引用经验卡片 -->
      <section v-if="report.referencedLessonIds.length" class="aip-retro__lessons">
        <header class="aip-retro__lessons-head">
          <h4 class="aip-retro__lessons-title">引用经验</h4>
          <span class="aip-retro__lessons-sub"
            >共 {{ report.referencedLessonIds.length }} 条 · 点击跳转到全局复盘经验
          </span>
        </header>
        <p v-if="lessonsLoading" class="aip-retro__lessons-loading">加载经验详情中…</p>
        <ul class="aip-retro__lesson-list">
          <li
            v-for="lesson in referencedLessons"
            :key="lesson.id"
            class="aip-retro__lesson-card aipt-glass"
            tabindex="0"
            @click="jumpToLesson(lesson.id)"
            @keyup.enter="jumpToLesson(lesson.id)"
          >
            <header class="aip-retro__lesson-head">
              <span class="aip-chip" :class="TYPE_CHIP[lesson.type] ?? 'aip-chip--muted'">
                {{ TYPE_LABEL[lesson.type] ?? lesson.type }}
              </span>
              <span class="aip-retro__lesson-title">{{ lesson.title }}</span>
            </header>
            <p v-if="lesson.content" class="aip-retro__lesson-content">{{ lesson.content }}</p>
            <footer v-if="lesson.tags.length" class="aip-retro__lesson-tags">
              <span v-for="tag in lesson.tags" :key="tag" class="aip-chip aip-chip--muted">
                {{ tag }}
              </span>
            </footer>
          </li>
        </ul>
      </section>

      <!-- 锚点 iterations -->
      <section v-if="report.anchorIterationSeqs.length" class="aip-retro__anchors">
        <header class="aip-retro__anchors-head">
          <h4 class="aip-retro__anchors-title">锚点 iteration</h4>
          <span class="aip-retro__anchors-sub">
            共 {{ report.anchorIterationSeqs.length }} 个 · 建议在「需求概览」tab 的 iteration
            时间线对照查看
          </span>
        </header>
        <ul class="aip-retro__anchor-list">
          <li
            v-for="seq in report.anchorIterationSeqs"
            :key="seq"
            class="aip-retro__anchor aip-chip aip-chip--primary"
          >
            #{{ seq }}
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.aip-retro {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-5);
}

.aip-retro__empty {
  padding: var(--aipt-space-8) var(--aipt-space-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--aipt-space-3);
}

.aip-retro__empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: var(--aipt-radius-lg);
  background: rgba(110, 167, 245, 0.12);
  border: 1px solid rgba(110, 167, 245, 0.28);
  color: var(--aipt-aurora-1);
  margin-bottom: var(--aipt-space-2);
}

.aip-retro__empty-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aip-retro__empty-desc {
  margin: 0;
  max-width: 480px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
}

.aip-retro__empty-desc code {
  background: rgba(110, 167, 245, 0.12);
  border: 1px solid rgba(110, 167, 245, 0.28);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
  color: var(--aipt-aurora-1);
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
}

.aip-retro__empty-token {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: 10px 14px;
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface);
  border: 1px dashed var(--aipt-border-strong);
  cursor: pointer;
  user-select: none;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-retro__empty-token:hover {
  background: var(--aipt-surface-hover);
  border-color: var(--aipt-aurora-1);
}

.aip-retro__empty-token-text {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  color: var(--aipt-text);
  letter-spacing: 0.01em;
}

.aip-retro__empty-token-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--aipt-radius-sm);
  background: var(--aipt-gradient-aurora);
  color: var(--aipt-text-on-accent);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  box-shadow: var(--aipt-shadow-glow);
}

.aip-retro__empty-hint {
  font-size: 12px;
  color: var(--aipt-text-muted);
  margin: var(--aipt-space-1) 0 0;
  max-width: 460px;
  line-height: 1.6;
}

.aip-retro__empty-hint strong {
  color: var(--aipt-state-success);
  font-weight: 700;
}

.aip-retro__body {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-5);
}

.aip-retro__hero {
  padding: var(--aipt-space-5);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--aipt-space-4);
}

.aip-retro__hero-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-2);
}

.aip-retro__hero-title {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.aip-retro__hero-sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-retro__hero-snapshot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.aip-retro__hero-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.aip-retro__charts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--aipt-space-4);
}

.aip-retro__chart--span2 {
  grid-column: span 2;
}

@media (max-width: 720px) {
  .aip-retro__charts {
    grid-template-columns: minmax(0, 1fr);
  }
  .aip-retro__chart--span2 {
    grid-column: span 1;
  }
}

.aip-retro__chart-placeholder {
  padding: var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
  text-align: center;
  min-height: 220px;
}

.aip-retro__chart-placeholder-text {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--aipt-text-secondary);
}

.aip-retro__chart-placeholder-sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-retro__cumchart {
  padding: var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aip-retro__chart-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-retro__chart-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aip-retro__chart-sub {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-retro__cumchart-canvas {
  width: 100%;
  height: 240px;
}

/* 叙事区 */
.aip-retro__sections {
  /* 复用 element-plus collapse 默认外观,只调整间距 */
  margin-top: var(--aipt-space-2);
}

.aip-retro__markdown {
  font-size: 13px;
  line-height: 1.8;
  color: var(--aipt-text-secondary);
}

.aip-retro__markdown :deep(p) {
  margin: 0 0 8px;
}
.aip-retro__markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.aip-retro__markdown :deep(strong) {
  color: var(--aipt-text);
}
.aip-retro__markdown :deep(blockquote) {
  border-left: 3px solid rgba(110, 167, 245, 0.4);
  padding: 4px 12px;
  margin: 6px 0;
  color: var(--aipt-text-muted);
  background: rgba(110, 167, 245, 0.05);
  border-radius: 0 4px 4px 0;
}
.aip-retro__markdown :deep(code) {
  background: rgba(110, 167, 245, 0.12);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
}
.aip-retro__markdown :deep(pre) {
  background: rgba(7, 10, 20, 0.5);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}
.aip-retro__markdown :deep(ul),
.aip-retro__markdown :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}

.aip-retro__phases {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aip-retro__phase-item {
  border-left: 2px solid rgba(110, 167, 245, 0.4);
  padding-left: 12px;
}

.aip-retro__phase-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.aip-retro__phase-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-retro__phase-range {
  font-size: 11px;
  color: var(--aipt-text-muted);
  font-variant-numeric: tabular-nums;
}

.aip-retro__bullets {
  list-style: disc;
  padding-left: 20px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-retro__bullets li {
  font-size: 13px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
}

.aip-retro__bullets li :deep(p) {
  margin: 0;
}

.aip-retro__bullets--success li::marker {
  color: #9fe5d4;
}
.aip-retro__bullets--danger li::marker {
  color: #f08597;
}
.aip-retro__bullets--primary li::marker {
  color: #6ea7f5;
}
.aip-retro__bullets--warning li::marker {
  color: #f5c489;
}
.aip-retro__bullets--muted li::marker {
  color: rgba(255, 255, 255, 0.32);
}

/* 引用经验 */
.aip-retro__lessons {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-3);
}

.aip-retro__lessons-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.aip-retro__lessons-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-retro__lessons-sub {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-retro__lessons-loading {
  font-size: 12px;
  color: var(--aipt-text-muted);
  margin: 0;
}

.aip-retro__lesson-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.aip-retro__lesson-card {
  cursor: pointer;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: transform 0.18s ease;
}

.aip-retro__lesson-card:hover,
.aip-retro__lesson-card:focus-visible {
  transform: translateY(-2px);
  outline: none;
}

.aip-retro__lesson-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.aip-retro__lesson-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aip-retro__lesson-content {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-secondary);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.aip-retro__lesson-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* 锚点 */
.aip-retro__anchors {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.aip-retro__anchors-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.aip-retro__anchors-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--aipt-text-strong);
}

.aip-retro__anchors-sub {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-retro__anchor-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
