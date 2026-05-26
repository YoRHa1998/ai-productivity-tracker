import { onUnmounted, ref, watch, type Ref } from 'vue'

/**
 * useNumberFlow — 让数字从 0 平滑滚动到目标值。
 *
 * 用法:
 *   const totalReq = computed(() => summary.value?.totalRequirements ?? 0)
 *   const displayed = useNumberFlow(totalReq, { duration: 1200 })
 *   // template: {{ Math.round(displayed) }}
 *
 * 特点:
 * - 纯 rAF 实现,无外部依赖,~50 行
 * - 缓动:easeOutCubic,先快后慢
 * - 兼容 number / null / undefined,空值显示 0
 * - prefers-reduced-motion 用户直接显示目标值
 */
export interface NumberFlowOptions {
  /** 动画时长 ms,默认 1000 */
  duration?: number
  /** 起始值,默认 0 */
  initial?: number
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useNumberFlow(
  source: Ref<number | null | undefined>,
  options: NumberFlowOptions = {}
): Ref<number> {
  const { duration = 1000, initial = 0 } = options
  const displayed = ref<number>(initial)
  let rafId: number | null = null
  let startTime = 0
  let fromValue = initial

  function cancel() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  function tick(target: number) {
    const now = performance.now()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = easeOutCubic(t)
    displayed.value = fromValue + (target - fromValue) * eased
    if (t < 1) {
      rafId = requestAnimationFrame(() => tick(target))
    } else {
      displayed.value = target
      rafId = null
    }
  }

  watch(
    source,
    (next) => {
      const target = typeof next === 'number' && Number.isFinite(next) ? next : 0
      if (prefersReducedMotion()) {
        displayed.value = target
        return
      }
      cancel()
      fromValue = displayed.value
      if (Math.abs(target - fromValue) < 0.5) {
        displayed.value = target
        return
      }
      startTime = performance.now()
      rafId = requestAnimationFrame(() => tick(target))
    },
    { immediate: true }
  )

  onUnmounted(cancel)

  return displayed
}
