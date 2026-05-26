import { computed, onMounted, ref } from 'vue'

import { listRequirements, type RequirementSummary } from '../api'
import { fetchCurrentSession } from '../lib/session'

/**
 * useActiveBinding — 取最近活跃的需求(看板顶栏「当前上下文徽章」用)。
 *
 * daemon 现有 API:
 *   GET /ai-productivity/requirements?owner=<>&status=in_progress 列出所有需求
 *
 * 启发式策略:
 *   1. 取当前 owner(从 session)
 *   2. 拉取 status=in_progress 的需求列表,按 `latestIterationAt` 倒序取第一条
 *   3. 列表为空 → null,UI 渲染"未绑定需求"
 *
 * 单例 ref,所有调用方共享同一份状态;refresh() 可手动重拉。
 * 不轮询(顶栏徽章变化频率低,刷新页面或点 refresh 即可)。
 */

interface ActiveBindingState {
  loading: boolean
  current: RequirementSummary | null
  error: string | null
}

const state = ref<ActiveBindingState>({
  loading: false,
  current: null,
  error: null
})

let initialized = false

async function doFetch() {
  state.value.loading = true
  state.value.error = null
  try {
    const session = await fetchCurrentSession().catch(() => null)
    const owner = session?.name?.trim() || undefined
    const list = await listRequirements({
      owner,
      status: 'in_progress'
    })
    if (!list.length) {
      state.value.current = null
      return
    }
    const sorted = [...list].sort((a, b) => {
      const ta = a.latestIterationAt ? Date.parse(a.latestIterationAt) : 0
      const tb = b.latestIterationAt ? Date.parse(b.latestIterationAt) : 0
      return tb - ta
    })
    state.value.current = sorted[0] ?? null
  } catch (err) {
    state.value.error = err instanceof Error ? err.message : String(err)
    state.value.current = null
  } finally {
    state.value.loading = false
  }
}

export function useActiveBinding() {
  onMounted(() => {
    if (!initialized) {
      initialized = true
      void doFetch()
    }
  })

  const jiraKey = computed(() => state.value.current?.jiraKey ?? null)
  const title = computed(() => state.value.current?.title ?? null)
  const projectSlug = computed(() => state.value.current?.projectSlug ?? null)

  return {
    state,
    jiraKey,
    title,
    projectSlug,
    refresh: doFetch
  }
}
