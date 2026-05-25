import type { ServerResponse } from 'node:http'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  cursorHooksPath as defaultCursorHooksPath,
  inspectCursorHook,
  installCursorHookFile,
  type CursorHookInspectResult,
  type InstallCursorHookResult
} from '@ai-productivity-tracker/hook-core'

import type { ServerConfig as ServiceConfig } from '../config.js'
import {
  parseJiraReference,
  extractIssueKey,
  findGitRoot,
  getCurrentBranch,
  appendTokenUsage,
  readBindings,
  resetBindingForNewInit,
  resolveActiveBindingByCwd,
  upsertBinding,
  appendDedupeKey,
  DEFAULT_DEDUPE_PATH,
  hasDedupeKey,
  loadDedupeState,
  saveDedupeState,
  buildIterationExtras,
  collectNumstat,
  getHeadSha,
  readProjectNameFromPackageJson,
  buildOverallSummary,
  buildSummaryView,
  ensureBoundedJql,
  fetchJiraBugTotal,
  fetchJiraIssueSummary,
  inspectJiraIssueSummary,
  renderJqlTemplate,
  JiraBugFetchError,
  type TranscriptWatcherStatus,
  type DedupeState,
  type GitDiffSummary,
  type NumstatMap,
  type JiraIssueSummaryReason
} from '@ai-productivity-tracker/core'
import {
  aipRoot,
  isValidLessonId,
  numstatMapToRecord,
  writeNumstatSnapshot,
  listRequirementsFromStore,
  loadRequirement,
  saveRequirement,
  updateRequirement,
  appendIteration,
  listIterations,
  appendSubtaskEvent,
  DEFAULT_FORMULA,
  readFormula,
  writeFormula,
  isJiraConfigured,
  readJiraConfig,
  writeJiraConfig,
  buildLessonsBundle,
  LESSON_TYPES,
  listLessons,
  loadLesson,
  removeLesson,
  writeLessons,
  type StoredRequirement,
  type StoredSubtask,
  type UpdateRequirementPatch,
  type IterationSource,
  type FormulaSettings,
  type JiraStoredConfig,
  type LessonExtractedBy,
  type LessonType,
  type WriteLessonInput
} from '@ai-productivity-tracker/core/store'

// ────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────

interface OkEnvelope<T> {
  code: 'OK'
  message: string
  data: T
}
interface ErrEnvelope {
  code: 'ERROR'
  message: string
  data: null
}

function ok<T>(res: ServerResponse, data: T): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 'OK', message: '', data } satisfies OkEnvelope<T>))
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code: 'ERROR', message, data: null } satisfies ErrEnvelope))
}

// ────────────────────────────────────────────────────────────────────
// Init / Status / Hook (IDE → agent,token 鉴权链路)
// ────────────────────────────────────────────────────────────────────

export interface InitRequestBody {
  jiraInput: string
  title?: string
  projectRoot?: string
  summary?: string
  manualEstimateMinutes?: number
  complexity?: 'low' | 'medium' | 'high'
  affectedPaths?: string[]
  subtasks?: Array<{ id: string; title: string; weight: number; done?: boolean }>
  /** clarify-requirement 报告路径,前端 init 时可选透传,审计用 */
  clarifyReportPath?: string
  clarifyReviewerScore?: number | null
  clarifyConflicts?: StoredRequirement['clarifyConflicts']
}

export async function handleAiProductivityInit(
  res: ServerResponse,
  _config: ServiceConfig,
  body: InitRequestBody
): Promise<void> {
  if (!body?.jiraInput) {
    fail(res, 400, '缺少 jiraInput')
    return
  }

  const ref = parseJiraReference(body.jiraInput)
  if (!ref) {
    fail(res, 400, '无法从 jiraInput 中解析出 Jira Key,请检查 URL 或直接传 ABC-123 形式的 key')
    return
  }

  const cwd = body.projectRoot && body.projectRoot.trim() ? body.projectRoot : process.cwd()

  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    fail(res, 409, `${cwd} 不是 git 仓库,请在业务项目根目录调用`)
    return
  }

  const branch = getCurrentBranch(gitRoot)
  if (!branch) {
    fail(res, 409, '当前处于 detached HEAD 状态,请先 checkout 到分支')
    return
  }

  const branchIssueKey = extractIssueKey(branch)
  if (!branchIssueKey) {
    fail(
      res,
      409,
      `当前分支 ${branch} 不包含 Jira Issue Key,请切到形如 feature/${ref.jiraKey}-xxx 的分支`
    )
    return
  }
  if (branchIssueKey !== ref.jiraKey) {
    fail(
      res,
      409,
      `当前分支 ${branch} 的 issueKey (${branchIssueKey}) 与传入的 ${ref.jiraKey} 不一致`
    )
    return
  }

  const normalizedSubtasks: StoredSubtask[] = (body.subtasks ?? []).map((item, idx) => ({
    id: item.id || `st-${idx + 1}`,
    title: item.title,
    weight: Math.max(1, Math.min(5, Number(item.weight) || 1)),
    done: Boolean(item.done)
  }))

  try {
    const now = new Date().toISOString()

    // 1. 优先用 Jira REST 实际标题; 失败 / 未配置 -> 退回 body.title -> jiraKey
    const fallbackTitle = (body.title ?? '').trim()
    const jiraConfigForInit = readJiraConfig()
    const fetchedTitle = await fetchJiraIssueSummary(jiraConfigForInit, ref.jiraKey)
    const resolvedTitle = (fetchedTitle ?? '').trim() || fallbackTitle || ref.jiraKey

    // 2. 项目名取 <gitRoot>/package.json 的 name 字段, 失败回退到 basename(gitRoot)
    const projectSlug = readProjectNameFromPackageJson(gitRoot)

    // 3. 记录 init 时的 HEAD sha, 后续 iteration 用作 diff baseRef
    const initBaseCommit = getHeadSha(gitRoot)

    const requirement = saveRequirement(
      {
        jiraKey: ref.jiraKey,
        jiraUrl: ref.jiraUrl ?? '',
        title: resolvedTitle,
        summary: body.summary ?? '',
        complexity: body.complexity ?? 'medium',
        manualEstimateMinutes: body.manualEstimateMinutes ?? 0,
        affectedPaths: body.affectedPaths ?? [],
        subtasks: normalizedSubtasks,
        projectSlug,
        initBaseCommit,
        clarifyReportPath: body.clarifyReportPath ?? '',
        clarifyReviewerScore: body.clarifyReviewerScore ?? null,
        clarifyConflicts: body.clarifyConflicts ?? [],
        startedAt: now
      },
      { root: undefined, repoPath: gitRoot }
    )

    // 落一条 init iteration,供时间线起点
    appendIteration(ref.jiraKey, { kind: 'init', branch }, undefined)

    // v2.7.0: init 之后立即采集一次基线 numstat-snapshot, 让后续 iteration 的
    // 「本次对话变更」以 init 时刻工作区为零基线,避免把工作区里早就存在的脏文件
    // (与本需求无关的未提交修改) 算到首条 coding iteration 上。
    try {
      const baseRef = initBaseCommit || 'HEAD'
      const baselineNumstat = collectNumstat(gitRoot, baseRef)
      writeNumstatSnapshot(ref.jiraKey, {
        version: 1,
        baseRef,
        perFile: numstatMapToRecord(baselineNumstat),
        updatedAt: now
      })
    } catch {
      // 基线写盘失败不阻塞 init
    }

    // v2.7.2: init 等价于「该需求从 0 开始新一轮追踪」 — 同 jiraKey 已有 binding 时
    // 必须 reset cumulativeToken / startedAt / requirementStartedAt / lastIterationSeq /
    // lastReportedAt / lastHookFiredAt + 删除 pending[jiraKey],避免历史包袱被后续
    // upsertBinding 的「existing 保留」分支继承,导致首条新 iteration 累计虚高。
    // hook 累加路径不受影响,保持「分支后续上报继续累加」语义。
    resetBindingForNewInit(gitRoot, ref.jiraKey, branch, now)

    const binding = upsertBinding(gitRoot, ref.jiraKey, {
      branch,
      startedAt: now,
      requirementStartedAt: requirement.startedAt
    })

    const panelUrl = `http://127.0.0.1:17280/ai-productivity/requirements/${ref.jiraKey}`

    ok(res, {
      jiraKey: requirement.jiraKey,
      branch: binding.branch,
      gitRoot,
      panelUrl,
      requirement
    })
  } catch (err) {
    fail(res, 500, err instanceof Error ? err.message : '未知错误')
  }
}

