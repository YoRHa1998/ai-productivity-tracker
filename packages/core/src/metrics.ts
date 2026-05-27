import type { FormulaSettings } from './store/formula-store.js'
import type { StoredIteration } from './store/iteration-store.js'
import type { StoredRequirement, StoredSubtask } from './store/requirement-store.js'

export interface RequirementMetrics {
  codingRuns: number
  boost: number | null
  completion: number
  latestCumulativeToken: number
  latestElapsedMinutes: number
  /**
   * 各 iteration `thinkSeconds`(本轮 wall time:用户提交 → AI 答完)的累加值。
   * 与 `latestElapsedMinutes`(任务从开始到现在的墙钟耗时,含用户离开/阅读的空闲)区分:
   * 这个值只累计 AI 实际参与的 turn 时长,反映「AI 纯思考时间」。
   */
  totalThinkSeconds: number
  /**
   * 公式分母里的「加权耗时(分钟)」= wElapsed × latestElapsedMinutes + wThink × (totalThinkSeconds / 60)。
   * 在 UI 上直接展示这个数,让用户一眼看清 boost = manualEstimateMinutes / effectiveMinutes(× tokenPenalty)。
   */
  effectiveMinutes: number
  /**
   * 当前公式下 token 软上限带来的惩罚倍数:
   * - `tokenPenaltyEnabled=false` 或 `tokenSoftCapK<=0` 时恒为 1
   * - 否则 = 1 + max(0, tokens/1000 - cap) / cap,超过软上限部分按比例线性放大分母
   */
  tokenPenalty: number
}

export function computeCompletion(subtasks: StoredSubtask[]): number {
  if (!subtasks.length) return 0
  const totalWeight = subtasks.reduce((sum, item) => sum + (item.weight ?? 1), 0)
  if (totalWeight <= 0) return 0
  const doneWeight = subtasks
    .filter((item) => item.done)
    .reduce((sum, item) => sum + (item.weight ?? 1), 0)
  return Number((doneWeight / totalWeight).toFixed(4))
}

export function computeMetrics(params: {
  manualEstimateMinutes: number
  iterations: StoredIteration[]
  subtasks: StoredSubtask[]
  /** 仅作为列表/详情展示用,不再参与 boost 公式(v1.0.0-rc.22 起 Bug 惩罚被移除) */
  linkedBugCount: number
  formula: FormulaSettings
}): RequirementMetrics {
  const latest = params.iterations[params.iterations.length - 1]
  const latestToken = latest?.cumulativeToken ?? 0
  const latestElapsed = latest?.elapsedMinutes ?? 0
  const codingRuns = params.iterations.filter(
    (it) => it.kind === 'coding' || it.kind === 'first_coding'
  ).length
  const totalThinkSeconds = params.iterations.reduce(
    (sum, it) => sum + (typeof it.thinkSeconds === 'number' ? it.thinkSeconds : 0),
    0
  )

  const wThink = clamp01(params.formula.wThink)
  const wElapsed = 1 - wThink
  const thinkMinutes = totalThinkSeconds / 60
  const effectiveMinutes = wElapsed * latestElapsed + wThink * thinkMinutes

  const tokenPenalty =
    params.formula.tokenPenaltyEnabled && params.formula.tokenSoftCapK > 0
      ? 1 +
        Math.max(0, latestToken / 1000 - params.formula.tokenSoftCapK) /
          params.formula.tokenSoftCapK
      : 1

  let boost: number | null = null
  if (effectiveMinutes > 0 && params.manualEstimateMinutes > 0 && tokenPenalty > 0) {
    boost = Number((params.manualEstimateMinutes / (effectiveMinutes * tokenPenalty)).toFixed(2))
  }

  return {
    codingRuns,
    boost,
    completion: computeCompletion(params.subtasks),
    latestCumulativeToken: latestToken,
    latestElapsedMinutes: latestElapsed,
    totalThinkSeconds,
    effectiveMinutes: Number(effectiveMinutes.toFixed(2)),
    tokenPenalty: Number(tokenPenalty.toFixed(4))
  }
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export interface SummaryMetrics {
  totalRequirements: number
  inProgressCount: number
  finishedCount: number
  averageBoost: number | null
  totalBugCount: number
  totalToken: number
}

export interface RequirementSummaryView {
  jiraKey: string
  jiraUrl: string
  title: string
  summary: string
  complexity: string
  manualEstimateMinutes: number
  subtasks: StoredSubtask[]
  affectedPaths: string[]
  owner: string
  projectSlug: string
  status: string
  linkedBugCount: number
  linkedBugJql: string
  bugsRefreshedAt: string | null
  startedAt: string
  createdAt: string
  updatedAt: string
  clarifyReportPath: string
  clarifyReviewerScore: number | null
  clarifyConflicts: StoredRequirement['clarifyConflicts']
  metrics: RequirementMetrics
  iterationCount: number
  latestIterationAt: string | null
}

export function buildSummaryView(
  requirement: StoredRequirement,
  iterations: StoredIteration[],
  formula: FormulaSettings
): RequirementSummaryView {
  const subtasks = Array.isArray(requirement.subtasks) ? requirement.subtasks : []
  const metrics = computeMetrics({
    manualEstimateMinutes: requirement.manualEstimateMinutes,
    iterations,
    subtasks,
    linkedBugCount: requirement.linkedBugCount,
    formula
  })

  return {
    jiraKey: requirement.jiraKey,
    jiraUrl: requirement.jiraUrl ?? '',
    title: requirement.title,
    summary: requirement.summary,
    complexity: requirement.complexity,
    manualEstimateMinutes: requirement.manualEstimateMinutes,
    subtasks,
    affectedPaths: Array.isArray(requirement.affectedPaths) ? requirement.affectedPaths : [],
    owner: requirement.owner,
    projectSlug: requirement.projectSlug,
    status: requirement.status,
    linkedBugCount: requirement.linkedBugCount,
    linkedBugJql: requirement.linkedBugJql,
    bugsRefreshedAt: requirement.bugsRefreshedAt,
    startedAt: requirement.startedAt,
    createdAt: requirement.createdAt,
    updatedAt: requirement.updatedAt,
    clarifyReportPath: requirement.clarifyReportPath ?? '',
    clarifyReviewerScore: requirement.clarifyReviewerScore ?? null,
    clarifyConflicts: Array.isArray(requirement.clarifyConflicts)
      ? requirement.clarifyConflicts
      : [],
    metrics,
    iterationCount: iterations.length,
    latestIterationAt: iterations.length ? iterations[iterations.length - 1].reportedAt : null
  }
}

export function buildOverallSummary(views: RequirementSummaryView[]): SummaryMetrics {
  const boosts = views.map((v) => v.metrics.boost).filter((b): b is number => b != null)
  return {
    totalRequirements: views.length,
    inProgressCount: views.filter((v) => v.status === 'in_progress').length,
    finishedCount: views.filter((v) => v.status === 'finished').length,
    averageBoost: boosts.length
      ? Number((boosts.reduce((s, b) => s + b, 0) / boosts.length).toFixed(2))
      : null,
    totalBugCount: views.reduce((sum, v) => sum + v.linkedBugCount, 0),
    totalToken: views.reduce((sum, v) => sum + v.metrics.latestCumulativeToken, 0)
  }
}
