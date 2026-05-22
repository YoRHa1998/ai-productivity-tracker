import { execFileSync } from 'node:child_process'

export interface GitChangedFile {
  path: string
  /** 来自 git status --porcelain 的两位状态码（如 M / MM / ?? / A / D / R）；超长会被截断到 4 字符 */
  status: string
}

export interface GitDiffSummary {
  files: number
  insertions: number
  deletions: number
  changedFiles: GitChangedFile[]
  /** true 表示截断了；前端可以提示「仅展示前 N 项」 */
  truncated: boolean
}

export interface NumstatEntry {
  insertions: number
  deletions: number
}

/** path -> {insertions, deletions} */
export type NumstatMap = Map<string, NumstatEntry>

const MAX_FILES = 50
const TIMEOUT_MS = 5000

export function parseShortstat(line: string): {
  files: number
  insertions: number
  deletions: number
} {
  const result = { files: 0, insertions: 0, deletions: 0 }
  if (!line) return result
  const filesMatch = line.match(/(\d+)\s+files?\s+changed/i)
  if (filesMatch) result.files = Number(filesMatch[1])
  const insMatch = line.match(/(\d+)\s+insertions?\(\+\)/i)
  if (insMatch) result.insertions = Number(insMatch[1])
  const delMatch = line.match(/(\d+)\s+deletions?\(-\)/i)
  if (delMatch) result.deletions = Number(delMatch[1])
  return result
}

export function parsePorcelainStatus(raw: string): GitChangedFile[] {
  if (!raw) return []
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''))
  const files: GitChangedFile[] = []
  for (const line of lines) {
    if (!line) continue
    // porcelain v1: XY<space>path or XY<space>orig -> renamed
    const status = line.slice(0, 2).trim() || '??'
    const rest = line.slice(2).replace(/^\s+/, '')
    if (!rest) continue
    let pathPart = rest
    const arrowIdx = rest.indexOf(' -> ')
    if (arrowIdx >= 0) pathPart = rest.slice(arrowIdx + 4)
    files.push({ path: pathPart, status: status.slice(0, 4) })
  }
  return files
}

export interface GitDiffDeps {
  exec?: (file: string, args: string[], cwd: string) => string
}

const defaultExec: NonNullable<GitDiffDeps['exec']> = (file, args, cwd) =>
  execFileSync(file, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  })

/**
 * 采集本仓库当前工作区相对 baseRef 的 diff 摘要 + 改动文件清单。
 *
 * baseRef 缺省为 `HEAD`(代表「工作区相对最新提交的未提交改动」);
 * 当传入 init 时的 base commit 时, 则代表「需求开始以来的累计改动」。
 *
 * 设计要点:
 *   - shortstat 统计行数（包含已 staged 与未 staged，但不含 untracked,git 行为如此）
 *   - porcelain 列表包含 untracked,提供完整可视化
 *   - 任何 git 失败都返回零值,绝不抛异常,确保 hook 链路不被工作区脏状态阻塞
 *   - 截断 50 项,truncated=true 表示有更多
 */
export function collectGitDiffSummary(
  gitRoot: string,
  depsOrBaseRef: GitDiffDeps | string = {},
  maybeDeps: GitDiffDeps = {}
): GitDiffSummary {
  const baseRef = typeof depsOrBaseRef === 'string' ? depsOrBaseRef : 'HEAD'
  const deps = typeof depsOrBaseRef === 'string' ? maybeDeps : depsOrBaseRef
  const exec = deps.exec ?? defaultExec
  let shortstat = ''
  let porcelain = ''
  try {
    shortstat = exec('git', ['diff', '--shortstat', baseRef], gitRoot).trim()
  } catch {
    // 仓库无 HEAD（裸仓库 / 首次提交前）或 git 不可用 → 都返回空 summary
    return { files: 0, insertions: 0, deletions: 0, changedFiles: [], truncated: false }
  }
  try {
    porcelain = exec('git', ['status', '--porcelain', '-uall'], gitRoot)
  } catch {
    porcelain = ''
  }

  const stat = parseShortstat(shortstat)
  const all = parsePorcelainStatus(porcelain)
  const truncated = all.length > MAX_FILES
  const changedFiles = truncated ? all.slice(0, MAX_FILES) : all

  return {
    files: stat.files || changedFiles.length,
    insertions: stat.insertions,
    deletions: stat.deletions,
    changedFiles,
    truncated
  }
}

/**
 * 解析 `git diff --numstat <baseRef>` 输出, 返回 path -> {ins,del} 的 Map。
 *
 * Numstat 行格式: `<insertions>\t<deletions>\t<path>`,其中二进制文件用 `-` 占位;
 * 我们把 `-` 视为 0,避免污染累加。重命名 `old -> new` 的写法这里通过 git diff 内部
 * 处理 (`--no-renames` 不开,保留 numstat 默认行为)。
 */
export function parseNumstat(raw: string): NumstatMap {
  const map: NumstatMap = new Map()
  if (!raw) return map
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue
    const insRaw = parts[0]
    const delRaw = parts[1]
    const path = parts.slice(2).join('\t').trim()
    if (!path) continue
    const insertions = insRaw === '-' ? 0 : Number(insRaw)
    const deletions = delRaw === '-' ? 0 : Number(delRaw)
    map.set(path, {
      insertions: Number.isFinite(insertions) ? insertions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0
    })
  }
  return map
}

/**
 * 采集 `git diff --numstat <baseRef>` 的逐文件统计, 用于在两次 iteration 之间
 * 做减法得到「本次对话变更」。
 *
 * 与 collectGitDiffSummary 一样, 失败时返回空 Map, 不抛异常。
 */
export function collectNumstat(
  gitRoot: string,
  baseRef = 'HEAD',
  deps: GitDiffDeps = {}
): NumstatMap {
  const exec = deps.exec ?? defaultExec
  try {
    const raw = exec('git', ['diff', '--numstat', baseRef], gitRoot)
    return parseNumstat(raw)
  } catch {
    return new Map()
  }
}

/**
 * 拿当前 HEAD 的完整 commit sha, 失败/裸仓库返回空串。
 * init 时记录到 requirement.initBaseCommit, 后续 hook 用作累计 diff 的 baseRef。
 */
export function getHeadSha(gitRoot: string, deps: GitDiffDeps = {}): string {
  const exec = deps.exec ?? defaultExec
  try {
    return exec('git', ['rev-parse', 'HEAD'], gitRoot).trim()
  } catch {
    return ''
  }
}
