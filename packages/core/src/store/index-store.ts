import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { ensureRoot, indexPath } from './paths.js'

export interface IndexEntry {
  jiraKey: string
  title: string
  status: string
  /** init 时绑定的项目根(gitRoot),便于看板上反向打开 */
  repoPath: string
  /** init 落库时间 */
  startedAt: string
  /** 最近一次写入 (requirement 或 iteration 触发) */
  updatedAt: string
  iterationCount: number
  latestIterationAt: string | null
}

export interface IndexFile {
  version: number
  items: Record<string, IndexEntry>
}

export type IndexPatch = Partial<Omit<IndexEntry, 'jiraKey'>>

function emptyIndex(): IndexFile {
  return { version: 1, items: {} }
}

export function readIndex(root?: string): IndexFile {
  const file = indexPath(root)
  if (!existsSync(file)) return emptyIndex()
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<IndexFile>
    return {
      version: parsed.version ?? 1,
      items: parsed.items ?? {}
    }
  } catch {
    return emptyIndex()
  }
}

function writeIndexAtomic(file: string, data: IndexFile): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function upsertIndexEntry(jiraKey: string, patch: IndexPatch, root?: string): IndexEntry {
  if (!jiraKey) throw new Error('jiraKey 不能为空')
  ensureRoot(root)
  const file = indexPath(root)
  const current = readIndex(root)
  const existing = current.items[jiraKey]
  const now = new Date().toISOString()

  const entry: IndexEntry = {
    jiraKey,
    title: patch.title ?? existing?.title ?? '',
    status: patch.status ?? existing?.status ?? 'in_progress',
    repoPath: patch.repoPath ?? existing?.repoPath ?? '',
    startedAt: patch.startedAt ?? existing?.startedAt ?? now,
    updatedAt: patch.updatedAt ?? now,
    iterationCount: patch.iterationCount ?? existing?.iterationCount ?? 0,
    latestIterationAt: patch.latestIterationAt ?? existing?.latestIterationAt ?? null
  }

  const next: IndexFile = {
    version: 1,
    items: { ...current.items, [jiraKey]: entry }
  }
  writeIndexAtomic(file, next)
  return entry
}

export function removeIndexEntry(jiraKey: string, root?: string): boolean {
  const file = indexPath(root)
  const current = readIndex(root)
  if (!current.items[jiraKey]) return false
  const { [jiraKey]: _drop, ...rest } = current.items
  writeIndexAtomic(file, { version: 1, items: rest })
  return true
}

export function listIndexEntries(root?: string): IndexEntry[] {
  const idx = readIndex(root)
  return Object.values(idx.items).sort((a, b) => {
    const ta = a.updatedAt || ''
    const tb = b.updatedAt || ''
    if (ta === tb) return 0
    return ta < tb ? 1 : -1
  })
}
