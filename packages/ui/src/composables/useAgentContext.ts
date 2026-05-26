import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  fetchCursorHookStatus,
  fetchTrackSkillStatus,
  fetchWatcherStatus,
  probeAgent,
  type AgentStatus,
  type CursorHookStatus,
  type TrackSkillStatus,
  type WatcherStatus
} from '../api'

/**
 * useAgentContext — 顶栏要展示的 daemon / hook / skill 三个状态合并 + 30s 自动轮询。
 *
 * 设计原则:
 * - 单例 ref(模块级),无论被多少组件调用都只发起一份轮询
 * - 启动时立刻 probe 一次,之后每 30s 触发一次轻量刷新
 * - daemon 离线时,后续的 hook/skill 拉取直接跳过(daemon 不通就不可能有数据)
 * - 暴露 `refresh()` 给主动按钮(顶栏 reload 图标)
 * - 暴露 3 个语义状态点 `daemonDot / hookDot / skillDot`(ok / warn / muted)给 UI
 */

interface AgentContextState {
  agent: AgentStatus
  cursorHook: CursorHookStatus | null
  trackSkill: TrackSkillStatus | null
  watcher: WatcherStatus | null
  loading: boolean
  lastUpdatedAt: number | null
}

const REFRESH_INTERVAL_MS = 30_000

const state = ref<AgentContextState>({
  agent: { ok: false },
  cursorHook: null,
  trackSkill: null,
  watcher: null,
  loading: false,
  lastUpdatedAt: null
})

let refCount = 0
let timer: ReturnType<typeof setInterval> | null = null
let inflight: Promise<void> | null = null

async function doRefresh(silent = false): Promise<void> {
  if (inflight) return inflight
  if (!silent) state.value.loading = true
  inflight = (async () => {
    try {
      const agent = await probeAgent()
      state.value.agent = agent
      if (!agent.ok) {
        state.value.cursorHook = null
        state.value.trackSkill = null
        state.value.watcher = null
        return
      }
      const [hookRes, skillRes, watcherRes] = await Promise.allSettled([
        fetchCursorHookStatus(),
        fetchTrackSkillStatus(),
        fetchWatcherStatus()
      ])
      state.value.cursorHook = hookRes.status === 'fulfilled' ? hookRes.value : null
      state.value.trackSkill = skillRes.status === 'fulfilled' ? skillRes.value : null
      state.value.watcher = watcherRes.status === 'fulfilled' ? watcherRes.value : null
    } finally {
      state.value.lastUpdatedAt = Date.now()
      if (!silent) state.value.loading = false
      inflight = null
    }
  })()
  return inflight
}

function startTimer() {
  if (timer) return
  timer = setInterval(() => {
    void doRefresh(true)
  }, REFRESH_INTERVAL_MS)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export type DotState = 'ok' | 'warn' | 'danger' | 'muted'

export function useAgentContext() {
  onMounted(() => {
    refCount += 1
    if (refCount === 1) {
      void doRefresh(false)
      startTimer()
    }
  })

  onUnmounted(() => {
    refCount -= 1
    if (refCount <= 0) {
      refCount = 0
      stopTimer()
    }
  })

  const daemonDot = computed<DotState>(() => (state.value.agent.ok ? 'ok' : 'danger'))

  const hookDot = computed<DotState>(() => {
    const hook = state.value.cursorHook
    if (!state.value.agent.ok) return 'muted'
    if (!hook) return 'muted'
    if (!hook.hookInstalled) return 'warn'
    if (hook.legacyHookDetected) return 'warn'
    return 'ok'
  })

  const skillDot = computed<DotState>(() => {
    const sk = state.value.trackSkill
    if (!state.value.agent.ok) return 'muted'
    if (!sk) return 'muted'
    const partsInstalled = [
      sk.claude?.installed,
      sk.cursor?.installed,
      sk.claude?.hook?.installed,
      sk.cursor?.hook?.stopCheckInstalled
    ].filter(Boolean).length
    if (partsInstalled === 0) return 'warn'
    if (partsInstalled < 4) return 'warn'
    return 'ok'
  })

  const watcherDot = computed<DotState>(() => {
    if (!state.value.agent.ok) return 'muted'
    const w = state.value.watcher
    if (!w) return 'muted'
    return w.running ? 'ok' : 'warn'
  })

  return {
    state,
    daemonDot,
    hookDot,
    skillDot,
    watcherDot,
    refresh: () => doRefresh(false)
  }
}
