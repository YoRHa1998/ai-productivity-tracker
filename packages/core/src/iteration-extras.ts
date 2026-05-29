import type { BindingEntry } from './bindings.js'
import {
  collectGitDiffSummary,
  collectNumstat,
  type GitChangedFile,
  type GitDiffSummary,
  type NumstatMap
} from './git-diff.js'
import {
  numstatMapToRecord,
  readNumstatSnapshot,
  writeNumstatSnapshot,
  type NumstatPerFile
} from './store/numstat-snapshot.js'

const ITER_FILES_LIMIT = 50

export interface IterationExtras {
  elapsedMinutes: number
  thinkSeconds: number
  /**
   * v1.0.0-rc.18 纯模型思考时间(秒)。Cursor `afterAgentThought` hook 每个 thinking 块带
   * `duration_ms`,daemon 在 turn-start Map 内累加,afterAgentResponse 消费时折算成秒透传到这里。
   * 缺省 undefined → UI tooltip 第二行隐藏。
   */
  pureThinkSeconds?: number
  /** 本次对话变更(自上一轮 iteration 以来的增量) */
  diffFiles: number
  diffInsertions: number
  diffDeletions: number
  changedFiles: GitChangedFile[]
  /** 总变更(自 init baseCommit 以来的累计) */
  cumulativeDiffFiles: number
  cumulativeDiffInsertions: number
  cumulativeDiffDeletions: number
  cumulativeChangedFiles: GitChangedFile[]
  modelName: string
}

