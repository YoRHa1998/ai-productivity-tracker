/**
 * 端口选择策略(PRD §3.7):
 *
 * 1. 优先用 preferred(通常是 runtime.json 上次记录的 port)
 * 2. preferred 占用 → 从 17350 起递增扫描最多 20 个
 * 3. 都占 → 抛错让用户处理
 *
 * 端口探测用 net.createServer().listen() 试占,成功立即关闭并返回。
 */

import { createServer } from 'node:net'

export const DEFAULT_PORT = 17350
export const MAX_PORT_SCAN = 20

export async function pickAvailablePort(preferred?: number): Promise<number> {
  const start = preferred ?? DEFAULT_PORT
  for (let offset = 0; offset < MAX_PORT_SCAN; offset++) {
    const candidate = start + offset
    if (await isPortAvailable(candidate)) return candidate
  }
  // 第二轮:若 preferred 不是 DEFAULT_PORT,从 DEFAULT_PORT 起再扫一次
  if (preferred && preferred !== DEFAULT_PORT) {
    for (let offset = 0; offset < MAX_PORT_SCAN; offset++) {
      const candidate = DEFAULT_PORT + offset
      if (await isPortAvailable(candidate)) return candidate
    }
  }
  throw new Error(
    `无法在 ${start}..${start + MAX_PORT_SCAN - 1} 找到可用端口。请检查是否有端口被独占,或在 ~/.ai-productivity-tracker/config.json 中显式锁定 port。`
  )
}

export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => {
      srv.close(() => resolve(true))
    })
  })
}
