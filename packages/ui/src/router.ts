import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

import AiProductivityTrackerWorkspaceTab from './tabs/AiProductivityTrackerWorkspaceTab.vue'
import AiProductivityTrackerLessonsTab from './tabs/AiProductivityTrackerLessonsTab.vue'
import AiProductivityTrackerSettingsTab from './tabs/AiProductivityTrackerSettingsTab.vue'
import AiProductivityTrackerMcpConfigTab from './tabs/AiProductivityTrackerMcpConfigTab.vue'
import AiProductivityTrackerGuideTab from './tabs/AiProductivityTrackerGuideTab.vue'
import SettingsLayout from './tabs/settings/SettingsLayout.vue'
import DaemonStatusPage from './tabs/settings/DaemonStatusPage.vue'

/**
 * 侧边栏导航定义。
 *
 * 设计:
 * - primaryNav 渲染 sidebar 主区(看板 / 复盘 / 设置)
 * - footerNav 渲染 sidebar 底部(帮助 / 关于 等)
 * - `navKey` 与 route.meta.navKey 对应,用于父子路由下高亮顶层 nav
 * - `icon` 走 UnoCSS presetIcons 的 i-lucide-* 类名,无需手动 import 图标组件
 */
export interface NavItem {
  key: string
  label: string
  icon: string
  routeName?: string
  path?: string
}

export const primaryNav: NavItem[] = [
  {
    key: 'workspace',
    label: '需求看板',
    icon: 'i-lucide-layout-dashboard',
    routeName: 'workspace'
  },
  { key: 'lessons', label: '复盘经验', icon: 'i-lucide-sparkles', routeName: 'lessons' },
  { key: 'settings', label: '设置', icon: 'i-lucide-settings-2', routeName: 'settings-basic' }
]

export const footerNav: NavItem[] = [
  { key: 'guide', label: '使用说明', icon: 'i-lucide-book-open', routeName: 'guide' }
]

/** 兼容老导出,App.vue / 第三方代码若仍引用 `tabs` 数组不会爆 */
export interface TabMeta {
  key: string
  label: string
  order: number
}
export const tabs: TabMeta[] = primaryNav.concat(footerNav).map((n, idx) => ({
  key: n.key,
  label: n.label,
  order: idx + 1
}))

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/workspace' },
  {
    path: '/workspace',
    name: 'workspace',
    component: AiProductivityTrackerWorkspaceTab,
    meta: { label: '需求看板', navKey: 'workspace' }
  },
  {
    path: '/lessons',
    name: 'lessons',
    component: AiProductivityTrackerLessonsTab,
    meta: { label: '复盘经验', navKey: 'lessons' }
  },
  {
    path: '/settings',
    component: SettingsLayout,
    meta: { label: '设置', navKey: 'settings' },
    redirect: '/settings/basic',
    children: [
      {
        path: 'basic',
        name: 'settings-basic',
        component: AiProductivityTrackerSettingsTab,
        meta: { label: '基础', navKey: 'settings', segment: 'basic' }
      },
      {
        path: 'mcp',
        name: 'settings-mcp',
        component: AiProductivityTrackerMcpConfigTab,
        meta: { label: 'MCP 接入', navKey: 'settings', segment: 'mcp' }
      },
      {
        path: 'daemon',
        name: 'settings-daemon',
        component: DaemonStatusPage,
        meta: { label: 'Daemon 状态', navKey: 'settings', segment: 'daemon' }
      }
    ]
  },
  // 老路径向后兼容(浏览器收藏夹 / 文档链接保持可用)
  { path: '/mcp-config', redirect: '/settings/mcp' },
  {
    path: '/guide',
    name: 'guide',
    component: AiProductivityTrackerGuideTab,
    meta: { label: '使用说明', navKey: 'guide' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/workspace' }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
