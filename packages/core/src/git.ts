import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const ISSUE_KEY_REGEX = /([A-Z][A-Z0-9]+-\d+)/

export function extractIssueKey(branchName: string): string | null {
  const match = ISSUE_KEY_REGEX.exec(branchName)
  return match ? match[1] : null
}

export function getCurrentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!out || out === 'HEAD') return null
    return out
  } catch {
    return null
  }
}

export function findGitRoot(startDir: string): string | null {
  let current = resolve(startDir)
  while (true) {
    const candidate = resolve(current, '.git')
    if (existsSync(candidate)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
