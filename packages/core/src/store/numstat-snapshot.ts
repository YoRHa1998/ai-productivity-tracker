import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureRequirementDir, requirementDir } from './paths.js'

export const NUMSTAT_SNAPSHOT_FILE = 'numstat-snapshot.json'

export interface NumstatPerFile {
  insertions: number
  deletions: number
}

export interface NumstatSnapshot {
  version: 1
  baseRef: string
  perFile: Record<string, NumstatPerFile>
  updatedAt: string
}

function snapshotPath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), NUMSTAT_SNAPSHOT_FILE)
}

/**
 * 读取上一轮 iteration 写入的 numstat 快照。
 * 不存在 / 解析失败 / 版本不匹配 / baseRef 不一致 (比如 init base commit 改了) -> 返回 null。
 *
 * 调用方在 baseRef 不匹配时应当视为「没有可用的上一轮快照」并把本轮当作首次。
 */
export function readNumstatSnapshot(
  jiraKey: string,
  expectedBaseRef: string,
  root?: string
): NumstatSnapshot | null {
  const file = snapshotPath(jiraKey, root)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<NumstatSnapshot>
    if (parsed?.version !== 1) return null
    if (typeof parsed.baseRef !== 'string') return null
    if (parsed.baseRef !== expectedBaseRef) return null
    if (!parsed.perFile || typeof parsed.perFile !== 'object') return null
    return {
      version: 1,
      baseRef: parsed.baseRef,
      perFile: parsed.perFile as Record<string, NumstatPerFile>,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return null
  }
}

/**
 * 原子写入本轮 iteration 采集的 numstat 快照, 供下一轮做减法。
 */
export function writeNumstatSnapshot(
  jiraKey: string,
  snapshot: NumstatSnapshot,
  root?: string
): void {
  ensureRequirementDir(jiraKey, root)
  const file = snapshotPath(jiraKey, root)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

/**
 * Map<path,{ins,del}> -> Record<path,{ins,del}>。numstat-snapshot 用 Record 存
 * 是为了 JSON 序列化天然支持; iteration-extras 内部用 Map 减少查表。
 */
export function numstatMapToRecord(
  map: Map<string, NumstatPerFile>
): Record<string, NumstatPerFile> {
  const out: Record<string, NumstatPerFile> = {}
  for (const [k, v] of map.entries()) out[k] = { insertions: v.insertions, deletions: v.deletions }
  return out
}
