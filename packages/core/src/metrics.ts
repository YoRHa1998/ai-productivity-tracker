import type { FormulaSettings } from './store/formula-store.js'
import type { StoredIteration } from './store/iteration-store.js'
import type { StoredRequirement, StoredSubtask } from './store/requirement-store.js'

export interface RequirementMetrics {
  codingRuns: number
  boost: number | null
  completion: number
  latestCumulativeToken: number
  latestElapsedMinutes: number
  bugPenalty: number
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
  linkedBugCount: number
  formula: FormulaSettings
}): RequirementMetrics {
  const latest = params.iterations[params.iterations.length - 1]
  const latestToken = latest?.cumulativeToken ?? 0
  const latestElapsed = latest?.elapsedMinutes ?? 0
  const codingRuns = params.iterations.filter(
    (it) => it.kind === 'coding' || it.kind === 'first_coding'
  ).length

  const bugPenalty = 1 + params.linkedBugCount * params.formula.kBug

  const tokenCostUsd = (latestToken / 1000) * params.formula.tokenPriceUsdPer1k
  const costMinutes =
    params.formula.hourlyCostUsd > 0 ? (tokenCostUsd / params.formula.hourlyCostUsd) * 60 : 0
  const tokenPenalty = 1 + costMinutes * params.formula.kToken

  let boost: number | null = null
  if (latestElapsed > 0 && params.manualEstimateMinutes > 0) {
    boost = Number(
      (params.manualEstimateMinutes / (latestElapsed * bugPenalty * tokenPenalty)).toFixed(2)
    )
  }

  return {
    codingRuns,
    boost,
    completion: computeCompletion(params.subtasks),
    latestCumulativeToken: latestToken,
    latestElapsedMinutes: latestElapsed,
    bugPenalty: Number(bugPenalty.toFixed(4)),
    tokenPenalty: Number(tokenPenalty.toFixed(4))
  }
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
