/**
 * AI 提效面板看板 API 客户端。
 *
 * v2.0 改造后,所有需求 / iteration / formula / jira-config 都存放在用户本机
 * `~/.truesight-local-agent/ai-productivity/`,看板浏览器通过 agent 暴露的
 * `http://127.0.0.1:17280/ai-productivity/*` 端点直接读写本地数据;不再有平台
 * API 与数据库参与。
 *
 * agent 会根据 Origin 头放行可信来源,因此面板请求无需 token,但需要带上
 * `credentials: 'omit'`(避免触发 CORS preflight 的 Cookie 复杂逻辑)。
 */

/**
 * Daemon API base URL。
 *
 * - 生产态:看板由 daemon 同源托管(`http://127.0.0.1:<port>`),AGENT_BASE 留空
 *   意味着 fetch 走相对路径 → 浏览器同源(免 CORS preflight、免 token)。
 * - 开发态(`vite dev`):可通过环境变量 `VITE_AIPT_DAEMON_URL` 覆盖 base,
 *   或依赖 vite.config.ts 配置的 `/ai-productivity` proxy。
 * - 测试态:可在测试用例里把 AGENT_BASE 显式覆盖到测试 mock server。
 */
export const AGENT_BASE: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_AIPT_DAEMON_URL) ||
  ''

export type Complexity = 'low' | 'medium' | 'high'
export type RequirementStatus = 'in_progress' | 'finished' | 'abandoned'

export type AiSubtask = {
  id: string
  title: string
  weight: number
  done: boolean
  doneAt?: string | null
}

export type RequirementMetrics = {
  codingRuns: number
  boost: number | null
  completion: number
  latestCumulativeToken: number
  latestElapsedMinutes: number
  /** 各 iteration thinkSeconds(本轮 wall time)累加值,反映 AI 纯思考时间(剔除空闲) */
  totalThinkSeconds: number
  bugPenalty: number
  tokenPenalty: number
}

export type ChangedFile = {
  path: string
  status: string
}

/**
 * v2.5.0 iteration 来源 AI 工具标识。
 * - cursor: Hook 路径 body.source='cursor-hook',或 skill 模板硬编码
 * - claude-code: Watcher 监听 ~/.claude/projects,或 Hook 路径 body.source='claude-hook'
 * - unknown: 老数据缺字段或来源无法识别;前端不渲染 chip
 */
export type IterationSource = 'cursor' | 'claude-code' | 'unknown'

export type IterationDetail = {
  seq: number
  kind: string
  branch: string
  /** v2.5.0 调用方 AI 工具来源;'unknown' 时前端不渲染 chip */
  source?: IterationSource
  cumulativeToken: number
  elapsedMinutes: number
  firstCodingCompletion: number | null
  aiQualitySelfScore: number | null
  aiConfidence: number | null
  /** 本次对话变更(自上一轮 iteration 以来的增量) */
  diffFiles: number
  diffInsertions: number
  diffDeletions: number
  changedFiles: ChangedFile[]
  /** 总变更(自 init baseCommit 以来的累计) */
  cumulativeDiffFiles: number
  cumulativeDiffInsertions: number
  cumulativeDiffDeletions: number
  cumulativeChangedFiles: ChangedFile[]
  milestoneNote: string
  thinkSeconds: number
  /**
   * v1.0.0-rc.18 纯模型思考时间(秒)。Cursor 链路通过 `afterAgentThought` hook 累加 thinking 块
   * `duration_ms` 折算而来,与 `thinkSeconds`(本轮 wall time)解耦。Claude Code / 老数据缺失。
   */
  pureThinkSeconds?: number
  modelName: string
  reportedAt: string
  rawPayloadFile: string | null
  /**
   * v2.4.0 升级为结构化对话总结。
   * 由 ai-productivity-track skill / Cursor rule 在每轮最终答复前通过
   * ai_productivity_attach_summary MCP tool 回填到「最新一条非 init iteration」。
   * 旧 jsonl 中的字符串总结在 agent 端 lazy normalize 为对象后返回,前端始终收到结构化形式。
   */
  conversationSummary: ConversationSummary | null
}

export type ConversationType = 'coding' | 'communication'

