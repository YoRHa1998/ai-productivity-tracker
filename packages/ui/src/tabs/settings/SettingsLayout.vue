<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

interface SettingsSegment {
  key: string
  label: string
  icon: string
  routeName: string
}

const segments: SettingsSegment[] = [
  { key: 'basic', label: '基础', icon: 'i-lucide-sliders-horizontal', routeName: 'settings-basic' },
  { key: 'mcp', label: 'MCP 接入', icon: 'i-lucide-plug', routeName: 'settings-mcp' },
  { key: 'daemon', label: 'Daemon 状态', icon: 'i-lucide-activity', routeName: 'settings-daemon' }
]

const route = useRoute()
const router = useRouter()

const active = computed<string>(() => {
  const meta = route.meta as { segment?: string } | undefined
  return meta?.segment ?? 'basic'
})

function go(seg: SettingsSegment) {
  if (seg.key === active.value) return
  router.push({ name: seg.routeName })
}
</script>

<template>
  <div class="aipt-settings">
    <header class="aipt-settings__header">
      <div class="aipt-settings__heading">
        <h1 class="aipt-settings__title aipt-aurora-text">设置</h1>
        <p class="aipt-settings__sub">配置提效公式、IDE 接入与本地 Daemon 运行状态</p>
      </div>
      <nav class="aipt-settings__segmented aipt-glass">
        <button
          v-for="seg in segments"
          :key="seg.key"
          type="button"
          :class="['aipt-settings__seg', { 'is-active': active === seg.key }]"
          @click="go(seg)"
        >
          <i :class="seg.icon"></i>
          <span>{{ seg.label }}</span>
        </button>
      </nav>
    </header>
    <section class="aipt-settings__body">
      <RouterView v-slot="{ Component, route: r }">
        <Transition name="aipt-route-fade" mode="out-in">
          <component :is="Component" :key="r.fullPath" />
        </Transition>
      </RouterView>
    </section>
  </div>
</template>

<style scoped>
.aipt-settings {
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-5);
  max-width: var(--aipt-content-max-w);
  margin: 0 auto;
}

.aipt-settings__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--aipt-space-4);
}

.aipt-settings__heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-settings__title {
  margin: 0;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.aipt-settings__sub {
  margin: 0;
  font-size: 13px;
  color: var(--aipt-text-muted);
}

.aipt-settings__segmented {
  display: inline-flex;
  padding: 4px;
  gap: 2px;
  border-radius: var(--aipt-radius-pill);
}

.aipt-settings__seg {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--aipt-radius-pill);
  background: transparent;
  border: 0;
  color: var(--aipt-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-settings__seg:hover {
  color: var(--aipt-text);
  background: var(--aipt-surface-hover);
}

.aipt-settings__seg.is-active {
  background: var(--aipt-gradient-aurora);
  color: var(--aipt-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aipt-shadow-glow);
}

.aipt-settings__seg i {
  font-size: 15px;
}

.aipt-settings__body {
  display: flex;
  flex-direction: column;
}

@media (max-width: 640px) {
  .aipt-settings__segmented {
    width: 100%;
    overflow-x: auto;
  }
  .aipt-settings__seg {
    flex-shrink: 0;
  }
}
</style>
