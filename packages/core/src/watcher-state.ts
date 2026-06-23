import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface WatcherFileState {
  offset: number
  mtimeMs: number
  /** 上次观察到的文件大小;旧 state 缺失为 undefined,首扫自动补齐 */
  size?: number
  /** 文件 inode;旧 state 缺失为 undefined。Windows 上可能为 0/不稳定,作兜底处理 */
  ino?: number
}

export interface WatcherState {
  version: number
  files: Record<string, WatcherFileState>
}

/**
 * 断点续采判定的最小输入:既有游标 + 当前 fs.Stats 关键字段。
 */
export interface IncrementalReadStats {
  size: number
  mtimeMs: number
  ino: number
}

export interface IncrementalReadDecision {
  /** true 表示文件未变化,跳过本次读取 */
  skip: boolean
  /** 本次从哪个 offset 开始增量读(skip=true 时无意义) */
  startOffset: number
}

/**
 * 统一的会话文件断点续采判定(Claude / Codex 两个 watcher 共用)。
 *
 * 借鉴 LoongSuite Pilot StateStore 的 offset+size+ino 游标思路,显式识别:
 * 1. inode 变化(轮转/替换)→ 从头读(offset=0)
 * 2. 截断(size < offset)→ 从头读
 * 3. 未变(offset===size && ino 一致 && mtime 一致)→ skip
 *
 * Windows / 异常兜底:`ino` 为 0/falsy(prev 缺失或 stats 拿不到)时不参与重置与跳过判定,
 * 退回旧的「offset+mtime」逻辑,保证不因 ino 不稳定误重置或误跳过。
 */
export function decideIncrementalRead(
  prev: WatcherFileState | undefined,
  stats: IncrementalReadStats
): IncrementalReadDecision {
  // ino 是否可用于比对:prev 与 stats 都拿到非 0 的 inode 才算可用
  const inoUsable = Boolean(prev?.ino) && Boolean(stats.ino)

  // 1) inode 变化:同名文件被轮转/替换 → 从头读
  if (inoUsable && prev!.ino !== stats.ino) {
    return { skip: false, startOffset: 0 }
  }

  // 2) 截断:size 小于已读 offset → 从头读,避免越界/错位
  if (prev && stats.size < prev.offset) {
    return { skip: false, startOffset: 0 }
  }

  // 3) 未变:offset 到底 + (ino 不可用 或 ino 一致) + mtime 一致 → skip
  if (prev && prev.offset === stats.size && prev.mtimeMs === stats.mtimeMs) {
    return { skip: true, startOffset: prev.offset }
  }

  // 其余:从既有 offset(或 0)续读
  return { skip: false, startOffset: prev?.offset ?? 0 }
}

const DEFAULT_STATE: WatcherState = { version: 1, files: {} }

export function loadWatcherState(statePath: string): WatcherState {
  if (!existsSync(statePath)) return { ...DEFAULT_STATE, files: {} }
  try {
    const raw = readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WatcherState>
    return {
      version: parsed.version ?? 1,
      files: parsed.files ?? {}
    }
  } catch {
    return { ...DEFAULT_STATE, files: {} }
  }
}

export function saveWatcherState(statePath: string, state: WatcherState): void {
  const dir = dirname(statePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${statePath}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, statePath)
}
