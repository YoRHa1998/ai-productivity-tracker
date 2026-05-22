/**
 * `aipt hook`:Cursor afterAgentResponse / Claude PostMessage 钩子入口。
 *
 * 设计:fail-open——daemon 不在 / 网络异常都不阻塞 IDE,只把上报失败记到 stderr。
 * 不会 spawn daemon(hook 每轮调用太频繁,启动 daemon 有冷启动代价)。
 */

import { runHook } from '@ai-productivity-tracker/hook-core'

export async function runHookCommand(): Promise<number> {
  try {
    await runHook()
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ai-productivity-tracker] hook 异常(fail-open):${msg}`)
    return 0
  }
}
