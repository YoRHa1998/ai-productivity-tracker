/**
 * `aipt stop-check`:Cursor stop / Claude Code Stop 防伪造校验。
 *
 * 委托给 hook-core runStopCheckCli,该函数负责 stdin → 解析 jiraKey → 读 sentinel →
 * 输出 `decision:block + followup_message` 或放行。
 */

import { runStopCheckCli } from '@ai-productivity-tracker/hook-core'

export async function runStopCheckCommand(): Promise<number> {
  try {
    await runStopCheckCli()
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ai-productivity-tracker] stop-check 异常(fail-open):${msg}`)
    return 0
  }
}
