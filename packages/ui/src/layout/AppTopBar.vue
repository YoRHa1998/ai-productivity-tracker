<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useAgentContext, type DotState } from '../composables/useAgentContext'
import { useActiveBinding } from '../composables/useActiveBinding'
import { useTheme } from '../composables/useTheme'

defineProps<{
  /** sidebar 折叠回调,sidebar 自己管;此处提供 mobile 抽屉触发 */
  mobileMenuOpen?: boolean
}>()

const emit = defineEmits<{
  'toggle-mobile-menu': []
}>()

const { state: agentState, daemonDot, hookDot, skillDot, refresh } = useAgentContext()
const { state: bindingState, jiraKey: activeJiraKey, title: activeTitle } = useActiveBinding()
const { resolvedTheme, theme, cycleTheme } = useTheme()

const themeLabel = computed(() => {
  if (theme.value === 'auto') return '自动'
  if (theme.value === 'dark') return '深色'
  return '浅色'
})

const themeIconKey = computed(() => {
  if (theme.value === 'auto') return 'auto'
  return resolvedTheme.value
})

const daemonText = computed(() => {
  if (!agentState.value.agent.ok) return 'Daemon 离线'
  const port = agentState.value.agent.port
  const version = agentState.value.agent.version
  return `Daemon · v${version ?? '?'}${port ? ` · :${port}` : ''}`
})

const daemonVersion = computed(() => {
  const v = agentState.value.agent.version
  return v ? `v${v}` : ''
})

const daemonPort = computed(() => {
  const p = agentState.value.agent.port
  return p ? `:${p}` : ''
})

const daemonOnline = computed(() => agentState.value.agent.ok)

const refreshing = ref(false)

async function handleRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await refresh()
  } finally {
    setTimeout(() => {
      refreshing.value = false
    }, 300)
  }
}

watch(
  () => agentState.value.loading,
  (loading) => {
    if (!loading) refreshing.value = false
  }
)

const dotClass = (state: DotState) => {
  const base = 'aipt-status-dot aipt-pulse-dot'
  if (state === 'ok') return `${base} aipt-status-dot--ok`
  if (state === 'warn') return `${base} aipt-status-dot--warn`
  if (state === 'danger') return `${base} aipt-status-dot--danger`
  return 'aipt-status-dot aipt-status-dot--muted'
}
</script>

<template>
  <header class="aipt-topbar aipt-glass aipt-glass--solid">
    <div class="aipt-topbar__left">
      <button
        class="aipt-topbar__menu"
        type="button"
        :aria-label="mobileMenuOpen ? '关闭菜单' : '打开菜单'"
        @click="emit('toggle-mobile-menu')"
      >
        <i class="i-lucide-menu"></i>
      </button>
      <div class="aipt-topbar__brand">
        <span class="aipt-topbar__logo aipt-aurora-bg">
          <i class="i-lucide-sparkles"></i>
        </span>
        <div class="aipt-topbar__brand-text">
          <span class="aipt-topbar__brand-title aipt-aurora-text">AI Productivity Tracker</span>
          <span class="aipt-topbar__brand-sub">本机数据 · 跨 IDE 提效追踪</span>
        </div>
      </div>
    </div>

    <div class="aipt-topbar__center">
      <div
        v-if="activeJiraKey"
        class="aipt-topbar__context"
        :title="`当前活跃需求 · ${activeJiraKey} · ${activeTitle ?? ''}`"
      >
        <span class="aipt-status-dot aipt-status-dot--ok"></span>
        <span class="aipt-topbar__context-key aipt-num">{{ activeJiraKey }}</span>
        <span class="aipt-topbar__context-divider"></span>
        <span class="aipt-topbar__context-title">{{ activeTitle ?? '—' }}</span>
      </div>
      <div v-else class="aipt-topbar__context aipt-topbar__context--idle">
        <span class="aipt-status-dot aipt-status-dot--muted"></span>
        <span>{{ bindingState.loading ? '检测中…' : '未绑定活跃需求' }}</span>
      </div>
    </div>

    <div class="aipt-topbar__right">
      <div class="aipt-topbar__status">
        <span class="aipt-topbar__status-item" :title="daemonText">
          <span :class="dotClass(daemonDot)"></span>
          <span class="aipt-topbar__status-label">Daemon</span>
          <template v-if="daemonOnline">
            <span v-if="daemonVersion" class="aipt-topbar__status-meta aipt-num">{{
              daemonVersion
            }}</span>
            <span v-if="daemonPort" class="aipt-topbar__status-meta aipt-num">{{
              daemonPort
            }}</span>
          </template>
          <span v-else class="aipt-topbar__status-meta aipt-topbar__status-meta--danger">离线</span>
        </span>
        <span class="aipt-topbar__status-divider" aria-hidden="true"></span>
        <span class="aipt-topbar__status-item" title="Cursor afterAgentResponse Hook">
          <span :class="dotClass(hookDot)"></span>
          <span class="aipt-topbar__status-label">Hook</span>
        </span>
        <span class="aipt-topbar__status-divider" aria-hidden="true"></span>
        <span class="aipt-topbar__status-item" title="AI 对话追踪 Skill / Hook 注入态">
          <span :class="dotClass(skillDot)"></span>
          <span class="aipt-topbar__status-label">Skill</span>
        </span>
      </div>

      <button
        class="aipt-topbar__btn"
        type="button"
        :title="`切换主题(${themeLabel})`"
        @click="cycleTheme"
      >
        <i v-if="themeIconKey === 'dark'" class="i-lucide-moon"></i>
        <i v-else-if="themeIconKey === 'light'" class="i-lucide-sun"></i>
        <i v-else class="i-lucide-monitor"></i>
      </button>

      <button
        class="aipt-topbar__btn"
        type="button"
        :class="{ 'is-loading': refreshing }"
        title="刷新状态"
        @click="handleRefresh"
      >
        <i class="i-lucide-refresh-cw"></i>
      </button>
    </div>
  </header>
