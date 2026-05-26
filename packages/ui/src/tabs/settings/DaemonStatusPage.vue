<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'

import AipAgentStatusCard from '../../components/AipAgentStatusCard.vue'
import { useAgentContext, type DotState } from '../../composables/useAgentContext'
import { fetchStoragePath } from '../../api'

const { state, daemonDot, hookDot, skillDot, watcherDot, refresh } = useAgentContext()

const storagePath = ref<string>('')
const storageLoading = ref(false)

async function loadStoragePath() {
  if (storagePath.value || storageLoading.value) return
  storageLoading.value = true
  try {
    const data = await fetchStoragePath()
    storagePath.value = data.root
  } catch {
    storagePath.value = ''
  } finally {
    storageLoading.value = false
  }
}

void loadStoragePath()

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success({ message: '已复制', duration: 1500 })
  } catch {
    ElMessage.warning({ message: '复制失败,请手动复制', duration: 2000 })
  }
}

const dotClass = (s: DotState) => {
  if (s === 'ok') return 'aipt-status-dot aipt-status-dot--ok'
  if (s === 'warn') return 'aipt-status-dot aipt-status-dot--warn'
  if (s === 'danger') return 'aipt-status-dot aipt-status-dot--danger'
  return 'aipt-status-dot aipt-status-dot--muted'
}

const watcherLabel = computed(() => {
  const w = state.value.watcher
  if (!w) return '未知'
  return w.running ? `运行中 · 已追踪 ${w.trackedFiles} 文件` : '未运行'
})

const cursorHookLabel = computed(() => {
  const h = state.value.cursorHook
  if (!h) return '未知'
  if (!h.hookInstalled) return '未注入'
  if (h.legacyHookDetected) return '已注入(检测到老条目)'
  return h.debugMode ? '已注入(debug)' : '已注入'
})

const trackSkillLabel = computed(() => {
  const sk = state.value.trackSkill
  if (!sk) return '未知'
  const flags = [
    sk.claude?.installed && 'Claude SKILL',
    sk.claude?.hook?.installed && 'Claude Hook',
    sk.cursor?.installed && 'Cursor Rule',
    sk.cursor?.hook?.stopCheckInstalled && 'Cursor Stop'
  ].filter(Boolean) as string[]
  return flags.length ? flags.join(' · ') : '未注入'
})
</script>

<template>
  <div class="aipt-daemon">
    <AipAgentStatusCard variant="business" @ready="refresh" />

    <section class="aipt-glass aipt-glass--accent aipt-daemon__panel">
      <header class="aipt-daemon__panel-header">
        <div>
          <h3 class="aipt-daemon__panel-title">实时状态</h3>
          <p class="aipt-daemon__panel-sub">轮询间隔 30s · 也可点顶栏刷新按钮立即重拉</p>
        </div>
      </header>

      <div class="aipt-daemon__grid">
        <article class="aipt-daemon__cell">
          <header class="aipt-daemon__cell-header">
            <span :class="dotClass(daemonDot)"></span>
            <span class="aipt-daemon__cell-title">Daemon HTTP</span>
          </header>
          <p class="aipt-daemon__cell-meta">
            v{{ state.agent.version ?? '?' }} ·
            {{ state.agent.ok ? `运行在 :${state.agent.port ?? '?'}` : '离线 / 未启动' }}
          </p>
        </article>

        <article class="aipt-daemon__cell">
          <header class="aipt-daemon__cell-header">
            <span :class="dotClass(hookDot)"></span>
            <span class="aipt-daemon__cell-title">Cursor Hook</span>
          </header>
          <p class="aipt-daemon__cell-meta">{{ cursorHookLabel }}</p>
        </article>

        <article class="aipt-daemon__cell">
          <header class="aipt-daemon__cell-header">
            <span :class="dotClass(skillDot)"></span>
            <span class="aipt-daemon__cell-title">追踪 Skill</span>
          </header>
          <p class="aipt-daemon__cell-meta">{{ trackSkillLabel }}</p>
        </article>

        <article class="aipt-daemon__cell">
          <header class="aipt-daemon__cell-header">
            <span :class="dotClass(watcherDot)"></span>
            <span class="aipt-daemon__cell-title">Claude Watcher</span>
          </header>
          <p class="aipt-daemon__cell-meta">{{ watcherLabel }}</p>
        </article>
      </div>
    </section>

    <section class="aipt-glass aipt-daemon__panel">
      <header class="aipt-daemon__panel-header">
        <div>
          <h3 class="aipt-daemon__panel-title">本机数据根目录</h3>
          <p class="aipt-daemon__panel-sub">需求 / iteration / lessons / formula 等全部落本地</p>
        </div>
      </header>
      <div class="aipt-daemon__path-row">
        <code class="aipt-code aipt-code--dark" @click="storagePath && copy(storagePath)">{{
          storagePath || (storageLoading ? '加载中…' : '—')
        }}</code>
        <button
          v-if="storagePath"
          type="button"
          class="aipt-daemon__copy-btn"
          @click="copy(storagePath)"
        >
          <i class="i-lucide-copy"></i>
          <span>复制</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.aipt-daemon {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
}

.aipt-daemon__panel {
  padding: var(--aipt-space-5) var(--aipt-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-4);
}

.aipt-daemon__panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-3);
}

.aipt-daemon__panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--aipt-text-strong);
  letter-spacing: -0.01em;
}

.aipt-daemon__panel-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-daemon__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--aipt-space-3);
}

.aipt-daemon__cell {
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.aipt-daemon__cell-header {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
}

.aipt-daemon__cell-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text);
}

.aipt-daemon__cell-meta {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-daemon__path-row {
  display: flex;
  align-items: stretch;
  gap: var(--aipt-space-2);
}

.aipt-daemon__path-row code {
  flex: 1;
  min-width: 0;
}

.aipt-daemon__copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  color: var(--aipt-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-daemon__copy-btn:hover {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}
</style>