export interface BuildExtrasInput {
  gitRoot: string
  binding: BindingEntry
  now: Date
  /** appendTokenUsage 之前 binding.lastReportedAt;首次为 null 时 think_seconds 记 0 */
  previousReportedAt: string | null
  /**
   * v2.12.0 本轮真实起点(Claude Code 链路从 transcript user 行 timestamp 取;
   * Cursor 链路 rc.18 起从 beforeSubmitPrompt 起点信号取)。
   *
   * 提供时优先使用,thinkSeconds = max(0, now - turnStartedAt),如实记录「用户提交 prompt →
   * AI 完成响应」的整段 wall time,不再截断(中间 AI 给方案 / 改代码 / 同轮 review 都计入)。
   *
   * 缺省时退化到 previousReportedAt 口径(起点信号缺失:daemon 重启 / hook 未装全等)。
   */
  turnStartedAt?: string
  /**
   * v2.12.0 数据来源(保留字段,供调用方标记链路;不再用于 cap 选择,thinkSeconds 已全程不截断)。
   */
  source?: string
  /**
   * v1.0.0-rc.18 由调用方(daemon hook 路由)从 cursorTurnStarts Map 累加值折算后传入。
   * 仅透传到返回的 `IterationExtras.pureThinkSeconds`,不参与 thinkSeconds 计算。
   */
  pureThinkSeconds?: number
  modelName?: string
  /** init 时记录的 HEAD sha; 空串/缺省时回退到 'HEAD' 表示「相对最新提交」 */
  initBaseCommit?: string
  /** 当前需求的 jiraKey, 用于读写 numstat-snapshot 计算「本次对话变更」 */
  jiraKey?: string
  /** numstat-snapshot 存储根 (单测注入), 透传给 store 模块 */
  storeRoot?: string
  /** 单测注入: 默认走 collectGitDiffSummary */
  collectDiff?: (gitRoot: string, baseRef: string) => GitDiffSummary
  /** 单测注入: 默认走 collectNumstat */
  collectNumstatFn?: (gitRoot: string, baseRef: string) => NumstatMap
  /** 单测注入: 默认走 numstat-snapshot 模块 */
  readSnapshot?: (
    jiraKey: string,
    baseRef: string,
    root?: string
  ) => {
    perFile: Record<string, NumstatPerFile>
  } | null
  writeSnapshot?: (
    jiraKey: string,
    snapshot: {
      version: 1
      baseRef: string
      perFile: Record<string, NumstatPerFile>
      updatedAt: string
    },
    root?: string
  ) => void
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * 把 numstat Map 与 changed-file 状态码 (porcelain) 合并成统一的清单。
 * - 优先使用 porcelain status, 没匹配上的从 numstat 兜底成 'M'
 * - 截断到 50 项
 */
function mergeChangedFiles(
  paths: Iterable<string>,
  porcelainStatus: Map<string, string>
): GitChangedFile[] {
  const out: GitChangedFile[] = []
  for (const path of paths) {
    if (!path) continue
    out.push({ path, status: porcelainStatus.get(path) ?? 'M' })
    if (out.length >= ITER_FILES_LIMIT) break
  }
  return out
}

/**
 * 比较 prev 与 current 两份 numstat, 输出本次对话变更的 ins/del 累加值与受影响文件列表。
 *
 * 规则:
 * - 出现在 current 但不在 prev: 全量计入 (新出现的改动)
 * - 出现在 prev 但不在 current: 视为「这一轮已撤销 / 已提交」, 不计入 (本轮没有新增改动)
 * - 同时出现: 取 max(0, current - prev), 防止 commit 导致 numstat 变小算成负数
 */
function computeIterDelta(
  prev: Map<string, NumstatPerFile> | null,
  current: NumstatMap,
  porcelainStatus: Map<string, string>
): {
  files: number
  insertions: number
  deletions: number
  changedFiles: GitChangedFile[]
} {
  let insertions = 0
  let deletions = 0
  const dirtyPaths: string[] = []
  for (const [path, entry] of current.entries()) {
    const prevEntry = prev?.get(path)
    const deltaIns = prevEntry
      ? Math.max(0, entry.insertions - prevEntry.insertions)
      : entry.insertions
    const deltaDel = prevEntry
      ? Math.max(0, entry.deletions - prevEntry.deletions)
      : entry.deletions
    if (deltaIns > 0 || deltaDel > 0 || !prevEntry) {
      insertions += deltaIns
      deletions += deltaDel
      if (deltaIns > 0 || deltaDel > 0) dirtyPaths.push(path)
    }
  }
  const changedFiles = mergeChangedFiles(dirtyPaths, porcelainStatus)
  return {
    files: dirtyPaths.length,
    insertions,
    deletions,
    changedFiles
  }
}

/**
 * 组装一次 iteration 上报需要的「耗时类 + diff 类 + 模型」字段。
 * - elapsedMinutes: 任务总耗时 = now - requirementStartedAt(缺省回退 binding.startedAt)
 * - thinkSeconds: 本轮 wall time = now - turnStartedAt(缺省回退 now - previousReportedAt),如实记录不截断
 * - cumulativeDiff*: 当前工作区相对 initBaseCommit 的累计统计 + 文件清单(截断 50)
 * - diff*: 自上一轮 numstat-snapshot 以来的本次对话变更
 *
 * 副作用: 写回 numstat-snapshot.json, 供下一轮 iteration 计算增量。
 */
export function buildIterationExtras(input: BuildExtrasInput): IterationExtras {
  const nowMs = input.now.getTime()
  const startMs =
    parseTime(input.binding.requirementStartedAt) ?? parseTime(input.binding.startedAt)
  const elapsedMinutes =
    startMs && nowMs > startMs ? Math.max(0, Math.round((nowMs - startMs) / 60000)) : 0

  // 优先用 turnStartedAt(本轮真实起点:Claude Code 取 transcript user 行 ts,Cursor rc.18 起取
  // beforeSubmitPrompt)算 thinkSeconds,如实记录「用户提交 prompt → AI 完成响应」整段 wall time,
  // 不截断。缺省(起点信号缺失:daemon 重启 / hook 未装全)退化到「上一轮上报 → 本轮上报」差值口径。
  //
  // 历史上这里有 cap(理想 300s / Cursor fallback 60s),是早期无起点信号、只能用相邻 hook 差值
  // 近似时为砍掉跨轮空闲虚高而加的补丁;rc.18 有了真实起点后口径已精确,故全程去掉 cap。
  const turnStartedMs = parseTime(input.turnStartedAt)
  let thinkSeconds: number
  if (turnStartedMs && nowMs > turnStartedMs) {
    thinkSeconds = Math.max(0, Math.round((nowMs - turnStartedMs) / 1000))
  } else {
    const previousMs = parseTime(input.previousReportedAt)
    thinkSeconds =
      previousMs && nowMs > previousMs ? Math.max(0, Math.round((nowMs - previousMs) / 1000)) : 0
  }

  const baseRef = (input.initBaseCommit && input.initBaseCommit.trim()) || 'HEAD'
  const collectDiffFn = input.collectDiff ?? ((gitRoot, ref) => collectGitDiffSummary(gitRoot, ref))
  const collectNumstatFn =
    input.collectNumstatFn ?? ((gitRoot, ref) => collectNumstat(gitRoot, ref))
  const cumulative = collectDiffFn(input.gitRoot, baseRef)
  const currentNumstat = collectNumstatFn(input.gitRoot, baseRef)

  const porcelainStatus = new Map<string, string>()
  for (const cf of cumulative.changedFiles) porcelainStatus.set(cf.path, cf.status)

  let prevPerFile: Map<string, NumstatPerFile> | null = null
  if (input.jiraKey) {
    const readFn = input.readSnapshot ?? readNumstatSnapshot
    const snapshot = readFn(input.jiraKey, baseRef, input.storeRoot)
    if (snapshot) {
      prevPerFile = new Map(Object.entries(snapshot.perFile))
    }
  }

  const iterDelta = computeIterDelta(prevPerFile, currentNumstat, porcelainStatus)

  if (input.jiraKey) {
    const writeFn = input.writeSnapshot ?? writeNumstatSnapshot
    try {
      writeFn(
        input.jiraKey,
        {
          version: 1,
          baseRef,
          perFile: numstatMapToRecord(currentNumstat),
          updatedAt: input.now.toISOString()
        },
        input.storeRoot
      )
    } catch {
      // 持久化失败不阻塞 iteration 上报
    }
  }

  // v1.0.0-rc.20 钳制:纯思考(afterAgentThought 累加)逻辑上是总思考的子集,不可能 > thinkSeconds。
  // 历史上 thinkSeconds 受 cap、pure 无上限,出现过 pure > think 的反逻辑(seq 121);如今 thinkSeconds
  // 已是真实 wall time,pure 仍统一钳到 ≤ thinkSeconds 作防御。保持「未传 → undefined」语义,UI 据缺省隐藏第二行。
  const pureThinkSeconds =
    typeof input.pureThinkSeconds === 'number'
      ? Math.min(Math.max(0, input.pureThinkSeconds), thinkSeconds)
      : undefined

  return {
    elapsedMinutes,
    thinkSeconds,
    pureThinkSeconds,
    diffFiles: iterDelta.files,
    diffInsertions: iterDelta.insertions,
    diffDeletions: iterDelta.deletions,
    changedFiles: iterDelta.changedFiles,
    cumulativeDiffFiles: cumulative.files,
    cumulativeDiffInsertions: cumulative.insertions,
    cumulativeDiffDeletions: cumulative.deletions,
    cumulativeChangedFiles: cumulative.changedFiles,
    modelName: input.modelName ?? ''
  }
}