export type ConversationSummary = {
  /** 一句话总结,≤120 字 */
  oneLine: string
  /** 对话类型:coding=本轮涉及代码改动,communication=纯沟通讨论 */
  type: ConversationType
  /** 改动范围简述,≤120 字。type=coding 时必填 */
  changeScope?: string
  /** 讨论内容简述,≤300 字。type=communication 时必填 */
  discussion?: string
}

export type ClarifyConflict = {
  title: string
  jiraText: string
  codeFact: string
  type: 'partial' | 'mismatch' | 'unknown'
  impact: string
  pmSpeech: string
}

export type RequirementSummary = {
  jiraKey: string
  jiraUrl: string
  title: string
  summary: string
  complexity: string
  manualEstimateMinutes: number
  subtasks: AiSubtask[]
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
  clarifyConflicts: ClarifyConflict[]
  metrics: RequirementMetrics
  iterationCount: number
  latestIterationAt: string | null
}

export type RequirementDetail = RequirementSummary & {
  iterations: IterationDetail[]
}

export type SummaryMetrics = {
  totalRequirements: number
  inProgressCount: number
  finishedCount: number
  averageBoost: number | null
  totalBugCount: number
  totalToken: number
}

export type FormulaSettings = {
  kBug: number
  kToken: number
  tokenPriceUsdPer1k: number
  hourlyCostUsd: number
}

export type JiraPluginConfigPayload = {
  configured: boolean
  baseUrl: string
  apiEmail: string
  bugJqlTemplate: string
}

export interface AgentEnvelope<T> {
  code: 'OK' | 'ERROR'
  message: string
  data: T
}

export class AgentRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public cause?: unknown
  ) {
    super(message)
    this.name = 'AgentRequestError'
  }
}

interface AgentRequestOptions extends RequestInit {
  signal?: AbortSignal
}

async function agentRequest<T>(path: string, opts: AgentRequestOptions = {}): Promise<T> {
  const url = `${AGENT_BASE}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      ...opts,
      credentials: 'omit'
    })
  } catch (err) {
    throw new AgentRequestError(
      'Daemon 不可达,请确认 ai-productivity-tracker daemon 已启动(默认 127.0.0.1:17350)',
      0,
      err
    )
  }

  const text = await response.text()
  let body: AgentEnvelope<T> | null = null
  try {
    body = text ? (JSON.parse(text) as AgentEnvelope<T>) : null
  } catch {
    throw new AgentRequestError(`响应非 JSON: ${text.slice(0, 200)}`, response.status)
  }

  if (!response.ok || !body || body.code !== 'OK') {
    const msg = body?.message ?? `HTTP ${response.status}`
    throw new AgentRequestError(msg, response.status, body)
  }

  return body.data
}

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v) usp.set(k, v)
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export function listRequirements(
  params: { owner?: string; status?: string; project?: string; q?: string } = {}
) {
  return agentRequest<RequirementSummary[]>(`/ai-productivity/requirements${buildQuery(params)}`)
}

export function getRequirementDetail(jiraKey: string) {
  return agentRequest<RequirementDetail>(
    `/ai-productivity/requirements/${encodeURIComponent(jiraKey)}`
  )
}

export function patchRequirement(
  jiraKey: string,
  patch: Partial<{
    status: RequirementStatus
    title: string
    summary: string
    manualEstimateMinutes: number
    complexity: Complexity
  }>
) {
  return agentRequest<{ jiraKey: string; status: string }>(
    `/ai-productivity/requirements/${encodeURIComponent(jiraKey)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }
  )
}

export function toggleSubtask(jiraKey: string, subtaskId: string, done: boolean) {
  return agentRequest<{ updated: boolean; subtasks: AiSubtask[] }>(
    `/ai-productivity/requirements/${encodeURIComponent(jiraKey)}/subtasks/${encodeURIComponent(subtaskId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ done, source: 'manual' })
    }
  )
}

export function refreshBugs(jiraKey: string) {
  return agentRequest<{
    linkedBugCount: number
    linkedBugJql: string
    bugsRefreshedAt: string | null
  }>(`/ai-productivity/requirements/${encodeURIComponent(jiraKey)}/refresh-bugs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
}

/**
 * v2.14.0 用 agent 已存的 Jira 凭证拉真实 issue summary,写回 requirement.title.
 *
 * 适用场景:
 * - 历史脏数据修复(init 时 LLM 没传 title 且 agent 未配 Jira → 标题落成 jiraKey)
 * - 详情抽屉自动兜底:title === jiraKey 时静默触发一次
 *
 * 失败 422 表示 Jira 凭证未配置 / issue 拉不到,前端弹消息引导用户去 Settings 配置.
 */
export function syncJiraTitle(jiraKey: string) {
  return agentRequest<{ title: string; source: 'jira' }>(
    `/ai-productivity/requirements/${encodeURIComponent(jiraKey)}/sync-jira-title`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }
  )
}

