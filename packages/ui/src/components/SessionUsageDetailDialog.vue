<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElDialog, ElEmpty, ElSkeleton } from 'element-plus'

import {
  fetchSessionUsageDetail,
  type AiUsageSource,
  type SessionTurnDetailView,
  type SessionUsageView
} from '../api'
import UsageBar from './UsageBar.vue'

/**
 * 会话详情弹窗:点击「会话用量明细」某行打开,逐轮展示名称 / 时长 / 模型 / 本轮 token,
 * 并为每轮渲染一根「占本会话总量比例」的进度条(长度按 ratio、颜色按本轮绝对量三档)。
 *
 * - 数据按需从详情端点(`fetchSessionUsageDetail`)拉取;key 不存在 / 无明细走空态。
 * - 每轮时长为「相邻轮事件间隔(含空闲)」近似,非纯模型耗时;末轮无后继显示「—」。
 */
const props = defineProps<{
  modelValue: boolean
  /** 会话 key(`${source}:${sessionId}`);为 null 时不加载。 */
  sessionKey: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const SOURCE_LABEL: Record<AiUsageSource, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const loading = ref(false)
const session = ref<SessionUsageView | null>(null)
const turns = ref<SessionTurnDetailView[]>([])

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 会话头部展示标识:title 优先;否则短会话 ID + 工具。 */
const headerLabel = computed(() => {
  const s = session.value
  if (!s) return '会话详情'
  if (s.title && s.title.trim()) return s.title
  const shortId = s.sessionId ? s.sessionId.slice(0, 8) : '—'
  return `${SOURCE_LABEL[s.source]} · ${shortId}`
})

/** 本会话 token 合计,作每轮进度条长度归一化分母(ratio = turn.total / session.total)。 */
const sessionTotal = computed(() => session.value?.totalTokens ?? 0)

/**
 * 单轮时长紧凑展示:undefined(末轮 / 无法解析)→ `—`;< 1min → `Ns`;< 60min → `Nmin`;
 * 否则 `Xh` / `XhYmin`。
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin}min`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${hours}h` : `${hours}h${min}min`
}

/** 单轮时刻「MM-DD HH:mm」,作行内时间标识。 */
function formatAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 单轮名称:title 优先,否则按时刻兜底。 */
function turnLabel(turn: SessionTurnDetailView, index: number): string {
  if (turn.title && turn.title.trim()) return turn.title
  return `第 ${index + 1} 轮`
}

async function load(key: string) {
  loading.value = true
  session.value = null
  turns.value = []
  try {
    const res = await fetchSessionUsageDetail(key)
    session.value = res.session
    turns.value = Array.isArray(res.turns) ? res.turns : []
  } catch {
    // 详情加载失败按空态兜底,不抛错打断弹窗
    session.value = null
    turns.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.sessionKey] as const,
  ([isOpen, key]) => {
    if (isOpen && key) void load(key)
  },
  { immediate: true }
)
</script>

<template>
  <ElDialog
    v-model="open"
    :title="headerLabel"
    width="720px"
    align-center
    append-to-body
    destroy-on-close
    class="aip-session-detail"
  >
    <div v-if="session" class="aip-session-detail__header">
      <span
        class="aip-session-detail__tag"
        :title="
          session.model
            ? `${SOURCE_LABEL[session.source]} · ${session.model}`
            : SOURCE_LABEL[session.source]
        "
        >{{ SOURCE_LABEL[session.source]
        }}<template v-if="session.model"> · {{ session.model }}</template></span
      >
      <span
        v-if="session.projectName || session.branch"
        class="aip-session-detail__tag aip-session-detail__tag--scope"
      >
        <template v-if="session.projectName">{{ session.projectName }}</template
        ><template v-if="session.projectName && session.branch"> · </template
        ><template v-if="session.branch">{{ session.branch }}</template>
      </span>
      <span v-if="session.jiraKey" class="aip-session-detail__tag aip-session-detail__tag--jira">{{
        session.jiraKey
      }}</span>
      <span class="aip-session-detail__tag aip-session-detail__tag--total"
        >{{ formatNumber(session.totalTokens) }} token</span
      >
      <span class="aip-session-detail__tag aip-session-detail__tag--turns"
        >{{ formatNumber(session.turns) }} 轮</span
      >
    </div>

    <p class="aip-session-detail__note">
      每轮时长为相邻两轮事件的间隔(含用户思考 / 空闲时间),非纯模型耗时;最后一轮无后继时显示「—」。
    </p>

    <ElSkeleton v-if="loading" :rows="4" animated />

    <div v-else-if="turns.length === 0" class="aip-session-detail__empty">
      <ElEmpty description="该会话无逐轮明细(本能力上线前记录)" />
    </div>

    <ol v-else class="aip-session-detail__list">
      <li v-for="(turn, i) in turns" :key="`${turn.at}-${i}`" class="aip-session-detail__turn">
        <div class="aip-session-detail__turn-main">
          <span class="aip-session-detail__turn-name" :title="turn.title || formatAt(turn.at)">{{
            turnLabel(turn, i)
          }}</span>
          <div class="aip-session-detail__turn-meta">
            <span class="aip-session-detail__turn-time">{{ formatAt(turn.at) }}</span>
            <span class="aip-session-detail__turn-dot">·</span>
            <span class="aip-session-detail__turn-duration">{{
              formatDuration(turn.durationMs)
            }}</span>
            <template v-if="turn.model">
              <span class="aip-session-detail__turn-dot">·</span>
              <span class="aip-session-detail__turn-model" :title="turn.model">{{
                turn.model
              }}</span>
            </template>
          </div>
        </div>
        <div class="aip-session-detail__turn-bar">
          <UsageBar :value="turn.total" :max="sessionTotal" color-mode="absolute" />
        </div>
      </li>
    </ol>
  </ElDialog>
</template>

<style scoped>
.aip-session-detail__header {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  flex-wrap: wrap;
  margin-bottom: var(--aipt-space-3);
}

.aip-session-detail__tag {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: var(--aipt-radius-pill);
  background: rgba(148, 163, 184, 0.16);
  color: var(--aipt-text-secondary);
  border: 1px solid transparent;
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aip-session-detail__tag--scope {
  background: rgba(167, 139, 250, 0.16);
  border-color: rgba(167, 139, 250, 0.34);
  color: #a78bfa;
}

.aip-session-detail__tag--jira {
  background: rgba(110, 167, 245, 0.16);
  border-color: rgba(110, 167, 245, 0.4);
  color: #6ea7f5;
}

.aip-session-detail__tag--turns {
  background: rgba(94, 200, 191, 0.18);
  border-color: rgba(94, 200, 191, 0.36);
  color: #3fa89d;
}

.aip-session-detail__note {
  margin: 0 0 var(--aipt-space-4);
  font-size: 11px;
  color: var(--aipt-text-muted);
  line-height: 1.6;
}

.aip-session-detail__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
}

.aip-session-detail__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 52vh;
  overflow-y: auto;
}

.aip-session-detail__turn {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-3) 0;
  border-bottom: 1px solid var(--aipt-border-faint);
}

.aip-session-detail__turn:last-child {
  border-bottom: none;
}

.aip-session-detail__turn-main {
  flex: 1 1 58%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-session-detail__turn-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aip-session-detail__turn-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--aipt-text-muted);
  min-width: 0;
}

.aip-session-detail__turn-model {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aip-session-detail__turn-dot {
  color: var(--aipt-text-faint);
}

.aip-session-detail__turn-bar {
  flex: 1 1 42%;
  min-width: 140px;
  max-width: 320px;
}
</style>
