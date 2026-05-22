import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { ensureRequirementDir, requirementFilePath } from './paths.js'
import { listIndexEntries, upsertIndexEntry } from './index-store.js'

export type Complexity = 'low' | 'medium' | 'high'
export type RequirementStatus = 'in_progress' | 'finished' | 'abandoned'

export interface StoredSubtask {
  id: string
  title: string
  weight: number
  done: boolean
  doneAt?: string | null
}

export interface StoredClarifyConflict {
  title: string
  jiraText: string
  codeFact: string
  type: 'partial' | 'mismatch' | 'unknown'
  impact: string
  pmSpeech: string
}

export interface StoredRequirement {
  jiraKey: string
  jiraUrl: string
  title: string
  summary: string
  complexity: Complexity
  manualEstimateMinutes: number
  subtasks: StoredSubtask[]
  affectedPaths: string[]
  owner: string
  projectSlug: string
  status: RequirementStatus
  linkedBugCount: number
  linkedBugJql: string
  bugsRefreshedAt: string | null
  clarifyReportPath: string
  clarifyReviewerScore: number | null
  clarifyConflicts: StoredClarifyConflict[]
  startedAt: string
  createdAt: string
  updatedAt: string
  /**
   * init 时记录的 git HEAD sha。后续 iteration 在采集 diff 时以此为 baseRef,
   * 用来区分「需求开始以来的累计变更」和「自上一轮 iteration 以来的本次变更」。
   * 空串表示无 HEAD (裸仓库 / 首次提交前 / 非 git) -> 退化使用 'HEAD'。
   */
  initBaseCommit: string
}

export type CreateRequirementInput = Partial<StoredRequirement> & {
  jiraKey: string
  title: string
}

export type UpdateRequirementPatch = Partial<Omit<StoredRequirement, 'jiraKey' | 'createdAt'>>

function defaultRequirement(jiraKey: string, title: string, now: string): StoredRequirement {
  return {
    jiraKey,
    jiraUrl: '',
    title,
    summary: '',
    complexity: 'medium',
    manualEstimateMinutes: 0,
    subtasks: [],
    affectedPaths: [],
    owner: '',
    projectSlug: '',
    status: 'in_progress',
    linkedBugCount: 0,
    linkedBugJql: '',
    bugsRefreshedAt: null,
    clarifyReportPath: '',
    clarifyReviewerScore: null,
    clarifyConflicts: [],
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    initBaseCommit: ''
  }
}

function writeAtomic(file: string, data: StoredRequirement): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, file)
}

export function loadRequirement(jiraKey: string, root?: string): StoredRequirement | null {
  const file = requirementFilePath(jiraKey, root)
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoredRequirement>
    // 老数据兼容: initBaseCommit 等新字段缺省时补空串, 避免下游 undefined 检查
    return {
      ...defaultRequirement(
        parsed.jiraKey ?? jiraKey,
        parsed.title ?? jiraKey,
        parsed.createdAt ?? ''
      ),
      ...parsed
    } as StoredRequirement
  } catch {
    return null
  }
}

/**
 * 写入需求 (覆盖式). 缺省字段沿用 default;同时同步 index.json 中标题/状态/更新时间。
 */
export function saveRequirement(
  input: CreateRequirementInput,
  options: { repoPath?: string; root?: string } = {}
): StoredRequirement {
  const now = new Date().toISOString()
  ensureRequirementDir(input.jiraKey, options.root)

  const existing = loadRequirement(input.jiraKey, options.root)
  const base = existing ?? defaultRequirement(input.jiraKey, input.title, now)

  const next: StoredRequirement = {
    ...base,
    ...input,
    jiraKey: input.jiraKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }

  const file = requirementFilePath(input.jiraKey, options.root)
  writeAtomic(file, next)

  upsertIndexEntry(
    input.jiraKey,
    {
      title: next.title,
      status: next.status,
      startedAt: next.startedAt,
      updatedAt: now,
      repoPath: options.repoPath
    },
    options.root
  )

  return next
}

export function updateRequirement(
  jiraKey: string,
  patch: UpdateRequirementPatch,
  root?: string
): StoredRequirement {
  const existing = loadRequirement(jiraKey, root)
  if (!existing) throw new Error(`requirement ${jiraKey} 未找到`)
  const now = new Date().toISOString()
  const next: StoredRequirement = {
    ...existing,
    ...patch,
    jiraKey,
    createdAt: existing.createdAt,
    updatedAt: now
  }
  const file = requirementFilePath(jiraKey, root)
  writeAtomic(file, next)
  upsertIndexEntry(
    jiraKey,
    {
      title: next.title,
      status: next.status,
      startedAt: next.startedAt,
      updatedAt: now
    },
    root
  )
  return next
}

/** 按 index.json 顺序枚举所有有效 requirement.json */
export function listRequirementsFromStore(root?: string): StoredRequirement[] {
  const entries = listIndexEntries(root)
  const out: StoredRequirement[] = []
  for (const entry of entries) {
    const req = loadRequirement(entry.jiraKey, root)
    if (req) out.push(req)
  }
  return out
}
