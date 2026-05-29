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
   * 各 iteration `thinkSeconds`(本轮 wall time:用户提交 prompt → AI 输出结束,含同轮内
   * 给方案 / 改代码 / review 审批时间)的累加值。
   * 与 `latestElapsedMinutes`(任务从开始到现在的墙钟耗时,含跨轮离开/阅读空闲)区分:
   * 这个值只累计 AI 实际参与的单轮 wall time 之和。
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
  /**
   * 需求进入终态(`finished` / `abandoned`)的定格时刻,原样回传(`null` = 进行中或老数据未记录)。
   * 非空时表示 `metrics` 已按「只算 `reportedAt <= finishedAt` 的 iteration」定格,墙钟 / boost
   * 不再随后续自动上报膨胀;前端可据此渲染「已定格」标记。
   */
  finishedAt: string | null
  /**
   * 需求级 wThink 覆盖值原样回传(null = 未覆盖,跟随全局)。前端用来在「提效公式(本需求)」
   * 卡片渲染当前 snapshot 值;rc.27 之前的老需求 load 后即为 null,首次编辑后才会固化。
   */
  formulaWThinkOverride: number | null
  /**
   * 当前生效公式 = 全局 formula + 需求级覆盖合并后的产物。`wThink` = override ?? global,
   * `tokenPenaltyEnabled` / `tokenSoftCapK` 始终取全局。供前端直接渲染当前生效配置,
   * 避免重复合并逻辑。
   */
  effectiveFormula: FormulaSettings
}

/**
 * 需求终态(finished/abandoned)且已记录 finishedAt 时,把指标计算用的 iteration 集合
 * 定格到「reportedAt <= finishedAt」那部分,屏蔽完成之后由 retrospective / attach_summary
 * 等自动上报追加的 iteration(它们会把墙钟 elapsedMinutes 重新算成 now - startedAt 而膨胀)。
 *
 * 边界:finishedAt 为空(进行中 / 老数据)直接原样返回;reportedAt 为空串的老 iteration
 * 因 `'' <= finishedAt` 恒为真而保留,不会被误删。
 */
function freezeIterationsAtFinish(
  requirement: StoredRequirement,
  iterations: StoredIteration[]
): StoredIteration[] {
  const finishedAt = requirement.finishedAt
  const terminal = requirement.status === 'finished' || requirement.status === 'abandoned'
  if (!terminal || !finishedAt) return iterations
  return iterations.filter((it) => !it.reportedAt || it.reportedAt <= finishedAt)
}

export function buildSummaryView(
  requirement: StoredRequirement,
  iterations: StoredIteration[],
  globalFormula: FormulaSettings
): RequirementSummaryView {
  const subtasks = Array.isArray(requirement.subtasks) ? requirement.subtasks : []
  // 指标定格:终态需求只用完成时刻及之前的 iteration 算 boost / 墙钟 / token / 思考时长。
  // iterationCount / latestIterationAt 仍反映真实全量(完成后的自动上报照旧入库,只是不计指标)。
  const metricsIterations = freezeIterationsAtFinish(requirement, iterations)
  // wThink 走 snapshot-on-init 语义:需求级 override 优先,缺失(老数据)回退到全局。
  // tokenPenaltyEnabled / tokenSoftCapK 不进入需求级,始终读全局。
  const effectiveFormula: FormulaSettings = {
    ...globalFormula,
    wThink:
      typeof requirement.formulaWThinkOverride === 'number' &&
      Number.isFinite(requirement.formulaWThinkOverride)
        ? clamp01(requirement.formulaWThinkOverride)
        : globalFormula.wThink
  }
  const metrics = computeMetrics({
    manualEstimateMinutes: requirement.manualEstimateMinutes,
    iterations: metricsIterations,
    subtasks,
    linkedBugCount: requirement.linkedBugCount,
    formula: effectiveFormula
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
    latestIterationAt: iterations.length ? iterations[iterations.length - 1].reportedAt : null,
    finishedAt: requirement.finishedAt ?? null,
    formulaWThinkOverride:
      typeof requirement.formulaWThinkOverride === 'number' &&
      Number.isFinite(requirement.formulaWThinkOverride)
        ? clamp01(requirement.formulaWThinkOverride)
        : null,
    effectiveFormula
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
