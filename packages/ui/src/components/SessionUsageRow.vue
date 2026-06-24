<script setup lang="ts">
import { computed } from 'vue'

import type { AiUsageSource, SessionUsageView } from '../api'
import UsageBar from './UsageBar.vue'

/**
 * 可复用「会话用量明细」行:标题 / 工具·model / 项目·分支 / 时间窗 / 轮次 / 用量条。
 *
 * 「AI 用量」会话列表与「用量测算」记录详情共用,保持渲染口径一致。
 * - `session`:单条会话视图;`maxTotal`:列表内 total 最大值,作 UsageBar 归一化分母。
 * - jiraKey 徽标下钻不在组件内直接路由,而是 emit `goto-requirement`,由父级决定跳转,
 *   避免组件耦合 router(详情面板与用量页跳转目标可一致复用)。
 */
const props = defineProps<{
  session: SessionUsageView
  maxTotal: number
}>()

const emit = defineEmits<{
  (e: 'goto-requirement', jiraKey: string): void
}>()

const SOURCE_LABEL: Record<AiUsageSource, string> = {
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex'
}

/** AI 工具 → 标签底色修饰类(与 SOURCE_COLOR 同源,不同工具不同底色)。 */
const SOURCE_TAG_CLASS: Record<AiUsageSource, string> = {
  cursor: 'aip-session-row__tag--cursor',
  'claude-code': 'aip-session-row__tag--claude',
  codex: 'aip-session-row__tag--codex'
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** 会话展示标识:title 优先;否则短会话 ID + 工具。 */
const label = computed(() => {
  const s = props.session
  if (s.title && s.title.trim()) return s.title
  const shortId = s.sessionId ? s.sessionId.slice(0, 8) : '—'
  return `${SOURCE_LABEL[s.source]} · ${shortId}`
})

/** 绝对时间窗「MM-DD HH:mm → MM-DD HH:mm」,作时长标签的 title 兜底悬浮。 */
const timeWindowAbsolute = computed(() => {
  const fmt = (iso: string) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const from = fmt(props.session.firstAt)
  const to = fmt(props.session.lastAt)
  return from && to ? `${from} → ${to}` : from || to
})

/**
 * 会话持续时长(firstAt → lastAt)紧凑展示:
 * 不足 1 分钟(含起止相同 / 无法解析)统一上调为 `1min`;< 60 分钟 → `Nmin`;
 * 否则 `Xh` 或 `XhYmin`。
 */
const duration = computed(() => {
  const from = Date.parse(props.session.firstAt)
  const to = Date.parse(props.session.lastAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '1min'
  const totalSec = Math.round((to - from) / 1000)
  if (totalSec < 60) return '1min'
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin}min`
  const hours = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min === 0 ? `${hours}h` : `${hours}h${min}min`
})
</script>

<template>
  <article class="aip-session-row">
    <div class="aip-session-row__main">
      <div class="aip-session-row__title-line">
        <span class="aip-session-row__title" :title="session.title || session.sessionId">{{
          label
        }}</span>
        <button
          v-if="session.jiraKey"
          type="button"
          class="aip-session-row__jira"
          :title="`跳转到需求 ${session.jiraKey}`"
          @click="emit('goto-requirement', session.jiraKey)"
        >
          {{ session.jiraKey }}
        </button>
      </div>
      <div class="aip-session-row__meta">
        <span
          class="aip-session-row__tag aip-session-row__tag--source"
          :class="SOURCE_TAG_CLASS[session.source]"
          :title="
            session.model
              ? `${SOURCE_LABEL[session.source]} · ${session.model}`
              : SOURCE_LABEL[session.source]
          "
          >{{ SOURCE_LABEL[session.source]
          }}<span v-if="session.model" class="aip-session-row__tag-model">
            · {{ session.model }}</span
          ></span
        >
        <span
          v-if="session.projectName || session.branch"
          class="aip-session-row__tag aip-session-row__tag--scope"
          :title="
            [
              session.projectName ? `项目 ${session.projectName}` : '',
              session.branch ? `分支 ${session.branch}` : ''
            ]
              .filter(Boolean)
              .join(' · ')
          "
          ><template v-if="session.projectName">{{ session.projectName }}</template
          ><template v-if="session.projectName && session.branch"> · </template
          ><template v-if="session.branch">{{ session.branch }}</template></span
        >
        <span
          class="aip-session-row__tag aip-session-row__tag--duration"
          :title="timeWindowAbsolute"
          >{{ duration }}</span
        >
        <span class="aip-session-row__tag aip-session-row__tag--turns"
          >{{ formatNumber(session.turns) }} 轮</span
        >
      </div>
    </div>
    <div class="aip-session-row__bar">
      <UsageBar :value="session.totalTokens" :max="maxTotal" color-mode="absolute" />
    </div>
  </article>
</template>

<style scoped>
.aip-session-row {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-4);
  padding: var(--aipt-space-3) 0;
  border-bottom: 1px solid var(--aipt-border-faint);
}

.aip-session-row:last-child {
  border-bottom: none;
}

.aip-session-row__main {
  flex: 1 1 60%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aip-session-row__title-line {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  min-width: 0;
}

.aip-session-row__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aip-session-row__jira {
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

.aip-session-row__jira:hover {
  color: var(--aipt-text-on-accent);
  background: var(--aipt-primary);
  border-color: var(--aipt-primary);
}

.aip-session-row__meta {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  font-size: 11px;
  color: var(--aipt-text-muted);
  flex-wrap: wrap;
}

.aip-session-row__tag {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: var(--aipt-radius-pill);
  background: rgba(148, 163, 184, 0.16);
  color: var(--aipt-text-secondary);
  border: 1px solid transparent;
  line-height: 1.5;
}

.aip-session-row__tag-model {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.aip-session-row__tag--scope {
  white-space: normal;
  word-break: break-word;
  background: rgba(167, 139, 250, 0.16);
  border-color: rgba(167, 139, 250, 0.34);
  color: #a78bfa;
}

.aip-session-row__tag--duration {
  background: rgba(245, 188, 110, 0.18);
  border-color: rgba(245, 188, 110, 0.36);
  color: #d99a3c;
}

.aip-session-row__tag--turns {
  background: rgba(94, 200, 191, 0.18);
  border-color: rgba(94, 200, 191, 0.36);
  color: #3fa89d;
}

.aip-session-row__tag--cursor {
  background: rgba(110, 167, 245, 0.16);
  border-color: rgba(110, 167, 245, 0.4);
  color: #6ea7f5;
}

.aip-session-row__tag--claude {
  background: rgba(240, 166, 200, 0.16);
  border-color: rgba(240, 166, 200, 0.4);
  color: #f0a6c8;
}

.aip-session-row__tag--codex {
  background: rgba(159, 229, 212, 0.16);
  border-color: rgba(159, 229, 212, 0.4);
  color: #9fe5d4;
}

.aip-session-row__bar {
  flex: 1 1 40%;
  min-width: 140px;
  max-width: 320px;
}
</style>
