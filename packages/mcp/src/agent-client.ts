export interface AgentClientConfig {
  baseUrl: string
  token: string
}

export class AgentClientError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown
  ) {
    super(message)
    this.name = 'AgentClientError'
  }
}

interface OkEnvelope<T> {
  code: 'OK'
  message: string
  data: T
}

export interface InitInput {
  jiraInput: string
  title?: string
  projectRoot?: string
  summary?: string
  manualEstimateMinutes?: number
  complexity?: 'low' | 'medium' | 'high'
}

export interface InitResult {
  jiraKey: string
  branch: string
  gitRoot: string
  panelUrl: string
}

export interface StatusInput {
  projectRoot?: string
}

export interface StatusResult {
  bound: boolean
  branch: string | null
  issueKey: string | null
  jiraKey?: string | null
  cumulativeToken?: number
  startedAt?: string | null
  gitRoot: string | null
}

export type AttachSummaryConversationType = 'coding' | 'communication'

export type AttachSummarySource = 'cursor' | 'claude-code' | 'codex'

export interface AttachSummaryInput {
  /** 一句话总结,≤120 字 */
  oneLine: string
  /**
   * 对话类型:coding=代码改动,communication=纯沟通。
   * v2.14.2 起 agent 端兜底,缺省默认 'communication'。
   */
  type?: AttachSummaryConversationType
  /** 改动范围简述(coding 时必填,≤120 字) */
  changeScope?: string
  /** 讨论内容简述(communication 时必填,≤300 字) */
  discussion?: string
  jiraKey?: string
  branch?: string
  /**
   * v2.5.0 调用方 AI 工具来源,由 skill 模板硬编码:
   * - CURSOR_RULE.md 传 'cursor'
   * - SKILL.md(claude code)传 'claude-code'
   * Agent 仅在 target iteration 缺失 source 时回填,不覆盖 Hook/Watcher 已写入的值。
   */
  source?: AttachSummarySource
  /**
   * v2.5.1 当前工作目录,用于 agent 端 jiraKey 兜底解析(取 cwd 当前分支 → bindings.json 活跃需求)。
   * 客户端缺省时自动取 CLAUDE_PROJECT_DIR / CURSOR_PROJECT_DIR / process.cwd()。
   */
  cwd?: string
}

export interface AttachSummaryResult {
  ok: true
  /** v2.7.0 起 happy path 恒为 true;v2.13.0 起 skipped 场景为 false */
  updated: boolean
  /**
   * v2.7.0:总结已写入 `<jiraKey>/pending-summary.json` 中间态,等待下一条 iteration 写盘消费。
   * `pending: true` 表示已成功落盘 pending(等价旧 updated:true)。
   */
  pending?: boolean
  /**
   * v2.13.0 新增:非 Jira 分支误调的兜底,daemon 不返 4xx 而是返
   * `{ skipped: true, reason: 'no_jira_key', jiraKey: '' }`,避免 IDE 工具面板标红。
   * MCP 工具层把它格式化为 `skipped jiraKey=... reason=no_jira_key`。
   */
  skipped?: boolean
  /** skipped=true 时为空串;happy path 为实际 jiraKey */
  jiraKey: string
  /** v2.7.0 起恒为 null:总结由下一条 iteration 接管,seq 在 attach 调用时尚未确定 */
  iterationSeq: number | null
  /**
   * v2.6.0:'no_iteration' | 'only_init' 老语义。
   * v2.7.0 新增 'write_failed'。
   * v2.13.0 新增 'no_jira_key'(非 Jira 分支误调的 skipped 兜底)。
   */
  reason?: 'no_iteration' | 'only_init' | 'write_failed' | 'no_jira_key'
}