export interface StatusRequestQuery {
  projectRoot?: string
}

export function handleAiProductivityStatus(
  res: ServerResponse,
  _config: ServiceConfig,
  query: StatusRequestQuery
): void {
  const cwd = query.projectRoot?.trim() || process.cwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    ok(res, { bound: false, branch: null, issueKey: null, gitRoot: null })
    return
  }

  const branch = getCurrentBranch(gitRoot)
  const issueKey = branch ? extractIssueKey(branch) : null

  if (!issueKey) {
    ok(res, { bound: false, branch, issueKey: null, gitRoot })
    return
  }

  const bindings = readBindings(gitRoot)
  const entry = bindings.bindings[issueKey] ?? null

  ok(res, {
    bound: Boolean(entry),
    branch,
    issueKey,
    jiraKey: entry?.jiraKey ?? issueKey,
    cumulativeToken: entry?.cumulativeToken ?? 0,
    startedAt: entry?.startedAt ?? null,
    gitRoot
  })
}

export function handleAiProductivityWatcherStatus(
  res: ServerResponse,
  _config: ServiceConfig,
  getStatus: () => TranscriptWatcherStatus | null
): void {
  const snap: TranscriptWatcherStatus = getStatus() ?? {
    running: false,
    claudeProjectsDir: '',
    trackedFiles: 0,
    startedAt: null
  }
  ok(res, snap)
}

export interface HookRequestBody {
  projectRoot?: string
  branch?: string
  tokens: number
  source: string
  dedupeKey?: string
  rawHookPayload?: Record<string, unknown>
}

/**
 * v2.5.0 把 hook 入口上报的 source 字符串归一化为 IterationSource。
 *
 * - 'cursor-hook'  → 'cursor'(Cursor IDE 通过 hooks.json 触发 mcp.mjs hook)
 * - 'claude-hook'  → 'claude-code'(Claude Code 的 Stop hook 触发 mcp.mjs hook)
 * - 其它/缺失      → 'unknown'
 */
function mapHookSource(raw: string): IterationSource {
  if (raw === 'cursor-hook') return 'cursor'
  if (raw === 'claude-hook') return 'claude-code'
  return 'unknown'
}

export interface HookResponse {
  ok: true
  deduped: boolean
  bound: boolean
  accumulated: number
  cumulativeToken?: number
  jiraKey?: string
  iterationSeq?: number
  reason?: string
}

export interface HookDeps {
  dedupePath?: string
  collectDiff?: (gitRoot: string, baseRef: string) => GitDiffSummary
  collectNumstatFn?: (gitRoot: string, baseRef: string) => NumstatMap
  nowFn?: () => Date
}

export async function handleAiProductivityHook(
  res: ServerResponse,
  _config: ServiceConfig,
  body: HookRequestBody,
  deps: HookDeps = {}
): Promise<void> {
  if (!body || typeof body !== 'object') {
    fail(res, 400, '缺少 hook payload')
    return
  }

  const tokens = Number(body.tokens)
  if (!Number.isFinite(tokens) || tokens < 0) {
    fail(res, 400, 'tokens 必须 >= 0 的有限数')
    return
  }

  const source = typeof body.source === 'string' && body.source ? body.source : 'unknown-hook'
  const dedupePath = deps.dedupePath ?? DEFAULT_DEDUPE_PATH
  const dedupeKey = typeof body.dedupeKey === 'string' && body.dedupeKey ? body.dedupeKey : ''

  let dedupeState: DedupeState | null = null
  if (dedupeKey) {
    dedupeState = loadDedupeState(dedupePath)
    if (hasDedupeKey(dedupeState, dedupeKey)) {
      ok(res, {
        ok: true,
        deduped: true,
        bound: false,
        accumulated: 0,
        reason: `dedupeKey ${dedupeKey} 已处理`
      } satisfies HookResponse)
      return
    }
  }

  if (tokens === 0) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: 'tokens=0,无累加'
    } satisfies HookResponse)
    return
  }

  const cwd = body.projectRoot && body.projectRoot.trim() ? body.projectRoot : process.cwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: `${cwd} 不是 git 仓库`
    } satisfies HookResponse)
    return
  }

  const branch = (body.branch && body.branch.trim()) || getCurrentBranch(gitRoot)
  if (!branch) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: 'detached HEAD,跳过累加'
    } satisfies HookResponse)
    return
  }

  const issueKey = extractIssueKey(branch)
  if (!issueKey) {
    ok(res, {
      ok: true,
      deduped: false,
      bound: false,
      accumulated: 0,
      reason: `分支 ${branch} 不含 Jira Issue Key`
    } satisfies HookResponse)
    return
  }

  const nowDate = (deps.nowFn ?? (() => new Date()))()
  const now = nowDate.toISOString()
  const result = appendTokenUsage(gitRoot, branch, issueKey, tokens, now, source)

  let iterationSeq: number | undefined
  if (result.bound && result.binding) {
    try {
      const rawModel = body.rawHookPayload?.model
      const modelName = typeof rawModel === 'string' ? rawModel : ''
      const requirementForBase = loadRequirement(issueKey)
      const initBaseCommit = requirementForBase?.initBaseCommit ?? ''
      const extras = buildIterationExtras({
        gitRoot,
        binding: result.binding,
        now: nowDate,
        previousReportedAt: result.previousReportedAt,
        // v2.12.0 Cursor hook 链路无 turn 起点信号,只传 source 让 cap 收紧到 60s,
        // 避免「上一轮 → 本轮」差值里用户阅读/输入时间被算成 AI 思考。
        source,
        modelName,
        initBaseCommit,
        jiraKey: issueKey,
        collectDiff: deps.collectDiff,
        collectNumstatFn: deps.collectNumstatFn
      })

      const iteration = appendIteration(issueKey, {
        kind: 'coding',
        branch,
        source: mapHookSource(source),
        cumulativeToken: result.binding.cumulativeToken,
        elapsedMinutes: extras.elapsedMinutes,
        thinkSeconds: extras.thinkSeconds,
        diffFiles: extras.diffFiles,
        diffInsertions: extras.diffInsertions,
        diffDeletions: extras.diffDeletions,
        changedFiles: extras.changedFiles,
        cumulativeDiffFiles: extras.cumulativeDiffFiles,
        cumulativeDiffInsertions: extras.cumulativeDiffInsertions,
        cumulativeDiffDeletions: extras.cumulativeDiffDeletions,
        cumulativeChangedFiles: extras.cumulativeChangedFiles,
        modelName: extras.modelName,
        reportedAt: now,
        rawPayload: {
          source,
          dedupeKey: dedupeKey || null,
          ...(body.rawHookPayload ?? {})
        }
      })
      iterationSeq = iteration.seq
    } catch (err) {
      console.warn(
        `[ai-productivity hook] appendIteration 失败 ${issueKey}: ${(err as Error).message}`
      )
    }
  }

  if (dedupeKey) {
    const next = appendDedupeKey(dedupeState ?? loadDedupeState(dedupePath), dedupeKey, now)
    try {
      saveDedupeState(dedupePath, next)
    } catch (err) {
      console.warn(`[ai-productivity hook] 持久化 dedupe state 失败: ${(err as Error).message}`)
    }
  }

  ok(res, {
    ok: true,
    deduped: false,
    bound: result.bound,
    accumulated: tokens,
    cumulativeToken: result.binding?.cumulativeToken,
    jiraKey: result.binding?.jiraKey,
    iterationSeq,
    reason: result.bound
      ? 'binding 命中,已累加并落本地'
      : `pending 累加 ${result.pendingAccumulated},等待 init 后吸收`
  } satisfies HookResponse)
}

