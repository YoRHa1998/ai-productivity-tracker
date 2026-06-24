import { execFileSync } from 'node:child_process'

export const ISSUE_KEY_REGEX = /([A-Z][A-Z0-9]+-\d+)/

export function extractIssueKey(branchName: string): string | null {
  const match = ISSUE_KEY_REGEX.exec(branchName)
  return match ? match[1] : null
}

export function getCurrentBranch(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    if (!out || out === 'HEAD') {
      return null
    }
    return out
  } catch {
    return null
  }
}

/**
 * 解析 cwd 所在 git 仓库的工作区根目录(`git rev-parse --show-toplevel`)。
 *
 * 与 findAipDir 不同:不依赖需求基础设施 `.ai-productivity/` 目录,只要 cwd 在任意
 * git 仓库内就能命中。用于「AI 用量」采集旁路在未 init 需求(含 main 分支)时仍能
 * 富化项目 / 分支元数据。非 git 目录 / git 不可用一律返回 null。
 */
export function findGitRoot(cwd: string = process.cwd()): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    return out || null
  } catch {
    return null
  }
}
