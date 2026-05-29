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
  /**
   * 进入终态(`finished` / `abandoned`)的定格时刻 ISO。`null` = 仍在进行中(`in_progress`)
   * 或老数据未记录。
   *
   * 语义:需求一旦标记完成 / 放弃,墙钟耗时与 boost 等指标应**定格**在这一刻,不再随后续
   * 自动上报(retrospective / attach_summary 触发的新 iteration)继续膨胀。`buildSummaryView`
   * 在 status 终态且本字段存在时,只用 `reportedAt <= finishedAt` 的 iteration 计算指标。
   *
   * 由 `updateRequirement` 在状态切换时自动戳记:进入终态记 now、回到 `in_progress` 清空;
   * 重复点「已完成」不会刷新已有定格点。老数据缺该字段时 load 后为 `null`,行为与历史一致
   * (不定格),用户重新切一次状态即可补戳。
   */
  finishedAt: string | null
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
  /**
   * 需求级 wThink 覆盖值 ∈ [0, 1],null 表示跟随全局 `formula.json`。
   *
   * 语义采用 **snapshot-on-init**:`ai_productivity_init` 创建需求时,daemon 会把
   * 当下全局 `formula.json` 的 `wThink` 整体快照写入本字段;之后用户在「设置 → 提效公式」
   * 改全局,不再回写本字段 → 已有需求 boost 不受全局变更影响,只能在需求详情页单独编辑。
   *
   * 老 requirement.json(rc.26 之前)缺该字段时 load 后为 null,`buildSummaryView`
   * 兜底回退到全局 `wThink`;用户首次在详情页编辑后即固化为具体数值。
   */
  formulaWThinkOverride: number | null
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
    finishedAt: null,
    linkedBugCount: 0,
    linkedBugJql: '',
    bugsRefreshedAt: null,
    clarifyReportPath: '',
    clarifyReviewerScore: null,
    clarifyConflicts: [],
    startedAt: now,
    createdAt: now,
    updatedAt: now,
    initBaseCommit: '',
    formulaWThinkOverride: null
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

function isTerminalStatus(status: RequirementStatus): boolean {
  return status === 'finished' || status === 'abandoned'
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

  // finishedAt 自动戳记:状态切换时定格 / 清空墙钟。调用方显式传 patch.finishedAt 时尊重其值
  // (用于历史数据修复回填),否则按状态机推导:
  //   - 进入终态(finished/abandoned)且此前不是「已带定格点的终态」→ 记 now
  //   - 回到 in_progress → 清空(重新开始计时)
  if (!('finishedAt' in patch) && 'status' in patch && patch.status) {
    if (isTerminalStatus(patch.status)) {
      const alreadyFrozen = isTerminalStatus(existing.status) && Boolean(existing.finishedAt)
      if (!alreadyFrozen) next.finishedAt = now
    } else {
      next.finishedAt = null
    }
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