/**
 * v2.18.0 数据整理:合并 Cursor stop-hook 兜底产生的"前一条空总结 + 后一条满总结"
 * 拆分对。
 *
 * - dryRun=true:只扫描候选,不写盘,不备份
 * - dryRun 缺省/false:扫描 + 写 .bak-<ts> 备份 + 整文件 tmp+rename 重写
 *   返回的 backupPath 是 daemon 端的绝对路径,用户感觉占空间时可自行清理
 *
 * 严格识别规则(全部满足才合并):
 *  - 两条均非 init iteration
 *  - 同一非空 branch
 *  - reportedAt 间隔 ∈ [0, 120_000] ms
 *  - 前一条 conversationSummary === null
 *  - 后一条 conversationSummary !== null
 *  - 后一条 source === 'cursor'
 */
export type MergeSplitIterationsResponse = {
  jiraKey: string
  dryRun: boolean
  mergedPairs: Array<{ fromSeq: number; intoSeq: number }>
  totalBefore: number
  totalAfter: number
  /** 仅真合并成功且产生备份时给出绝对路径,其它情形为 null */
  backupPath: string | null
}

export function mergeSplitIterations(jiraKey: string, options: { dryRun?: boolean } = {}) {
  return agentRequest<MergeSplitIterationsResponse>(
    `/ai-productivity/requirements/${encodeURIComponent(jiraKey)}/merge-split-iterations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: options.dryRun === true })
    }
  )
}

export function fetchSummary() {
  return agentRequest<SummaryMetrics>('/ai-productivity/summary')
}

export function fetchFormula() {
  return agentRequest<FormulaSettings>('/ai-productivity/formula')
}

export function patchFormula(patch: Partial<FormulaSettings>) {
  return agentRequest<FormulaSettings>('/ai-productivity/formula', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  })
}

export function fetchJiraConfig() {
  return agentRequest<JiraPluginConfigPayload>('/ai-productivity/jira-config')
}

export function patchJiraConfig(
  patch: Partial<{ baseUrl: string; apiToken: string; apiEmail: string; bugJqlTemplate: string }>
) {
  return agentRequest<JiraPluginConfigPayload>('/ai-productivity/jira-config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  })
}

export type AgentStatus = {
  ok: boolean
  port?: number
  version?: string
  errorMessage?: string
}

export async function probeAgent(): Promise<AgentStatus> {
  try {
    const response = await fetch(`${AGENT_BASE}/status`, { credentials: 'omit' })
    if (!response.ok) {
      return { ok: false, errorMessage: `HTTP ${response.status}` }
    }
    const body = (await response.json().catch(() => null)) as {
      code?: string
      data?: { version?: string; port?: number }
    } | null
    return {
      ok: true,
      version: body?.data?.version,
      port: body?.data?.port
    }
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err)
    }
  }
}

export function fetchStoragePath() {
  return agentRequest<{ root: string }>('/ai-productivity/storage-path')
}

export type WatcherStatus = {
  running: boolean
  claudeProjectsDir: string
  trackedFiles: number
  startedAt: string | null
}

export function fetchWatcherStatus() {
  return agentRequest<WatcherStatus>('/ai-productivity/watcher-status')
}

export type CursorHookStatus = {
  /** v2.2.0 起 Hook 入口 = MCP .mjs;true 表示 ~/Downloads/ai-productivity-mcp.mjs 已存在 */
  hookEntryInstalled: boolean
  hookEntryPath: string
  /**
   * v2.13.0 本地 mcp.mjs 解析出的版本号(从 banner marker 提取);
   * 文件不存在 / 无 marker(v2.12.x 及之前 build 的老 .mjs) → null。
   * 看板对比线上 version.json 后,不一致时提示用户重新下载。
   */
  hookEntryVersion: string | null
  /** v2.1.x 兼容别名:与 hookEntryInstalled 同值 */
  cliInstalled: boolean
  /** v2.1.x 兼容别名:与 hookEntryPath 同值 */
  cliPath: string
  hooksFileExists: boolean
  hookInstalled: boolean
  hookCommand: string | null
  debugMode: boolean
  /** hooks.json 仍残留老 CLI(~/.local/bin/ai-productivity) 路径,提示「将被覆盖」 */
  legacyHookDetected: boolean
  /**
   * v1.0.0-rc.18 起 3 个事件独立状态(老 daemon 可能不返该字段);UI 据此精准提示缺哪条。
   * 缺省时按 hookInstalled 兜底显示「未注入」。
   */
  perEvent?: {
    afterAgentResponse: boolean
    beforeSubmitPrompt: boolean
    afterAgentThought: boolean
  }
}

export function fetchCursorHookStatus() {
  return agentRequest<CursorHookStatus>('/ai-productivity/cursor-hook-status')
}

/**
 * v2.13.0 拉取看板服务器上发布的最新 mcp.mjs 版本号(同源静态资源,不经 agent).
 *
 * `apps/web/public/downloads/ai-productivity-mcp/version.json` 由
 * `packages/ai-productivity-mcp/build.mjs` 每次 build 自动覆盖,与产物 .mjs banner
 * 里的 `__AI_PRODUCTIVITY_MCP_VERSION__` 同源,保证看板上展示的"线上版本"始终
 * 是当前 web 公开下载链路实际可拉到的那个 .mjs 版本.
 *
 * 失败(网络异常 / version.json 缺失 / JSON 损坏)一律返回 null,看板回退到"未知"状态.
 */
export async function fetchPublishedMcpVersion(): Promise<string | null> {
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const res = await fetch(`${origin}/downloads/ai-productivity-mcp/version.json`, {
      cache: 'no-cache',
      credentials: 'omit'
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== 'string' || !body.version.trim()) return null
    return body.version.trim()
  } catch {
    return null
  }
}

export type InstallCursorHookResponse = {
  ok: boolean
  hookEntryPath: string
  /** v2.1.x 兼容别名 */
  cliPath: string
  hooksPath: string
  /** 写入 hooks.json 的完整 command 字符串(含 marker、可能含 debug 前缀) */
  finalCommand: string
  replaced: boolean
  previousCommand: string | null
  errorMessage?: string
}

export function installCursorHook(debug = false) {
  return agentRequest<InstallCursorHookResponse>('/ai-productivity/install-cursor-hook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ debug })
  })
}

/**
 * v2.4.0 一键下载 MCP 单文件 .mjs 到本机 ~/Downloads/ai-productivity-mcp.mjs。
 * 浏览器侧负责 fetch 同源静态 .mjs → base64,agent 仅负责解码 + 落盘 + chmod 755,
 * 这样 agent 仍保持「不主动出网」原则。
 */
export type InstallMcpEntryResponse = {
  ok: true
  path: string
  bytesWritten: number
  replaced: boolean
}

export function installMcpEntry(contentBase64: string) {
  return agentRequest<InstallMcpEntryResponse>('/ai-productivity/install-mcp-entry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentBase64 })
  })
}

// ===== v2.3.0 AI 对话总结 Skill / Cursor Rule 一键注入 =====

export type TrackSkillTargetStatus = {
  defaultPath: string
  installed: boolean
  upToDate: boolean
  outdated: boolean
}

/**
 * v2.6.0 Claude Code UserPromptSubmit Hook 状态。
 * 通过 marker `# ai-productivity-track-reminder` 识别 `~/.claude/settings.json`
 * 内的 reminder 条目,作为 SKILL.md auto-invoke 的强制触发兜底。
 */
export type ClaudeTrackHookStatus = {
  path: string
  installed: boolean
  upToDate: boolean
  currentCommand: string | null
}

export type ClaudeTrackHookInstallResult = {
  path: string
  replaced: boolean
  previousCommand: string | null
  finalCommand: string
}

/**
 * v2.10.0 Cursor Hook 状态(skill-sync 仅注入 stop hook;afterMCPExecution mark-tool-called 已下线)。
 * 老 hooks.json 残留的 mark-tool-called 条目通过 `legacyMarkToolDetected` 字段反馈,
 * 用户点一次「一键注入 Skill」会被 install 流程主动清理。
 */
export type CursorTrackHookStatus = {
  path: string
  stopCheckInstalled: boolean
  stopCheckUpToDate: boolean
  stopCheckCurrentCommand: string | null
  /** v2.10.0 deprecated:残留的 afterMCPExecution mark-tool-called 老条目 */
  legacyMarkToolDetected: boolean
  legacyHookDetected: boolean
}

export type CursorTrackHookInstallResult = {
  path: string
  stopCheck: { replaced: boolean; previousCommand: string | null; finalCommand: string }
  /** v2.10.0:install 时清理掉的 afterMCPExecution mark-tool-called 老条目 */
  legacyMarkToolRemoved: boolean
  legacyMarkToolPreviousCommand: string | null
}

export type TrackSkillStatus = {
  version: string
  claude: TrackSkillTargetStatus & {
    hook: ClaudeTrackHookStatus
    stopCheck: ClaudeTrackHookStatus
    /** v2.10.0 deprecated:残留的 PostToolUse mark-tool-called 老条目 */
    legacyMarkToolDetected: boolean
  }
  cursor: TrackSkillTargetStatus & {
    hook: CursorTrackHookStatus
  }
  /**
   * v2.16.0 复用「一键注入 Skill」一并同步的 lessons-extract skill 同步态。
   * 老 agent 没有该字段时为 undefined,前端兜底渲染「未知」。
   */
  lessonsExtract?: {
    version: string
    claude: TrackSkillTargetStatus
    cursor: TrackSkillTargetStatus
  }
}

export type InstallTrackSkillResponse = {
  version: string
  claude: {
    path: string
    written: boolean
    replaced: boolean
    hook: ClaudeTrackHookInstallResult
    stopCheck: ClaudeTrackHookInstallResult
    /** v2.10.0:install 时清理掉的 PostToolUse mark-tool-called 老条目 */
    legacyMarkToolRemoved: boolean
    legacyMarkToolPreviousCommand: string | null
  }
  cursor: {
    path: string
    written: boolean
    replaced: boolean
    hook: CursorTrackHookInstallResult
  }
}

export function fetchTrackSkillStatus() {
  return agentRequest<TrackSkillStatus>('/ai-productivity/track-skill-status')
}

export function installTrackSkill() {
  return agentRequest<InstallTrackSkillResponse>('/ai-productivity/install-track-skill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
}

// ===== v2.16.0 P0 经验沉淀(lessons) 看板 API =====

export type LessonType = 'pitfall' | 'rule' | 'best-practice' | 'split-suggestion' | 'tooling'

export type LessonTrust = 'high' | 'medium' | 'low'

export type LessonExtractedBy = 'cursor' | 'claude-code' | 'manual'

/**
 * v2.17.0 经验作用域:
 * - 'general' = 通用经验,跨项目可复用
 * - 'project' = 项目专属,仅在 projectSlug 命中项目内复用
 * - ''        = 老数据(v2.16.x)未带 scope,UI 展示「未分类」
 */
export type LessonScope = 'general' | 'project' | ''

export type LessonSummary = {
  id: string
  jiraKey: string
  type: LessonType
  title: string
  tags: string[]
  trust: LessonTrust
  createdAt: string
  /** v2.17.0 缺字段时兜底为 '' */
  scope?: LessonScope
  /** v2.17.0 scope='project' 时承载项目标识(=package.json name) */
  projectSlug?: string
}

export type LessonDetail = LessonSummary & {
  jiraTitle: string
  content: string
  rootCause?: string
  fix?: string
  reusableWhen?: string
  affectedFiles?: string[]
  iterationSeqs?: number[]
  source: { extractedBy: LessonExtractedBy; extractedAt: string }
}

export type ListLessonsQuery = {
  jiraKey?: string
  type?: LessonType
  tag?: string
  q?: string
  /** v2.17.0:'general' / 'project' / 'unscoped'(老数据) */
  scope?: 'general' | 'project' | 'unscoped'
  /** v2.17.0:精确匹配项目标识 */
  projectSlug?: string
}

export function listLessons(params: ListLessonsQuery = {}) {
  return agentRequest<LessonSummary[]>(
    `/ai-productivity/lessons${buildQuery(params as Record<string, string | undefined>)}`
  )
}

export function getLessonDetail(id: string) {
  return agentRequest<LessonDetail>(`/ai-productivity/lessons/${encodeURIComponent(id)}`)
}

export function deleteLesson(id: string) {
  return agentRequest<{ deleted: boolean; id: string }>(
    `/ai-productivity/lessons/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
}
