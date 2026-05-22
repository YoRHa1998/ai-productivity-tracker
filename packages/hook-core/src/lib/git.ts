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
