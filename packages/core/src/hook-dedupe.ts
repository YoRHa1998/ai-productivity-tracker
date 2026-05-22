import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * agent 进程内 + 文件级持久化的 hook 去重 LRU。
 * 用途: Cursor / Claude hook 在同一对话 turn 偶发会触发多次(IDE 重连、用户手动复执
 * agent 等),用 `${conversation_id}#${generation_id}` 作为天然 dedupeKey 防止 token 重复累加。
 *
 * 存储位置: ~/.ai-productivity-tracker/data/hook-dedupe.json
 * 容量: LRU 200 条(覆盖任意单日的 hook 触发量,内存 + 磁盘开销均可忽略)
 */

export const DEFAULT_DEDUPE_PATH = join(
  homedir(),
  '.ai-productivity-tracker',
  'data',
  'hook-dedupe.json'
)
const DEFAULT_LRU_CAPACITY = 200

export interface DedupeEntry {
  key: string
  at: string
}

export interface DedupeState {
  version: number
  keys: DedupeEntry[]
}

export function emptyDedupeState(): DedupeState {
  return { version: 1, keys: [] }
}

export function loadDedupeState(filePath: string = DEFAULT_DEDUPE_PATH): DedupeState {
  if (!existsSync(filePath)) return emptyDedupeState()
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DedupeState>
    return {
      version: parsed.version ?? 1,
      keys: Array.isArray(parsed.keys)
        ? parsed.keys.filter(
            (e): e is DedupeEntry => typeof e?.key === 'string' && typeof e?.at === 'string'
          )
        : []
    }
  } catch {
    return emptyDedupeState()
  }
}

export function saveDedupeState(filePath: string, state: DedupeState): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, filePath)
}

export function hasDedupeKey(state: DedupeState, key: string): boolean {
  return state.keys.some((entry) => entry.key === key)
}

/**
 * 追加 key 到 LRU 末尾;若已存在则把它挪到末尾(刷新 lru),不重复累加。
 * 超过 capacity 时丢弃最早的条目。返回新 state(原 state 不可变)。
 */
export function appendDedupeKey(
  state: DedupeState,
  key: string,
  now: string,
  capacity: number = DEFAULT_LRU_CAPACITY
): DedupeState {
  const filtered = state.keys.filter((entry) => entry.key !== key)
  filtered.push({ key, at: now })
  while (filtered.length > capacity) filtered.shift()
  return { version: state.version || 1, keys: filtered }
}
