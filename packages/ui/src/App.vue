<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'

import { tabs } from './router'

const route = useRoute()
const router = useRouter()

const activeKey = computed(() => (route.name as string) || 'workspace')

function handleTabClick(key: string) {
  router.push({ name: key })
}
</script>

<template>
  <div class="aipt-shell">
    <header class="aipt-shell__header">
      <div class="aipt-shell__brand">
        <h1 class="aipt-shell__title">AI Productivity Tracker</h1>
        <span class="aipt-shell__sub">本机数据 · 跨 IDE 提效追踪</span>
      </div>
      <nav class="aipt-shell__tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          :class="['aipt-shell__tab', { 'aipt-shell__tab--active': activeKey === tab.key }]"
          @click="handleTabClick(tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>
    <main class="aipt-shell__content">
      <RouterView />
    </main>
  </div>
</template>

<style>
:root {
  color-scheme: light dark;
  --aipt-bg: #f5f7fa;
  --aipt-bg-card: #ffffff;
  --aipt-text: #1f2329;
  --aipt-text-muted: #6b7280;
  --aipt-border: #e4e7ed;
  --aipt-primary: #409eff;
  --aipt-header-bg: #ffffff;
  --aipt-header-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
}

@media (prefers-color-scheme: dark) {
  :root {
    --aipt-bg: #1d1f23;
    --aipt-bg-card: #25272d;
    --aipt-text: #e6e8eb;
    --aipt-text-muted: #9aa0a6;
    --aipt-border: #34373d;
    --aipt-header-bg: #25272d;
    --aipt-header-shadow: 0 1px 0 rgba(255, 255, 255, 0.06);
  }
}

html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100%;
  background: var(--aipt-bg);
  color: var(--aipt-text);
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}

.aipt-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.aipt-shell__header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--aipt-header-bg);
  box-shadow: var(--aipt-header-shadow);
  padding: 12px 24px 0 24px;
}

.aipt-shell__brand {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.aipt-shell__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.aipt-shell__sub {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aipt-shell__tabs {
  display: flex;
  gap: 4px;
  margin-top: 12px;
  border-bottom: 1px solid var(--aipt-border);
}

.aipt-shell__tab {
  border: none;
  background: transparent;
  padding: 10px 16px;
  font-size: 14px;
  color: var(--aipt-text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.aipt-shell__tab:hover {
  color: var(--aipt-text);
}

.aipt-shell__tab--active {
  color: var(--aipt-primary);
  border-bottom-color: var(--aipt-primary);
  font-weight: 500;
}

.aipt-shell__content {
  flex: 1;
  padding: 24px;
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
</style>