export class AgentClient {
  constructor(private readonly config: AgentClientConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}${path}`
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body != null ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '本地 agent 未响应'
      throw new AgentClientError(0, `本地 agent 不可达: ${msg}`)
    }

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new AgentClientError(response.status, `agent 返回非 JSON: ${text.slice(0, 200)}`, text)
    }

    if (!response.ok) {
      const message = (parsed as { message?: string })?.message ?? `HTTP ${response.status}`
      throw new AgentClientError(response.status, message, parsed)
    }
    const envelope = parsed as OkEnvelope<T>
    if (envelope.code !== 'OK') {
      throw new AgentClientError(response.status, envelope.message ?? 'unknown error', envelope)
    }
    return envelope.data
  }

  async init(input: InitInput): Promise<InitResult> {
    const projectRoot = input.projectRoot ?? resolveClientCwd()
    const payload: InitInput = projectRoot ? { ...input, projectRoot } : input
    return this.request<InitResult>('POST', '/ai-productivity/init', payload)
  }

  async status(input: StatusInput): Promise<StatusResult> {
    const projectRoot = input.projectRoot ?? resolveClientCwd()
    const qs = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
    return this.request<StatusResult>('GET', `/ai-productivity/status${qs}`)
  }

  async attachSummary(input: AttachSummaryInput): Promise<AttachSummaryResult> {
    const cwd = input.cwd ?? resolveClientCwd()
    const payload: AttachSummaryInput = cwd ? { ...input, cwd } : input
    return this.request<AttachSummaryResult>('POST', '/ai-productivity/attach-summary', payload)
  }

  // v2.16.0 P0 经验沉淀(lessons-extract skill)

  async extractBundle(input: ExtractBundleInput): Promise<LessonsBundle> {
    const jiraKey = encodeURIComponent(input.jiraKey)
    return this.request<LessonsBundle>(
      'GET',
      `/ai-productivity/requirements/${jiraKey}/lessons-bundle`
    )
  }

  async saveLessons(input: SaveLessonsInput): Promise<SaveLessonsResult> {
    return this.request<SaveLessonsResult>('POST', '/ai-productivity/lessons', {
      jiraKey: input.jiraKey,
      lessons: input.lessons,
      source: input.source
    })
  }

  // v1.0.0-rc.23 单需求复盘报告(retrospective-report skill)

  async extractRetrospectiveBundle(
    input: ExtractRetrospectiveBundleInput
  ): Promise<RetrospectiveBundleData> {
    const jiraKey = encodeURIComponent(input.jiraKey)
    return this.request<RetrospectiveBundleData>(
      'GET',
      `/ai-productivity/requirements/${jiraKey}/retrospective-bundle`
    )
  }

  async saveRetrospective(input: SaveRetrospectiveInput): Promise<SaveRetrospectiveResult> {
    const jiraKey = encodeURIComponent(input.jiraKey)
    return this.request<SaveRetrospectiveResult>(
      'POST',
      `/ai-productivity/requirements/${jiraKey}/retrospective`,
      {
        narrative: input.narrative,
        source: input.source,
        referencedLessonIds: input.referencedLessonIds,
        anchorIterationSeqs: input.anchorIterationSeqs,
        harnessSummary: input.harnessSummary
      }
    )
  }
}

export interface ExtractBundleInput {
  jiraKey: string
  cwd?: string
}

export type LessonType = 'pitfall' | 'rule' | 'best-practice' | 'split-suggestion' | 'tooling'

/** v2.17.0 经验作用域:general=通用,project=项目专属 */
export type LessonScope = 'general' | 'project'

export interface LessonInputForSave {
  id?: string
  jiraKey: string
  jiraTitle?: string
  type: LessonType
  title: string
  content: string
  rootCause?: string
  fix?: string
  reusableWhen?: string
  tags?: string[]
  affectedFiles?: string[]
  iterationSeqs?: number[]
  trust?: 'high' | 'medium' | 'low'
  /** v2.17.0 缺省 → agent 端兜底 'project' */
  scope?: LessonScope
  /** v2.17.0 scope='project' 必填(通常取 bundle.currentProjectSlug);缺省时 agent 按 jiraKey 反查 requirement.projectSlug 兜底 */
  projectSlug?: string
}

export interface SaveLessonsInput {
  jiraKey: string
  lessons: LessonInputForSave[]
  /** 'cursor' / 'claude-code' / 'codex',由 SKILL/Rule 模板硬编码,缺省 manual */
  source?: 'cursor' | 'claude-code' | 'codex'
  /** v2.17.0 批次维度 projectSlug 兜底(优先级低于 lesson 自身字段) */
  projectSlug?: string
}

export interface SaveLessonsResult {
  saved: Array<{ id: string; jiraKey: string; type: LessonType; title: string }>
  savedCount: number
  replaced: string[]
  rejected: Array<{ index: number; reason: string }>
}

/**
 * v2.18.0 bundle 客观信号摘要,与 agent 端 BundleComputedSignals 同构。
 * MCP 仅作为透传层,字段语义见 lessons-store.ts。
 */
export interface BundleComputedSignals {
  boost: number | null
  linkedBugCount: number | null
  cumulativeEffectiveTokens: number
  cumulativeThinkSeconds: number
  fileChurnMap: Array<{
    path: string
    insertions: number
    deletions: number
    touchedSeqs: number[]
  }>
  abnormalStopReasons: Array<{ reason: string; seqs: number[] }>
  topThinkSeqs: number[]
}

export interface LessonsBundle {
  jiraKey: string
  /** v2.17.0 当前需求项目标识(=requirement.projectSlug=package.json name) */
  currentProjectSlug: string
  requirement: unknown | null
  iterations: unknown[]
  existingLessons: unknown[]
  /** v2.18.0 客观信号摘要,老 agent 缺该字段时 undefined,formatExtractBundle 自然降级 */
  computedSignals?: BundleComputedSignals
}

// ─── v1.0.0-rc.23 retrospective-report ──────────────────────────────────

export interface ExtractRetrospectiveBundleInput {
  jiraKey: string
  cwd?: string
}

export type RetrospectiveSource = 'cursor' | 'claude-code' | 'codex' | 'manual'

export interface RetrospectivePhaseInput {
  title: string
  iterationSeqRange: [number, number]
  summary: string
}

export interface RetrospectiveNarrativeInput {
  overview: string
  phases: RetrospectivePhaseInput[]
  highlights: string[]
  issues: string[]
  improvements: string[]
  pitfallsObserved: string[]
  nextSteps: string[]
  splitSuggestions?: string[]
}

export type HarnessSuggestionCategory =
  | 'guardrail-rule'
  | 'check-script'
  | 'checklist'
  | 'baseline'
  | 'manifest'
  | 'self-evolution'

export interface RetrospectiveHarnessSuggestionInput {
  category: HarnessSuggestionCategory
  title: string
  signal: string
  content: string
  targetFile?: string
  anchorSeqs?: number[]
}

export interface RetrospectiveHarnessSummaryInput {
  overview?: string
  suggestions: RetrospectiveHarnessSuggestionInput[]
}

export interface SaveRetrospectiveInput {
  jiraKey: string
  narrative: RetrospectiveNarrativeInput
  source?: RetrospectiveSource
  referencedLessonIds?: string[]
  anchorIterationSeqs?: number[]
  harnessSummary?: RetrospectiveHarnessSummaryInput
}

export interface RetrospectiveBundleRelatedLessonView {
  id: string
  jiraKey: string
  type: LessonType
  title: string
  scope: 'general' | 'project' | ''
  projectSlug: string
  hitCount: number
}

export interface RetrospectiveBundleData {
  jiraKey: string
  currentProjectSlug: string
  requirement: unknown | null
  iterations: unknown[]
  computedSignals: BundleComputedSignals
  relatedLessons: RetrospectiveBundleRelatedLessonView[]
  /** 已存在的报告(允许 LLM 看上次怎么写的避免无变化重复落盘);从未生成时为 null */
  existingRetrospective: unknown | null
}

export interface SaveRetrospectiveResult {
  schemaVersion: number
  jiraKey: string
  generatedAt: string
  generatedAtIterationSeq: number
  generatedAtIterationCount: number
  source: RetrospectiveSource
  snapshot: {
    title: string
    status: string
    boost: number | null
    cumulativeToken: number
    totalThinkSeconds: number
    elapsedMinutes: number
    cumulativeDiffFiles: number
    cumulativeDiffInsertions: number
    cumulativeDiffDeletions: number
    linkedBugCount: number
    lessonsCount: number
    abnormalStopReasonsCount: number
  }
  narrative: RetrospectiveNarrativeInput
  referencedLessonIds: string[]
  anchorIterationSeqs: number[]
  harnessSummary?: RetrospectiveHarnessSummaryInput
}

/**
 * v2.7.3 MCP 客户端 cwd 解析,按优先级:
 *   1) CLAUDE_PROJECT_DIR / CURSOR_PROJECT_DIR / CODEX_PROJECT_DIR(老约定 + 自定义集成保留)
 *   2) WORKSPACE_FOLDER_PATHS(Cursor IDE 实测注入,单/多工作区可能 ':' 或 ';' 分隔,取首项)
 *      —— 这是 Cursor 启动 MCP server 时唯一传工作区路径的环境变量;
 *         没有这条 fallback 时 process.cwd() 落在用户 home,后端 4 级 fallback 全失败 → 400
 *   3) process.cwd()(Claude Code / Codex CLI 路径会落在项目根)
 */
function resolveClientCwd(): string | undefined {
  const explicit =
    process.env.CLAUDE_PROJECT_DIR ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.CODEX_PROJECT_DIR
  if (explicit && explicit.trim()) return explicit.trim()

  const workspaces = process.env.WORKSPACE_FOLDER_PATHS
  if (workspaces && workspaces.trim()) {
    // 仅按 ':' 切分(与 PATH 同款,Linux/macOS path-style)。
    // Windows 路径含盘符冒号(C:\...), 当前 Cursor macOS/Linux 实测只传单一绝对路径,
    // 多工作区场景留给将来按平台拆分;此处取首个非空段。
    const first = workspaces
      .split(':')
      .map((s) => s.trim())
      .find((s) => s.length > 0)
    if (first) return first
  }

  try {
    return process.cwd()
  } catch {
    return undefined
  }
}
