import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

import AiProductivityTrackerWorkspaceTab from './tabs/AiProductivityTrackerWorkspaceTab.vue'
import AiProductivityTrackerLessonsTab from './tabs/AiProductivityTrackerLessonsTab.vue'
import AiProductivityTrackerSettingsTab from './tabs/AiProductivityTrackerSettingsTab.vue'
import AiProductivityTrackerMcpConfigTab from './tabs/AiProductivityTrackerMcpConfigTab.vue'
import AiProductivityTrackerAboutTab from './tabs/AiProductivityTrackerAboutTab.vue'
import AiProductivityTrackerGuideTab from './tabs/AiProductivityTrackerGuideTab.vue'

export interface TabMeta {
  key: string
  label: string
  order: number
}

export const tabs: TabMeta[] = [
  { key: 'workspace', label: '需求看板', order: 1 },
  { key: 'lessons', label: '复盘经验', order: 2 },
  { key: 'settings', label: '业务配置', order: 3 },
  { key: 'mcp-config', label: 'MCP 配置', order: 4 },
  { key: 'about', label: '工具说明', order: 5 },
  { key: 'guide', label: '使用说明', order: 6 }
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/workspace' },
  {
    path: '/workspace',
    name: 'workspace',
    component: AiProductivityTrackerWorkspaceTab,
    meta: { label: '需求看板' }
  },
  {
    path: '/lessons',
    name: 'lessons',
    component: AiProductivityTrackerLessonsTab,
    meta: { label: '复盘经验' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: AiProductivityTrackerSettingsTab,
    meta: { label: '业务配置' }
  },
  {
    path: '/mcp-config',
    name: 'mcp-config',
    component: AiProductivityTrackerMcpConfigTab,
    meta: { label: 'MCP 配置' }
  },
  {
    path: '/about',
    name: 'about',
    component: AiProductivityTrackerAboutTab,
    meta: { label: '工具说明' }
  },
  {
    path: '/guide',
    name: 'guide',
    component: AiProductivityTrackerGuideTab,
    meta: { label: '使用说明' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/workspace' }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
