<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { primaryNav, footerNav, type NavItem } from '../router'

const props = defineProps<{
  collapsed: boolean
  mobileOpen?: boolean
}>()

const emit = defineEmits<{
  'toggle-collapsed': []
  'mobile-close': []
}>()

const route = useRoute()
const router = useRouter()

const activeKey = computed<string>(() => {
  const meta = route.meta as { navKey?: string } | undefined
  return meta?.navKey ?? (route.name as string) ?? 'workspace'
})

function navigate(item: NavItem) {
  if (item.routeName) {
    router.push({ name: item.routeName })
  } else if (item.path) {
    router.push(item.path)
  }
  emit('mobile-close')
}

const isActive = (item: NavItem) => activeKey.value === item.key
</script>

<template>
  <aside
    :class="[
      'aipt-sidebar',
      'aipt-glass',
      'aipt-glass--solid',
      { 'is-collapsed': props.collapsed, 'is-mobile-open': props.mobileOpen }
    ]"
    :aria-expanded="!props.collapsed"
  >
    <nav class="aipt-sidebar__nav">
      <button
        v-for="item in primaryNav"
        :key="item.key"
        type="button"
        :class="['aipt-sidebar__item', { 'is-active': isActive(item) }]"
        :title="props.collapsed ? item.label : ''"
        @click="navigate(item)"
      >
        <span class="aipt-sidebar__icon">
          <i :class="item.icon"></i>
        </span>
        <span class="aipt-sidebar__label">{{ item.label }}</span>
        <span v-if="isActive(item)" class="aipt-sidebar__active-bar"></span>
      </button>
    </nav>

    <div class="aipt-sidebar__footer">
      <button
        v-for="item in footerNav"
        :key="item.key"
        type="button"
        :class="[
          'aipt-sidebar__item',
          'aipt-sidebar__item--ghost',
          { 'is-active': isActive(item) }
        ]"
        :title="props.collapsed ? item.label : ''"
        @click="navigate(item)"
      >
        <span class="aipt-sidebar__icon">
          <i :class="item.icon"></i>
        </span>
        <span class="aipt-sidebar__label">{{ item.label }}</span>
      </button>

      <button
        type="button"
        class="aipt-sidebar__collapse"
        :aria-label="props.collapsed ? '展开侧栏' : '折叠侧栏'"
        :title="props.collapsed ? '展开侧栏' : '折叠侧栏'"
        @click="emit('toggle-collapsed')"
      >
        <i :class="props.collapsed ? 'i-lucide-chevrons-right' : 'i-lucide-chevrons-left'"></i>
        <span class="aipt-sidebar__label">{{ props.collapsed ? '展开' : '折叠' }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.aipt-sidebar {
  position: relative;
  z-index: var(--aipt-z-sidebar);
  width: var(--aipt-sidebar-w);
  height: calc(100vh - var(--aipt-topbar-h));
  border-radius: 0;
  border-top: 0;
  border-bottom: 0;
  border-left: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: var(--aipt-space-4) var(--aipt-space-3);
  transition: width var(--aipt-duration-slow) var(--aipt-easing-out);
}

.aipt-sidebar.is-collapsed {
  width: var(--aipt-sidebar-w-collapsed);
}

.aipt-sidebar__nav,
.aipt-sidebar__footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.aipt-sidebar__footer {
  border-top: 1px solid var(--aipt-border-faint);
  padding-top: var(--aipt-space-3);
}

.aipt-sidebar__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: 10px var(--aipt-space-3);
  border-radius: var(--aipt-radius-md);
  background: transparent;
  border: 1px solid transparent;
  color: var(--aipt-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  width: 100%;
  white-space: nowrap;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out),
    border-color var(--aipt-duration-base) var(--aipt-easing-out),
    transform var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-sidebar__item:hover {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}

.aipt-sidebar__item.is-active {
  background: var(--aipt-surface-strong);
  color: var(--aipt-text-strong);
  border-color: var(--aipt-border-strong);
  box-shadow: var(--aipt-shadow-glow);
}

.aipt-sidebar__item.is-active::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--aipt-gradient-aurora-soft);
  pointer-events: none;
  opacity: 0.8;
}

.aipt-sidebar__item--ghost {
  color: var(--aipt-text-muted);
  font-weight: 400;
}

.aipt-sidebar__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}

.aipt-sidebar__icon i {
  font-size: 18px;
}

.aipt-sidebar__label {
  position: relative;
  z-index: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-sidebar.is-collapsed .aipt-sidebar__label {
  opacity: 0;
  pointer-events: none;
  width: 0;
}

.aipt-sidebar__active-bar {
  position: absolute;
  left: -6px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 22px;
  border-radius: var(--aipt-radius-pill);
  background: var(--aipt-gradient-aurora);
  box-shadow: 0 0 12px rgba(110, 167, 245, 0.55);
}

.aipt-sidebar__collapse {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-3);
  padding: 10px var(--aipt-space-3);
  border-radius: var(--aipt-radius-md);
  background: transparent;
  border: 1px dashed var(--aipt-border);
  color: var(--aipt-text-muted);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition:
    background var(--aipt-duration-base) var(--aipt-easing-out),
    color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aipt-sidebar__collapse:hover {
  background: var(--aipt-surface-hover);
  color: var(--aipt-text);
}

.aipt-sidebar__collapse i {
  font-size: 16px;
}

/* ===== Mobile drawer ===== */
@media (max-width: 1024px) {
  .aipt-sidebar {
    position: fixed;
    top: var(--aipt-topbar-h);
    left: 0;
    bottom: 0;
    width: var(--aipt-sidebar-w);
    transform: translateX(-100%);
    transition: transform var(--aipt-duration-slow) var(--aipt-easing-out);
    box-shadow: var(--aipt-shadow-elevated);
  }
  .aipt-sidebar.is-mobile-open {
    transform: translateX(0);
  }
  .aipt-sidebar__collapse {
    display: none;
  }
  .aipt-sidebar.is-collapsed {
    width: var(--aipt-sidebar-w);
  }
  .aipt-sidebar.is-collapsed .aipt-sidebar__label {
    opacity: 1;
    width: auto;
    pointer-events: auto;
  }
}
</style>