// ────────────────────────────────────────────────────────────────────
// Cursor hook 安装 (UI 触发)
//
// v2.2.0 起 Cursor Hook 入口与 MCP server 复用同一份 ~/Downloads/ai-productivity-mcp.mjs:
//   - hooks.json 命令字符串形如 `node <abs-mjs> hook # ai-productivity-hook`
//   - .mjs 在 argv[2] === 'hook' 时跳过 MCP loop,直接跑 @platform/ai-productivity-hook-core 的 runHook
//   - agent 自己直接写 hooks.json,不再 spawn 任何外部进程
//   - 检测到老 CLI 路径(`~/.local/bin/ai-productivity`) 时返回 legacyHookDetected=true
//     让前端提示用户「将被覆盖」
// ────────────────────────────────────────────────────────────────────

/**
 * Cursor Hook 入口路径(`node <path> hook` 的 `<path>`)。
 *
 * v1.0(独立 npm 包架构):daemon 自己就是 `dist/cli.mjs` esbuild bundle 进程,
 * `process.argv[1]` 指向当前 cli.mjs 的真实绝对路径,直接用它作为 hook 入口即可。
 * 这样浏览器侧「一键注入 Hook」按钮不需要传 hookEntry 也能落正确路径
 * (此前残留兜底到 ~/Downloads/ai-productivity-mcp.mjs 是 v2.x 老下载模式遗物,
 * 在新架构下该文件不会存在 → install 报 412)。
 *
 * 兜底:`process.argv[1]` 不像本工具入口(测试场景 / 非 cli 进程)时回退到老
 * Downloads 路径,保留向后兼容。
 */
export function defaultHookEntryPath(): string {
  const arg1 = process.argv[1]
  if (arg1 && looksLikeAiptCliEntry(arg1) && existsSync(arg1)) return arg1
  return join(homedir(), 'Downloads', 'ai-productivity-mcp.mjs')
}

/**
 * 判定 `process.argv[1]` 是不是本工具 cli.mjs 入口。
 *
 * 真实生产态:`<npm global>/.../ai-productivity-tracker/cli/dist/cli.mjs`
 *           或本仓库 dev 态 `packages/cli/dist/cli.mjs`、`packages/cli/src/index.ts`
 *
 * 测试态(vitest):`process.argv[1]` 通常指向 vitest 自身 → 判定为否,走 fallback
 * 保持老路径不变,避免每个测试都要 mock argv。
 */
function looksLikeAiptCliEntry(entry: string): boolean {
  // 入口必须有 cli 字样,且属于本工具的 cli 包或 ai-productivity-tracker 路径
  return (
    /(\/|\\)cli\.(mjs|js)$/.test(entry) ||
    /ai-productivity-tracker[\\/]cli[\\/]/.test(entry) ||
    /packages[\\/]cli[\\/](dist|src)[\\/]/.test(entry)
  )
}

/**
 * v2.13.0 解析本地 mcp.mjs 的版本号.
 *
 * `packages/ai-productivity-mcp/build.mjs` 在 banner 写入固定标记
 * `// __AI_PRODUCTIVITY_MCP_VERSION__: X.Y.Z`(v2.13.0 起),agent 用稳定正则提取.
 * 仅读文件前 4KB,远超 banner 实际长度,避免大文件全量加载.
 *
 * 不依赖 esbuild emit 的 `VERSION = true ? "X.Y.Z"`(emission 风格未来可能变),
 * 也不依赖 `running (v...)` runtime 日志(版本字符串可能被多次复用).
 *
 * 老版本(v2.12.x 及之前 build 的 .mjs)无 banner marker,返回 null,
 * 前端展示「本地: 未知(可能是 ≤ 0.1.11 旧版本)」并提示用户重新下载.
 */
