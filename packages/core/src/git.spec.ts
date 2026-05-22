import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { extractIssueKey, getCurrentBranch, findGitRoot } from './git.js'

describe('extractIssueKey', () => {
  it('从规范分支名提取 issueKey', () => {
    expect(extractIssueKey('feature/ABC-123-login')).toBe('ABC-123')
    expect(extractIssueKey('hotfix/PROJ-9-fix')).toBe('PROJ-9')
  })

  it('分支不含 key 返回 null', () => {
    expect(extractIssueKey('main')).toBeNull()
    expect(extractIssueKey('develop')).toBeNull()
  })
})

describe('git repo helpers', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aip-git-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp })
    writeFileSync(join(tmp, '.gitignore'), 'node_modules\n', 'utf-8')
    execFileSync('git', ['add', '.gitignore'], { cwd: tmp })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
      cwd: tmp
    })
    execFileSync('git', ['checkout', '-q', '-b', 'feature/ABC-123-test'], { cwd: tmp })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('getCurrentBranch 返回当前分支', () => {
    expect(getCurrentBranch(tmp)).toBe('feature/ABC-123-test')
  })

  it('findGitRoot 从子目录向上找到 .git 所在目录', () => {
    const sub = join(tmp, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    expect(findGitRoot(sub)).toBe(tmp)
  })

  it('findGitRoot 在非 git 目录返回 null', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'aip-nongit-'))
    try {
      expect(findGitRoot(nonGit)).toBeNull()
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })

  it('findGitRoot 在 worktree(.git 为文件)目录中也能识别', () => {
    const wt = mkdtempSync(join(tmpdir(), 'aip-wt-'))
    try {
      writeFileSync(join(wt, '.git'), 'gitdir: /tmp/some/real/gitdir\n', 'utf-8')
      expect(findGitRoot(wt)).toBe(wt)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })
})
