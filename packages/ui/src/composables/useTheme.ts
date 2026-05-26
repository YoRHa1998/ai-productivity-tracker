import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

/**
 * useTheme — 主题切换 composable。
 *
 * 三态:`dark` / `light` / `auto`(跟随系统 prefers-color-scheme)。
 * 持久化:localStorage('aipt:theme'),首次启动默认 `auto`。
 * 应用方式:在 <html> 上写 `data-theme` 属性,tokens.css 用属性选择器切换设计变量。
 *
 * 暴露:
 *   theme              — 当前用户设置(包含 auto)
 *   resolvedTheme      — 当前实际生效的主题(dark / light,auto 时自动解析)
 *   setTheme(t)        — 切换设置
 *   cycleTheme()       — 在 dark → light → auto 之间循环(给顶栏按钮用)
 */

export type ThemeChoice = 'dark' | 'light' | 'auto'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'aipt:theme'

function readStoredTheme(): ThemeChoice {
  if (typeof localStorage === 'undefined') return 'auto'
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'dark' || v === 'light' || v === 'auto') return v
  return 'auto'
}

function detectSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 模块级单例(避免多个组件 import 出现状态不一致) */
const theme = ref<ThemeChoice>('auto')
const systemTheme = ref<ResolvedTheme>('dark')
let initialized = false
let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
}

function ensureInit() {
  if (initialized) return
  initialized = true
  theme.value = readStoredTheme()
  systemTheme.value = detectSystemTheme()
  if (typeof window !== 'undefined' && window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaListener = (e: MediaQueryListEvent) => {
      systemTheme.value = e.matches ? 'dark' : 'light'
    }
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', mediaListener)
    } else {
      // 兼容老 Safari API
      ;(mediaQuery as unknown as { addListener: (cb: typeof mediaListener) => void }).addListener(
        mediaListener
      )
    }
  }
}

export function useTheme() {
  ensureInit()

  const resolvedTheme = computed<ResolvedTheme>(() =>
    theme.value === 'auto' ? systemTheme.value : theme.value
  )

  function setTheme(next: ThemeChoice) {
    theme.value = next
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, next)
    }
  }

  function cycleTheme() {
    const next: ThemeChoice =
      theme.value === 'dark' ? 'light' : theme.value === 'light' ? 'auto' : 'dark'
    setTheme(next)
  }

  // 同步到 <html data-theme>
  watch(resolvedTheme, (next) => applyTheme(next), { immediate: true })

  onMounted(() => {
    applyTheme(resolvedTheme.value)
  })

  onUnmounted(() => {
    // 单例 listener 不在卸载时清理,允许多组件复用;模块卸载时浏览器自然回收
  })

  return {
    theme,
    resolvedTheme,
    setTheme,
    cycleTheme
  }
}