function readMcpEntryVersion(filePath: string): string | null {
  if (!existsSync(filePath)) return null
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.slice(0, n).toString('utf-8')
    const m = /__AI_PRODUCTIVITY_MCP_VERSION__:\s*([0-9][\w.\-+]*)/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export interface CursorHookStatusResponse {
  /** v2.2.0 起,Hook 入口 = MCP .mjs;字段名沿用 `hookEntryInstalled`(更准确) */
  hookEntryInstalled: boolean
  hookEntryPath: string
  /**
   * v2.13.0 本地 mcp.mjs 解析出的版本号(从 banner marker `// __AI_PRODUCTIVITY_MCP_VERSION__: X.Y.Z` 提取);
   * 文件不存在 / 无 marker(v2.12.x 及之前 build 的老 .mjs) → null,前端展示「未知」并引导重新下载.
   */
  hookEntryVersion: string | null
  /** v2.1.x 兼容别名;与 hookEntryInstalled 同值,前端切完后可移除 */
  cliInstalled: boolean
  /** v2.1.x 兼容别名 */
  cliPath: string
  hooksFileExists: boolean
  hookInstalled: boolean
  hookCommand: string | null
  debugMode: boolean
  /** hooks.json 里仍残留老 CLI(~/.local/bin/ai-productivity) 路径,前端提示「将被覆盖」 */
  legacyHookDetected: boolean
}

export function handleAiProductivityCursorHookStatus(res: ServerResponse): void {
  const hookEntryPath = defaultHookEntryPath()
  const hookEntryInstalled = existsSync(hookEntryPath)
  const hookEntryVersion = hookEntryInstalled ? readMcpEntryVersion(hookEntryPath) : null
  const hooksPath = defaultCursorHooksPath()
  const inspect: CursorHookInspectResult = inspectCursorHook(hooksPath)

  ok(res, {
    hookEntryInstalled,
    hookEntryPath,
    hookEntryVersion,
    cliInstalled: hookEntryInstalled,
    cliPath: hookEntryPath,
    hooksFileExists: inspect.hooksFileExists,
    hookInstalled: inspect.hookInstalled,
    hookCommand: inspect.hookCommand,
    debugMode: inspect.debugMode,
    legacyHookDetected: inspect.legacyHookDetected
  } satisfies CursorHookStatusResponse)
}

export interface InstallCursorHookRequestBody {
  debug?: boolean
  /**
   * v1.0 由 cli/install.ts 显式传入的 hook entry 绝对路径(通常 = npm 全局
   * 安装的 cli.mjs 路径,如 `/usr/local/lib/node_modules/@.../dist/cli.mjs`)。
   *
   * 不传时退回到 `defaultHookEntryPath()`,该路径在源仓库 v2.x 指向
   * `~/Downloads/ai-productivity-mcp.mjs`(手动下载模式,已下线)。
   */
  hookEntry?: string
}

export interface InstallCursorHookResponse {
  ok: boolean
  hookEntryPath: string
  /** v2.1.x 兼容别名 */
  cliPath: string
  hooksPath: string
  /** 注入完成后写入 hooks.json 的完整 command 字符串(含 marker、可能含 debug 前缀) */
  finalCommand: string
  /** 是否替换了已有的 marker 条目 */
  replaced: boolean
  /** 被替换前的老 command 字符串(若 replaced=true) */
  previousCommand: string | null
  errorMessage?: string
}

export interface InstallCursorHookDeps {
  /** 测试注入: 覆盖默认 hook 入口 .mjs 路径 */
  hookEntryPath?: string
  /** 测试注入: 覆盖默认 hooks.json 路径 */
  hooksPath?: string
  /** 测试注入: 覆盖 .mjs 存在性校验 */
  hookEntryExists?: (path: string) => boolean
  /** 测试注入: 覆盖写盘逻辑 */
  install?: typeof installCursorHookFile
}

export async function handleAiProductivityInstallCursorHook(
  res: ServerResponse,
  body: InstallCursorHookRequestBody | null,
  deps: InstallCursorHookDeps = {}
): Promise<void> {
  // v1.0 优先用 cli/install.ts 通过 body.hookEntry 传入的绝对路径(npm 全局 cli.mjs 位置)
  // 退回到 default 仅作为老用户兜底(指向 ~/Downloads/ai-productivity-mcp.mjs,
  // v2.x 手动下载模式已下线,此 fallback 仅给 web UI 等极少数无 cli 上下文的调用方)
  const hookEntryPath = deps.hookEntryPath ?? body?.hookEntry ?? defaultHookEntryPath()
  const hooksPath = deps.hooksPath ?? defaultCursorHooksPath()
  const entryExists = deps.hookEntryExists ?? existsSync

  if (!entryExists(hookEntryPath)) {
    fail(
      res,
      412,
      `未找到 MCP/Hook 入口: ${hookEntryPath}。请确认已通过 \`npm i -g @ai-productivity-tracker/cli\` 全局安装,或显式传 hookEntry 字段。`
    )
    return
  }

  // 用 process.execPath(当前 node 二进制的绝对路径)而不是 'node':
  // Cursor / Claude Code 从 macOS launchd 启动 hook 子进程时 PATH 只有系统默认,
  // nvm/volta/fnm 装的 node 不在里面,会触发 ENOENT。
  const nodeBin = process.execPath
  const installFn = deps.install ?? installCursorHookFile
  try {
    const result: InstallCursorHookResult = installFn({
      command: `${nodeBin} ${hookEntryPath} hook`,
      debug: body?.debug ?? false,
      hooksPath
    })
    ok(res, {
      ok: true,
      hookEntryPath,
      cliPath: hookEntryPath,
      hooksPath: result.hooksPath,
      finalCommand: result.finalCommand,
      replaced: result.replaced,
      previousCommand: result.previousCommand
    } satisfies InstallCursorHookResponse)
  } catch (err) {
    const e = err as { message?: string }
    ok(res, {
      ok: false,
      hookEntryPath,
      cliPath: hookEntryPath,
      hooksPath,
      finalCommand: '',
      replaced: false,
      previousCommand: null,
      errorMessage: e.message ?? '写入 hooks.json 失败'
    } satisfies InstallCursorHookResponse)
  }
}

// ────────────────────────────────────────────────────────────────────
// MCP 单文件 .mjs 一键下载 (Web 看板 → agent 本地落盘)
//
// 浏览器侧 fetch 同源静态 .mjs → base64 POST 进 body;agent 仅负责
// 解码 + 写到 defaultHookEntryPath()(~/Downloads/ai-productivity-mcp.mjs)
// + chmod 0o755。这样既保持「agent 不主动出网」的设计,又免除用户
// 手动 curl 步骤,装完即可与 install-cursor-hook 衔接。
// ────────────────────────────────────────────────────────────────────

const MCP_ENTRY_MAX_BYTES = 2 * 1024 * 1024
const MCP_ENTRY_SANITY_TOKENS = ['ai-productivity-mcp', 'modelcontextprotocol']

export interface InstallMcpEntryRequestBody {
  contentBase64?: string
}

export interface InstallMcpEntryResponse {
  ok: true
  path: string
  bytesWritten: number
  replaced: boolean
}

export interface InstallMcpEntryDeps {
  /** 测试注入: 覆盖默认 .mjs 落盘路径 */
  targetPath?: string
  /** 测试注入: 覆盖文件存在性检查 */
  exists?: (path: string) => boolean
  /** 测试注入: 覆盖目录创建 */
  ensureDir?: (path: string) => void
  /** 测试注入: 覆盖写盘逻辑(content,path,mode) */
  writeFile?: (path: string, content: Buffer, mode: number) => void
}

export async function handleAiProductivityInstallMcpEntry(
  res: ServerResponse,
  body: InstallMcpEntryRequestBody | null,
  deps: InstallMcpEntryDeps = {}
): Promise<void> {
  const target = deps.targetPath ?? defaultHookEntryPath()
  const exists = deps.exists ?? existsSync

  const contentBase64 = body?.contentBase64
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    fail(res, 400, 'contentBase64 必填,且必须为非空字符串')
    return
  }

  let buf: Buffer
  try {
    buf = Buffer.from(contentBase64, 'base64')
  } catch {
    fail(res, 400, 'contentBase64 解码失败')
    return
  }
  if (buf.length === 0) {
    fail(res, 400, 'contentBase64 解码后为空')
    return
  }
  if (buf.length > MCP_ENTRY_MAX_BYTES) {
    fail(res, 413, `mjs 体积超出限制 (${buf.length} > ${MCP_ENTRY_MAX_BYTES})`)
    return
  }

  const hit = MCP_ENTRY_SANITY_TOKENS.some((token) => buf.includes(token, 0, 'utf8'))
  if (!hit) {
    fail(res, 400, '上传内容不像 ai-productivity-mcp.mjs(全文未命中签名)')
    return
  }

  try {
    const ensureDir = deps.ensureDir ?? ((p: string) => mkdirSync(p, { recursive: true }))
    ensureDir(dirname(target))
    const replaced = exists(target)
    const writeFile =
      deps.writeFile ??
      ((p: string, c: Buffer, mode: number) => {
        writeFileSync(p, c)
        chmodSync(p, mode)
      })
    writeFile(target, buf, 0o755)
    ok(res, {
      ok: true,
      path: target,
      bytesWritten: buf.length,
      replaced
    } satisfies InstallMcpEntryResponse)
  } catch (err) {
    const e = err as { message?: string }
    fail(res, 500, e?.message ?? '写入 ai-productivity-mcp.mjs 失败')
  }
}

// ────────────────────────────────────────────────────────────────────
// Panel 读端点 (Web 看板, origin 放行)
// ────────────────────────────────────────────────────────────────────

function buildRequirementListResponse() {
  const formula = readFormula()
  const requirements = listRequirementsFromStore()
  return requirements.map((req) => buildSummaryView(req, listIterations(req.jiraKey), formula))
}

export function handleAiProductivityListRequirements(
  res: ServerResponse,
  filter: { owner?: string; status?: string; project?: string; q?: string }
): void {
  let list = buildRequirementListResponse()
  if (filter.owner) list = list.filter((it) => it.owner === filter.owner)
  if (filter.status) list = list.filter((it) => it.status === filter.status)
  if (filter.project) list = list.filter((it) => it.projectSlug === filter.project)
  if (filter.q) {
    const k = filter.q.toLowerCase()
    list = list.filter(
      (it) =>
        it.jiraKey.toLowerCase().includes(k) ||
        it.title.toLowerCase().includes(k) ||
        it.owner.toLowerCase().includes(k) ||
        it.projectSlug.toLowerCase().includes(k)
    )
  }
  ok(res, list)
}

export function handleAiProductivityGetRequirement(res: ServerResponse, jiraKey: string): void {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const formula = readFormula()
  const iterations = listIterations(jiraKey)
  const summary = buildSummaryView(requirement, iterations, formula)
  ok(res, { ...summary, iterations })
}

export function handleAiProductivityListIterations(res: ServerResponse, jiraKey: string): void {
  if (!loadRequirement(jiraKey)) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  ok(res, listIterations(jiraKey))
}

export function handleAiProductivitySummary(res: ServerResponse): void {
  const views = buildRequirementListResponse()
  ok(res, buildOverallSummary(views))
}

export function handleAiProductivityGetFormula(res: ServerResponse): void {
  ok(res, readFormula())
}