</template>

<style scoped>
.aipt-topbar {
  position: sticky;
  top: 0;
  z-index: var(--aipt-z-topbar);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-4);
  height: var(--aipt-topbar-h);
  padding: 0 var(--aipt-space-5);
  border-radius: 0;
  border-left: 0;
  border-right: 0;
  border-top: 0;
}

.aipt-topbar__left {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  min-width: 0;
  flex: 0 0 auto;
}

.aipt-topbar__menu {
  display: none;
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

.aipt-topbar__menu:hover {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}

.aipt-topbar__menu i {
  font-size: 18px;
}

.aipt-topbar__brand {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  min-width: 0;
}

.aipt-topbar__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--aipt-radius-md);
  color: var(--aipt-text-on-accent);
  box-shadow: var(--aipt-shadow-glow);
  flex-shrink: 0;
}

.aipt-topbar__logo i {
  font-size: 18px;
}

.aipt-topbar__brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.aipt-topbar__brand-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.aipt-topbar__brand-sub {
  font-size: 11px;
  color: var(--aipt-text-muted);
  line-height: 1.4;
  letter-spacing: 0.02em;
}

/* ===== Center ===== */
.aipt-topbar__center {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.aipt-topbar__context {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
  padding: 6px 14px;
  border-radius: var(--aipt-radius-pill);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  backdrop-filter: blur(var(--aipt-blur-sm));
  -webkit-backdrop-filter: blur(var(--aipt-blur-sm));
  max-width: 460px;
  min-width: 0;
  font-size: 12px;
  color: var(--aipt-text-secondary);
  transition:
    border-color var(--aipt-duration-base) var(--aipt-easing-out),
    background var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-topbar__context:hover {
  border-color: var(--aipt-border-strong);
  background: var(--aipt-surface-hover);
}

.aipt-topbar__context--idle {
  color: var(--aipt-text-muted);
}

.aipt-topbar__context-key {
  color: var(--aipt-text);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.aipt-topbar__context-divider {
  width: 1px;
  height: 12px;
  background: var(--aipt-border-strong);
}

.aipt-topbar__context-title {
  color: var(--aipt-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ===== Right ===== */
.aipt-topbar__right {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  flex: 0 0 auto;
}

.aipt-topbar__status {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: 6px 12px;
  border-radius: var(--aipt-radius-pill);
  background: var(--aipt-surface);
  border: 1px solid var(--aipt-border);
  margin-right: var(--aipt-space-2);
}

.aipt-topbar__status-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.aipt-topbar__status-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--aipt-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.aipt-topbar__status-meta {
  font-size: 11px;
  font-weight: 600;
  color: var(--aipt-text-secondary);
  letter-spacing: 0;
  padding: 1px 6px;
  border-radius: var(--aipt-radius-sm);
  background: var(--aipt-surface-hover);
  border: 1px solid var(--aipt-border);
  line-height: 1.4;
  white-space: nowrap;
}

.aipt-topbar__status-meta--danger {
  color: var(--aipt-danger, #d4380d);
  background: transparent;
  border-color: transparent;
  padding: 0;
}

.aipt-topbar__status-divider {
  width: 1px;
  height: 12px;
  background: var(--aipt-border);
  flex-shrink: 0;
}

.aipt-topbar__btn {
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
    color var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-topbar__btn i {
  font-size: 16px;
}

.aipt-topbar__btn:hover {
  background: var(--aipt-surface-hover);
  border-color: var(--aipt-border-strong);
  color: var(--aipt-text);
}

.aipt-topbar__btn.is-loading i {
  animation: aipt-spin 1s linear infinite;
}

@keyframes aipt-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== Responsive ===== */
@media (max-width: 1024px) {
  .aipt-topbar__menu {
    display: inline-flex;
  }
  .aipt-topbar__brand-sub {
    display: none;
  }
}

@media (max-width: 1180px) {
  .aipt-topbar__status-meta {
    /* 中等宽度下只保留端口,版本号隐去避免挤压 */
  }
  .aipt-topbar__status-item .aipt-topbar__status-meta:first-of-type {
    /* version meta 在窄屏隐藏 */
  }
}

@media (max-width: 1024px) {
  .aipt-topbar__status-item
    .aipt-topbar__status-meta:not(.aipt-topbar__status-meta--danger):first-of-type {
    display: none;
  }
}

@media (max-width: 860px) {
  .aipt-topbar__center {
    display: none;
  }
  .aipt-topbar__status-label {
    display: none;
  }
  .aipt-topbar__status-divider {
    display: none;
  }
  .aipt-topbar__status {
    padding: 6px 10px;
    gap: var(--aipt-space-2);
  }
  .aipt-topbar__status-meta {
    display: none;
  }
}

@media (max-width: 640px) {
  .aipt-topbar {
    padding: 0 var(--aipt-space-3);
    gap: var(--aipt-space-2);
  }
  .aipt-topbar__brand-text {
    display: none;
  }
  .aipt-topbar__status {
    display: none;
  }
}
</style>
