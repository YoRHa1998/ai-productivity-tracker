<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, RouterView } from 'vue-router'

import AppSidebar from './AppSidebar.vue'
import AppTopBar from './AppTopBar.vue'
import BackgroundCanvas from './BackgroundCanvas.vue'

const COLLAPSE_KEY = 'aipt:sidebar-collapsed'

const route = useRoute()

const sidebarCollapsed = ref<boolean>(
  typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1'
)

const mobileOpen = ref(false)

watch(sidebarCollapsed, (v) => {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
  }
})

function toggleCollapsed() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

function toggleMobile() {
  mobileOpen.value = !mobileOpen.value
}

function closeMobile() {
  mobileOpen.value = false
}

// 路由切换时自动收起 mobile 抽屉
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  }
)

// 简易 ESC 关 mobile 抽屉
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && mobileOpen.value) mobileOpen.value = false
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="aipt-shell">
    <BackgroundCanvas />
    <AppTopBar :mobile-menu-open="mobileOpen" @toggle-mobile-menu="toggleMobile" />
    <div class="aipt-shell__body">
      <AppSidebar
        :collapsed="sidebarCollapsed"
        :mobile-open="mobileOpen"
        @toggle-collapsed="toggleCollapsed"
        @mobile-close="closeMobile"
      />
      <main class="aipt-shell__main">
        <RouterView v-slot="{ Component, route: r }">
          <Transition name="aipt-route-fade" mode="out-in">
            <component :is="Component" :key="r.fullPath" />
          </Transition>
        </RouterView>
      </main>
    </div>
    <div v-if="mobileOpen" class="aipt-shell__scrim" @click="closeMobile"></div>
  </div>
</template>

<style scoped>
.aipt-shell {
  position: relative;
  z-index: var(--aipt-z-base);
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  height: 100vh;
  overflow: hidden;
}

.aipt-shell__body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  position: relative;
}

.aipt-shell__main {
  flex: 1 1 auto;
  min-width: 0;
  height: calc(100vh - var(--aipt-topbar-h));
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--aipt-space-6) var(--aipt-space-6);
}

@media (max-width: 1024px) {
  .aipt-shell__main {
    padding: var(--aipt-space-5);
  }
}

@media (max-width: 640px) {
  .aipt-shell__main {
    padding: var(--aipt-space-4) var(--aipt-space-3);
  }
}

.aipt-shell__scrim {
  display: none;
  position: fixed;
  inset: var(--aipt-topbar-h) 0 0 0;
  background: rgba(7, 10, 20, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: calc(var(--aipt-z-sidebar) - 1);
  animation: aipt-fade-in var(--aipt-duration-base) var(--aipt-easing-out);
}

@media (max-width: 1024px) {
  .aipt-shell__scrim {
    display: block;
  }
}
</style>