export function handleAiProductivityGetJiraConfig(res: ServerResponse): void {
  const c = readJiraConfig()
  ok(res, {
    configured: isJiraConfigured(c),
    baseUrl: c.baseUrl,
    apiEmail: c.apiEmail,
    bugJqlTemplate: c.bugJqlTemplate
  })
}

export function handleAiProductivityStoragePath(res: ServerResponse): void {
  ok(res, { root: aipRoot() })
}

// ────────────────────────────────────────────────────────────────────
// Panel 写端点 (Web 看板, origin 放行)
// ────────────────────────────────────────────────────────────────────

export interface PatchRequirementBody {
  status?: 'in_progress' | 'finished' | 'abandoned'
  title?: string
  summary?: string
  manualEstimateMinutes?: number
  complexity?: 'low' | 'medium' | 'high'
}

export function handleAiProductivityPatchRequirement(
  res: ServerResponse,
  jiraKey: string,
  body: PatchRequirementBody
): void {
  const existing = loadRequirement(jiraKey)
  if (!existing) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const patch: UpdateRequirementPatch = {}
  if (body.status) patch.status = body.status
  if (typeof body.title === 'string') patch.title = body.title
  if (typeof body.summary === 'string') patch.summary = body.summary
  if (typeof body.manualEstimateMinutes === 'number')
    patch.manualEstimateMinutes = body.manualEstimateMinutes
  if (body.complexity) patch.complexity = body.complexity

  const next = updateRequirement(jiraKey, patch)
  ok(res, { jiraKey: next.jiraKey, status: next.status })
}

export interface PatchSubtaskBody {
  done: boolean
  /** UI 触发的勾选记录为 manual,CLI/skill 路径记为 skill */
  source?: 'skill' | 'manual'
}

export function handleAiProductivityPatchSubtask(
  res: ServerResponse,
  jiraKey: string,
  subtaskId: string,
  body: PatchSubtaskBody
): void {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }
  const subtasks = (requirement.subtasks ?? []).map((s) => ({ ...s }))
  const target = subtasks.find((s) => s.id === subtaskId)
  if (!target) {
    fail(res, 404, `subtask ${subtaskId} 未找到`)
    return
  }

  const next = Boolean(body.done)
  if (target.done !== next) {
    appendSubtaskEvent(jiraKey, {
      subtaskId,
      fromDone: target.done,
      toDone: next,
      source: body.source === 'skill' ? 'skill' : 'manual'
    })
    target.done = next
    target.doneAt = next ? new Date().toISOString() : null
  }

  const updated = updateRequirement(jiraKey, { subtasks })
  ok(res, { updated: true, subtasks: updated.subtasks })
}

export interface RefreshBugsBody {
  jql?: string
}

export interface RefreshBugsDeps {
  fetchImpl?: typeof fetch
}

export async function handleAiProductivityRefreshBugs(
  res: ServerResponse,
  jiraKey: string,
  body: RefreshBugsBody,
  deps: RefreshBugsDeps = {}
): Promise<void> {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }

  const config = readJiraConfig()
  if (!isJiraConfigured(config)) {
    fail(res, 400, '尚未配置 Jira 凭证,请前往设置页填写 Jira baseUrl/apiEmail/apiToken')
    return
  }

  // v2.15.2 三层 jql 兜底:body.jql → requirement.linkedBugJql → config.bugJqlTemplate
  // 旧实现用 `??` 短路,遇到 `requirement.linkedBugJql === ''` 不回退,导致全局 bugJqlTemplate
  // 永远不被采用 → 空 jql 传给 Atlassian → 400 unbounded。改为「空白都回退」+ 都空 400 引导。
  const rawTemplate =
    [body?.jql, requirement.linkedBugJql, config.bugJqlTemplate]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .find((value) => value.length > 0) ?? ''

  if (!rawTemplate) {
    fail(
      res,
      400,
      'Jira Bug JQL 模板未配置,请前往「业务配置」Tab 的「Jira 查询凭证」卡片填写「Bug JQL 模板」'
    )
    return
  }

  // 渲染 {{jiraKey}} 占位符后再追加 bounded 兜底(Atlassian 新接口硬约束)
  const jql = ensureBoundedJql(renderJqlTemplate(rawTemplate, jiraKey), jiraKey)

  try {
    const total = await fetchJiraBugTotal(config, jql, deps.fetchImpl)
    const refreshedAt = new Date().toISOString()
    const updated = updateRequirement(jiraKey, {
      linkedBugCount: total,
      linkedBugJql: jql,
      bugsRefreshedAt: refreshedAt
    })
    ok(res, {
      linkedBugCount: updated.linkedBugCount,
      linkedBugJql: updated.linkedBugJql,
      bugsRefreshedAt: updated.bugsRefreshedAt
    })
  } catch (err) {
    if (err instanceof JiraBugFetchError) {
      fail(res, err.status >= 400 && err.status < 600 ? err.status : 502, err.message)
      return
    }
    fail(res, 500, err instanceof Error ? err.message : '未知错误')
  }
}

export interface SyncJiraTitleResponse {
  title: string
  source: 'jira'
}

export interface SyncJiraTitleDeps {
  fetchImpl?: typeof fetch
}

/**
 * v2.14.0 用 agent 已存的 Jira 凭证拉真实 issue summary,写回 requirement.title。
 *
 * 设计目的:
 * - 弥补「init 时 LLM 没传 title + agent 未配 Jira → 标题落成 jiraKey」的历史脏数据
 * - 也作为 Workspace Tab「openDetail 检测 title===jiraKey 时静默后台兜底」的入口
 *
 * v2.14.2 改用 inspectJiraIssueSummary 按 reason 输出细分 status & 文案,
 * 不再让用户对着"无法从 Jira 拉取..."统一兜底文案猜根因。
 */
export async function handleAiProductivitySyncJiraTitle(
  res: ServerResponse,
  jiraKey: string,
  deps: SyncJiraTitleDeps = {}
): Promise<void> {
  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到`)
    return
  }

  const config = readJiraConfig()
  if (!isJiraConfigured(config)) {
    fail(
      res,
      422,
      '尚未配置 Jira 凭证,请先到「AI 提效面板 → 配置」Tab 填写 Jira baseUrl/apiEmail/apiToken'
    )
    return
  }

  const result = await inspectJiraIssueSummary(config, jiraKey, deps.fetchImpl)
  if (!result.ok) {
    const { status, message } = mapJiraSummaryReason(result.reason, jiraKey, result.status)
    fail(res, status, message)
    return
  }

  const updated = updateRequirement(jiraKey, { title: result.summary })
  ok(res, { title: updated.title, source: 'jira' } satisfies SyncJiraTitleResponse)
}

function mapJiraSummaryReason(
  reason: JiraIssueSummaryReason,
  jiraKey: string,
  upstreamStatus?: number
): { status: number; message: string } {
  switch (reason) {
    case 'not_configured':
      return {
        status: 422,
        message:
          '尚未配置 Jira 凭证,请先到「AI 提效面板 → 配置」Tab 填写 Jira baseUrl/apiEmail/apiToken'
      }
    case 'empty_jira_key':
      return { status: 400, message: 'jiraKey 不能为空' }
    case 'invalid_url':
      return {
        status: 422,
        message:
          'Jira Base URL 无效,请检查是否包含 https:// 协议前缀(例如 https://yourorg.atlassian.net)'
      }
    case 'unauthorized':
      return {
        status: 401,
        message:
          'Jira 鉴权失败,请确认 API Email/Token 正确(可在 Atlassian 账户安全页重新生成 Token)'
      }
    case 'forbidden':
      return {
        status: 403,
        message: `Jira 凭证无权访问 ${jiraKey},请联系管理员开通对应项目权限`
      }
    case 'not_found':
      return {
        status: 404,
        message: `Jira 上未找到 ${jiraKey},请确认 issue key 与所在站点(baseUrl)是否匹配`
      }
    case 'http_error':
      return {
        status: 502,
        message: `Jira REST 调用失败:${upstreamStatus ?? 'unknown'},请稍后重试或检查 Jira 服务状态`
      }
    case 'network_error':
      return {
        status: 502,
        message: 'Jira 网络异常(DNS / 超时 / 证书),请检查 baseUrl 与本机网络/代理设置'
      }
    case 'invalid_json':
      return {
        status: 502,
        message: 'Jira 响应不是合法 JSON,baseUrl 可能指向了错误的站点'
      }
    case 'empty_summary':
      return {
        status: 422,
        message: `Jira 返回的 ${jiraKey} summary 为空,请在 Jira 上完善标题后再同步`
      }
    default:
      return {
        status: 502,
        message: `无法从 Jira 拉取 ${jiraKey} 的 summary,请稍后重试`
      }
  }
}

export function handleAiProductivityPatchFormula(
  res: ServerResponse,
  body: Partial<FormulaSettings>
): void {
  const next = writeFormula(body ?? {})
  ok(res, next)
}

export function handleAiProductivityPatchJiraConfig(
  res: ServerResponse,
  body: Partial<JiraStoredConfig>
): void {
  const next = writeJiraConfig(body ?? {})
  ok(res, {
    configured: isJiraConfigured(next),
    baseUrl: next.baseUrl,
    apiEmail: next.apiEmail,
    bugJqlTemplate: next.bugJqlTemplate
  })
}

// ────────────────────────────────────────────────────────────────────
// v2.4.0 软数据通道:对话总结 attach + Track Skill 一键注入
// ────────────────────────────────────────────────────────────────────

export type AttachSummaryConversationType = 'coding' | 'communication'

export interface AttachSummaryRequestBody {
  /** 优先级最高;缺省时尝试从 branch 解析 */
  jiraKey?: string
  /** 当 jiraKey 缺省时用 branch 解析 issueKey */
  branch?: string
  /** 一句话总结,≤120 字 */
  oneLine?: string
  /** 对话类型:coding=代码改动,communication=纯沟通 */
  type?: AttachSummaryConversationType
  /** 改动范围(coding 时必填) */
  changeScope?: string
  /** 讨论内容(communication 时必填) */
  discussion?: string
  /**
   * v2.5.0 调用方 AI 工具来源;由 skill 模板硬编码(SKILL.md 传 'claude-code',
   * CURSOR_RULE.md 传 'cursor')。仅在 target iteration.source 为 'unknown' 时补写。
   */
  source?: 'cursor' | 'claude-code'
  /**
   * v2.5.1 当前工作目录;jiraKey/branch 都缺时,agent 用 cwd 取当前分支或
   * 该 git 仓库 bindings.json 里最近活跃的需求兜底。
   */
  cwd?: string
  /** v2.3.x 兼容字段:旧 skill 仍可能上传单字符串总结 */
  conversationSummary?: string
}

export interface AttachSummaryResponse {
  ok: true
  /** v2.7.0 起 happy path 恒为 true;v2.13.0 起 skipped 场景为 false */
  updated: boolean
  /**
   * v2.7.0:对话总结现在写入 `<jiraKey>/pending-summary.json` 中间态,
   * 待下一条 hook/watcher 触发的 iteration 写盘时被消费并挂到该 iteration 上。
   * `pending: true` 表示已经成功落 pending 文件(等价旧 `updated: true`)。
   */
  pending: boolean
  /**
   * v2.13.0 新增:LLM 在非 Jira 分支误调时,daemon 不再返 4xx,改为返
   * `200 { ok:true, skipped:true, reason:'no_jira_key', jiraKey:'' }`,
   * 让 IDE 工具面板不再标红失败。仅在 skipped=true 时 `reason='no_jira_key'`。
   */
  skipped?: boolean
  /** skipped=true 时为空串;happy path 为实际 jiraKey */
  jiraKey: string
  /** v2.7.0 起恒为 null:总结由下一条 iteration 接管,seq 在 attach 调用时尚未确定 */
  iterationSeq: number | null
  /** 'write_failed':jiraKey 解析成功但写盘失败;'no_jira_key':v2.13.0 兜底,非 Jira 分支误调 */
  reason?: 'write_failed' | 'no_jira_key'
}

const ONE_LINE_MAX = 120
const CHANGE_SCOPE_MAX = 120
const DISCUSSION_MAX = 300
const LEGACY_SUMMARY_MAX = 4000

interface ResolvedSummary {
  oneLine: string
  type: AttachSummaryConversationType
  changeScope?: string
  discussion?: string
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * v2.13.2 软截断:超长字段不再返回 400,改为静默 trim 到 max,console.info 记一行便于排查.
 *
 * 背景:zod max 校验放在 MCP 层时,LLM 第一次写超就直接 too_big 失败,触发 Stop Hook
 * `inject_followup` 强制重答,Claude Code 因协议把 reason 注入为新 user 行而产生双 iteration,
 * Cursor 因 followup_message 是同 turn 续答而吞掉表象但 LLM 仍多花一份 token.放宽到 agent
 * 端 graceful truncate,LLM 第一次就成功 → sentinel 同步落盘 → Stop Hook 直接放行.
 */
function softTrim(value: string, max: number, field: string): string {
  if (value.length <= max) return value
  console.info(`[attach_summary] ${field} truncated from ${value.length} to ${max}`)
  return value.slice(0, max)
}

/**
 * 解析入参为结构化总结。优先使用新字段,缺省时 fallback 到老 `conversationSummary` 字符串。
 *
 * v2.13.3 软兜底:除 `oneLine` 必填外,其它字段缺失一律不返回 400,改为本地兜底 + 走 200。
 * 背景:LLM 自动触发场景下经常漏填 `discussion` / `changeScope`,或把 `type` 写成 undefined 等
 * 非法值,导致 zod / agent 校验失败 → sentinel 没写 → Stop Hook 强制重答 → 看板双 iteration。
 * 字段缺失的代价(总结质量下降一档)远比"双 iteration + 空白条"小。
 *
 * 返回 string 表示校验失败(仅在彻底没有 oneLine 也没有 legacy summary 时),返回对象表示通过。
 */
function resolveAttachSummary(body: AttachSummaryRequestBody | null): ResolvedSummary | string {
  const oneLine = trimString(body?.oneLine)
  const rawType = trimString(body?.type)
  const changeScope = trimString(body?.changeScope)
  const discussion = trimString(body?.discussion)
  const legacySummary = trimString(body?.conversationSummary)

  // 新字段优先(只要有任一新字段就走新路径,兜底缺失字段)
  if (oneLine || rawType || changeScope || discussion) {
    if (!oneLine) return 'oneLine 不能为空'
    // v2.13.3 type 缺失 / 非法 → 默认 communication
    let resolvedType: AttachSummaryConversationType
    if (rawType === 'coding' || rawType === 'communication') {
      resolvedType = rawType
    } else {
      if (rawType) {
        console.info(`[attach_summary] type defaulted to communication (received "${rawType}")`)
      } else {
        console.info('[attach_summary] type defaulted to communication (missing)')
      }
      resolvedType = 'communication'
    }
    const trimmedOneLine = softTrim(oneLine, ONE_LINE_MAX, 'oneLine')
    // v2.13.3 type=coding 缺 changeScope → 用 oneLine 兜底;type=communication 缺 discussion 同理
    let resolvedChangeScope = changeScope
    let resolvedDiscussion = discussion
    if (resolvedType === 'coding' && !resolvedChangeScope) {
      console.info('[attach_summary] changeScope filled from oneLine (missing)')
      resolvedChangeScope = oneLine
    }
    if (resolvedType === 'communication' && !resolvedDiscussion) {
      console.info('[attach_summary] discussion filled from oneLine (missing)')
      resolvedDiscussion = oneLine
    }
    const trimmedChangeScope = resolvedChangeScope
      ? softTrim(resolvedChangeScope, CHANGE_SCOPE_MAX, 'changeScope')
      : ''
    const trimmedDiscussion = resolvedDiscussion
      ? softTrim(resolvedDiscussion, DISCUSSION_MAX, 'discussion')
      : ''
    return {
      oneLine: trimmedOneLine,
      type: resolvedType,
      ...(resolvedType === 'coding'
        ? { changeScope: trimmedChangeScope }
        : { discussion: trimmedDiscussion })
    }
  }

  // 兼容老 v2.3.x skill:整段字符串 → 包装成 communication
  if (legacySummary) {
    if (legacySummary.length > LEGACY_SUMMARY_MAX) {
      return `conversationSummary 超出长度上限 ${LEGACY_SUMMARY_MAX} 字符`
    }
    return {
      oneLine:
        legacySummary.length > ONE_LINE_MAX ? legacySummary.slice(0, ONE_LINE_MAX) : legacySummary,
      type: 'communication',
      discussion:
        legacySummary.length > DISCUSSION_MAX
          ? legacySummary.slice(0, DISCUSSION_MAX)
          : legacySummary
    }
  }

  return '缺少对话总结字段(oneLine + type + changeScope/discussion)'
}

export async function handleAiProductivityAttachSummary(
  res: ServerResponse,
  body: AttachSummaryRequestBody | null
): Promise<void> {
  const resolved = resolveAttachSummary(body)
  if (typeof resolved === 'string') {
    fail(res, 400, resolved)
    return
  }

  let jiraKey = typeof body?.jiraKey === 'string' ? body.jiraKey.trim().toUpperCase() : ''
  let resolveVia: 'explicit' | 'branch' | 'cwd_branch' | 'active_binding' = jiraKey
    ? 'explicit'
    : 'explicit'
  if (!jiraKey && typeof body?.branch === 'string') {
    const parsed = extractIssueKey(body.branch)
    if (parsed) {
      jiraKey = parsed
      resolveVia = 'branch'
    }
  }
  const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
  // v2.5.1 兜底:基于 cwd 取当前 git 分支再解析 issueKey
  if (!jiraKey && cwd) {
    const branchFromCwd = getCurrentBranch(cwd)
    if (branchFromCwd) {
      const parsed = extractIssueKey(branchFromCwd)
      if (parsed) {
        jiraKey = parsed
        resolveVia = 'cwd_branch'
      }
    }
  }
  // v2.5.1 兜底:基于 cwd 找 git 仓库下 bindings.json 的最近活跃需求
  if (!jiraKey && cwd) {
    const active = resolveActiveBindingByCwd(cwd)
    if (active?.jiraKey) {
      jiraKey = active.jiraKey
      resolveVia = 'active_binding'
    }
  }
  if (!jiraKey) {
    // v2.13.0 收紧非 Jira 分支触发(用户反馈:noise 主要来自 Cursor 工具面板红色失败):
    //   - 老行为:HTTP 400 + "无法推断当前追踪需求" → MCP 客户端拿到 isError=true,工具面板标红
    //   - 新行为:HTTP 200 + skipped:true + reason='no_jira_key',工具面板不再标红
    //   - 这只是「LLM 已经误调了 → 不让用户看到红色」的兜底防御,真正的硬约束在
    //     rule/skill 模板 + MCP tool description 层,要求 LLM 在分支不含 Jira key 时根本不调
    console.info('[attach_summary] skipped: no jira key resolvable from request / cwd')
    ok(res, {
      ok: true,
      updated: false,
      pending: false,
      skipped: true,
      jiraKey: '',
      iterationSeq: null,
      reason: 'no_jira_key'
    } satisfies AttachSummaryResponse)
    return
  }
  if (resolveVia !== 'explicit') {
    console.info(`[attach_summary] jiraKey resolved via ${resolveVia}: ${jiraKey}`)
  }

  const requirement = loadRequirement(jiraKey)
  if (!requirement) {
    fail(res, 404, `需求 ${jiraKey} 未在 AI 提效面板初始化`)
    return
  }

  const { writePendingSummary } = await import('@ai-productivity-tracker/core/store')
  const rawSource = typeof body?.source === 'string' ? body.source.trim() : ''
  const source = rawSource === 'cursor' || rawSource === 'claude-code' ? rawSource : undefined

  // v2.7.0 attach-summary 改写为 pending consume 模型:
  // 把总结写入 <jiraKey>/pending-summary.json,等下一条 hook/watcher 触发的 iteration
  // 落盘时由 appendIteration 同步消费并挂到该 iteration 上 ─ 总结自然对齐"本轮"。
  const pending = writePendingSummary(jiraKey, resolved, source)
  if (!pending) {
    ok(res, {
      ok: true,
      updated: false,
      pending: false,
      jiraKey,
      iterationSeq: null,
      reason: 'write_failed'
    } satisfies AttachSummaryResponse)
    return
  }

  // v2.10.0 同步落 jiraKey 维度 sentinel:
  // 让本机 stop-check 在 LLM 答复结束触发时立即看到「本轮真调过 attach_summary」凭证。
  // 老链路依赖 Cursor afterMCPExecution Hook(fire-and-forget,跨进程时序不可控)
  // 写 conv-gen 维度 sentinel,实测漏写概率高,导致 followup_message 强制重答 + 重复上报。
  // 改为同进程同步写,sentinel 必定在 attach_summary HTTP 返回前落盘。
  // 失败仅 warn,不阻塞主流程(降级回退到老的"无 sentinel→注入 followup"行为,与 v2.9.x 一致)。
  try {
    const { writeRecentAttachSentinel } = await import('@ai-productivity-tracker/core/store')
    const written = writeRecentAttachSentinel(jiraKey)
    if (!written) {
      console.warn(`[attach_summary] 落 recent-attach sentinel 失败 jiraKey=${jiraKey}`)
    }
  } catch (err) {
    console.warn('[attach_summary] 写 recent-attach sentinel 异常:', err)
  }

  ok(res, {
    ok: true,
    updated: true,
    pending: true,
    jiraKey,
    iterationSeq: null
  } satisfies AttachSummaryResponse)
}

/**
 * v2.6.0 Claude Code UserPromptSubmit Hook 状态.
 * 仅在 SKILL.md 已安装通路存在.installed=false 时 upToDate 也为 false.
 */
export interface ClaudeTrackHookStatusResponse {
  path: string
  installed: boolean
  upToDate: boolean
  currentCommand: string | null
}

export interface TrackSkillStatusResponse {
  version: string
  claude: {
    defaultPath: string
    installed: boolean
    upToDate: boolean
    outdated: boolean
    hook: ClaudeTrackHookStatusResponse
  }
  cursor: { defaultPath: string; installed: boolean; upToDate: boolean; outdated: boolean }
}

export async function handleAiProductivityTrackSkillStatus(res: ServerResponse): Promise<void> {
  const { inspectAiTrackSkillBundle } = await import('../skill-sync.js')
  const status = await inspectAiTrackSkillBundle()
  ok(res, status satisfies TrackSkillStatusResponse)
}

export interface ClaudeTrackHookInstallResponse {
  path: string
  replaced: boolean
  previousCommand: string | null
  finalCommand: string
}

export interface InstallTrackSkillResponse {
  ok: true
  version: string
  claude: {
    path: string
    written: boolean
    replaced: boolean
    hook: ClaudeTrackHookInstallResponse
  }
  cursor: { path: string; written: boolean; replaced: boolean }
  /**
   * v2.16.0:复用「一键注入 Skill」按钮一并装入 lessons-extract skill 的结果(无 Hook)。
   * 老前端不读该字段 → undefined 也不影响;新前端可据此提示「同步装了 lessons-extract」。
   */
  lessonsExtract?: {
    version: string
    claude: { path: string; written: boolean; replaced: boolean }
    cursor: { path: string; written: boolean; replaced: boolean }
  }
}

export async function handleAiProductivityInstallTrackSkill(res: ServerResponse): Promise<void> {
  try {
    const { installAiTrackSkillBundle } = await import('../skill-sync.js')
    const result = await installAiTrackSkillBundle()
    ok(res, {
      ok: true,
      version: result.version,
      claude: result.claude,
      cursor: result.cursor,
      lessonsExtract: result.lessonsExtract
    } satisfies InstallTrackSkillResponse)
  } catch (err) {
    const e = err as { message?: string }
    fail(res, 500, e?.message ?? '注入 Track Skill 失败')
  }
}

// ────────────────────────────────────────────────────────────────────
// v2.16.0 P0 经验沉淀(lessons) 端点
// ────────────────────────────────────────────────────────────────────

/**
 * 看板侧 GET /ai-productivity/lessons (panel-origin 放行)
 *
 * 返回 INDEX.json 的投影列表;支持 jiraKey / type / tag / q / scope / projectSlug 客户端过滤。
 * v2.17.0 新增 scope='general'|'project'|'unscoped' 与 projectSlug 精确匹配。
 */
export function handleAiProductivityListLessons(
  res: ServerResponse,
  filter: {
    jiraKey?: string
    type?: string
    tag?: string
    q?: string
    scope?: string
    projectSlug?: string
  }
): void {
  const type =
    filter.type && (LESSON_TYPES as readonly string[]).includes(filter.type)
      ? (filter.type as LessonType)
      : undefined
  const rawScope = filter.scope?.trim() ?? ''
  const scope: 'general' | 'project' | 'unscoped' | undefined =
    rawScope === 'general' || rawScope === 'project' || rawScope === 'unscoped'
      ? rawScope
      : undefined
  const items = listLessons({
    jiraKey: filter.jiraKey?.trim() || undefined,
    type,
    tag: filter.tag?.trim() || undefined,
    q: filter.q?.trim() || undefined,
    scope,
    projectSlug: filter.projectSlug?.trim() || undefined
  })
  ok(res, items)
}

/**
 * 看板侧 GET /ai-productivity/lessons/:id (panel-origin 放行)
 *
 * 返回单条经验完整内容。
 */
export function handleAiProductivityGetLesson(res: ServerResponse, id: string): void {
  if (!isValidLessonId(id)) {
    fail(res, 400, `非法 lessonId: ${id}`)
    return
  }
  const lesson = loadLesson(id)
  if (!lesson) {
    fail(res, 404, `经验 ${id} 未找到`)
    return
  }
  ok(res, lesson)
}

/**
 * 看板侧 DELETE /ai-productivity/lessons/:id (panel-origin 放行)
 */
export function handleAiProductivityDeleteLesson(res: ServerResponse, id: string): void {
  if (!isValidLessonId(id)) {
    fail(res, 400, `非法 lessonId: ${id}`)
    return
  }
  const removed = removeLesson(id)
  if (!removed) {
    fail(res, 404, `经验 ${id} 未找到或已被删除`)
    return
  }
  ok(res, { deleted: true, id })
}

/**
 * lessons-extract skill 拉取数据包: GET /ai-productivity/requirements/:jiraKey/lessons-bundle
 *
 * **panel-origin 放行**(便于将来 Web 看板「重新提取」按钮直接消费;skill 通过 MCP 走 token 鉴权也可)。
 *
 * v2.17.0 返回结构追加 `currentProjectSlug` 字段(来自 requirement.projectSlug = package.json name),
 * existingLessons 已过滤为「通用 + 当前项目」,LLM 据此判断 scope='general'|'project' 并填 projectSlug。
 *
 * 注意:返回的 iterations 已经是经过 normalize 的 StoredIteration 列表,LLM 直接消费即可。
 */
export function handleAiProductivityLessonsBundle(res: ServerResponse, jiraKey: string): void {
  const bundle = buildLessonsBundle(jiraKey)
  if (!bundle.requirement) {
    fail(res, 404, `需求 ${jiraKey} 未找到,请先 ai_productivity_init`)
    return
  }
  ok(res, bundle)
}

export interface SaveLessonsRequestBody {
  jiraKey: string
  lessons: WriteLessonInput[]
  /** 可选:由 MCP 客户端硬编码标识 cursor / claude-code,用于 source.extractedBy */
  source?: LessonExtractedBy
  /**
   * v2.17.0 批次维度 projectSlug 兜底:LLM 一批 lessons 若全部漏填 projectSlug,
   * 用这条 body 级值统一兜底(优先级低于 lesson.projectSlug,高于 store 端按 jiraKey 反查 requirement)。
   * 实际链路中 skill 模板要求 LLM 在 scope='project' 的 lesson 里显式填 currentProjectSlug,
   * 这里只是给老调用方一条软兜底通道,不强制。
   */
  projectSlug?: string
}

/**
 * lessons-extract skill 落盘 LLM 推理出的经验: POST /ai-productivity/lessons (panel-origin 放行)
 *
 * 请求体: { jiraKey, lessons: WriteLessonInput[], source?, projectSlug? }
 *
 * 返回: { saved, savedCount, replaced, rejected }
 *
 * v2.17.0 关键变更:
 *  - 允许 lessons:[] 静默落盘(无任何写入,但仍返回 200 + savedCount=0),用于"本轮没价值经验"的场景
 *  - lesson.projectSlug 缺省时按 body.projectSlug → store 端按 jiraKey 反查 requirement.projectSlug 兜底
 *  - scope 缺省 → 'project'(保守默认,详见 lessons-store.normalizeWriteInput)
 *
 * 经验里的 jiraKey 优先取条目自身;条目缺省时由 body.jiraKey 兜底注入到每条 input。
 * 如果某条 input.jiraKey 与 body.jiraKey 不一致,以条目自身为准(允许跨需求批量补充)。
 */
export function handleAiProductivitySaveLessons(
  res: ServerResponse,
  body: SaveLessonsRequestBody | null
): void {
  if (!body || typeof body !== 'object') {
    fail(res, 400, 'Invalid JSON body')
    return
  }
  const fallbackJiraKey = typeof body.jiraKey === 'string' ? body.jiraKey.trim() : ''
  if (!Array.isArray(body.lessons)) {
    fail(res, 400, 'lessons 必须是数组')
    return
  }
  if (!fallbackJiraKey && body.lessons.some((l) => !l?.jiraKey)) {
    fail(res, 400, '未提供 body.jiraKey 时, 每条 lesson 必须自带 jiraKey')
    return
  }
  // v2.17.0 lessons:[] 短路:不触碰磁盘,直接返回空结果(对应 skill "本轮无价值经验" 的静默路径)
  if (body.lessons.length === 0) {
    ok(res, { saved: [], savedCount: 0, replaced: [], rejected: [] })
    return
  }
  const bodyProjectSlug = typeof body.projectSlug === 'string' ? body.projectSlug.trim() : ''
  const inputs = body.lessons.map((l) => ({
    ...l,
    jiraKey: l?.jiraKey || fallbackJiraKey,
    // 仅在 lesson 自身没显式给 projectSlug 时,落 body 级兜底;store 层 normalize 还会再按 jiraKey 反查兜底
    projectSlug:
      typeof l?.projectSlug === 'string' && l.projectSlug.trim()
        ? l.projectSlug
        : bodyProjectSlug || undefined
  }))
  const source: LessonExtractedBy =
    body.source === 'cursor' || body.source === 'claude-code' ? body.source : 'manual'
  const result = writeLessons(inputs, { extractedBy: source })
  ok(res, {
    saved: result.saved,
    savedCount: result.saved.length,
    replaced: result.replaced,
    rejected: result.rejected
  })
}

// 缺省导出,提供给 server.ts 注册
export { DEFAULT_FORMULA }
export type { StoredRequirement }
