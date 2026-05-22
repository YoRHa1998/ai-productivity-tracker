import { describe, expect, it } from 'vitest'
import {
  collectGitDiffSummary,
  collectNumstat,
  getHeadSha,
  parseNumstat,
  parsePorcelainStatus,
  parseShortstat
} from './git-diff.js'

describe('parseShortstat', () => {
  it('解析典型 shortstat 行', () => {
    expect(parseShortstat(' 3 files changed, 42 insertions(+), 7 deletions(-)')).toEqual({
      files: 3,
      insertions: 42,
      deletions: 7
    })
  })

  it('单文件单条 only-insert 情形', () => {
    expect(parseShortstat(' 1 file changed, 9 insertions(+)')).toEqual({
      files: 1,
      insertions: 9,
      deletions: 0
    })
  })

  it('空字符串返回零值', () => {
    expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })
})

describe('parsePorcelainStatus', () => {
  it('解析 modified / untracked / renamed', () => {
    const raw = [
      ' M apps/web/src/foo.ts',
      'A  packages/db/src/bar.ts',
      '?? scratch/notes.md',
      'R  old/path -> new/path'
    ].join('\n')
    expect(parsePorcelainStatus(raw)).toEqual([
      { path: 'apps/web/src/foo.ts', status: 'M' },
      { path: 'packages/db/src/bar.ts', status: 'A' },
      { path: 'scratch/notes.md', status: '??' },
      { path: 'new/path', status: 'R' }
    ])
  })

  it('空行被忽略', () => {
    expect(parsePorcelainStatus('\n\n')).toEqual([])
  })
})

describe('collectGitDiffSummary', () => {
  it('正常合并 shortstat + porcelain', () => {
    const summary = collectGitDiffSummary('/tmp/fake-repo', {
      exec: (_file, args) => {
        if (args[0] === 'diff') return ' 2 files changed, 10 insertions(+), 1 deletion(-)\n'
        if (args[0] === 'status') return ' M src/a.ts\n?? src/b.ts\n'
        return ''
      }
    })
    expect(summary).toEqual({
      files: 2,
      insertions: 10,
      deletions: 1,
      changedFiles: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: '??' }
      ],
      truncated: false
    })
  })

  it('指定 baseRef 时, 透传给 git diff --shortstat', () => {
    let observedRef = ''
    collectGitDiffSummary('/tmp/fake-repo', 'init-sha', {
      exec: (_file, args) => {
        if (args[0] === 'diff') {
          observedRef = args[args.length - 1]
          return ' 1 file changed, 3 insertions(+)\n'
        }
        if (args[0] === 'status') return ''
        return ''
      }
    })
    expect(observedRef).toBe('init-sha')
  })

  it('超过 50 项时按 50 截断 + truncated=true', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ` M src/file-${i}.ts`).join('\n')
    const summary = collectGitDiffSummary('/tmp/fake-repo', {
      exec: (_file, args) => {
        if (args[0] === 'diff') return ' 60 files changed, 600 insertions(+)\n'
        if (args[0] === 'status') return lines + '\n'
        return ''
      }
    })
    expect(summary.changedFiles.length).toBe(50)
    expect(summary.truncated).toBe(true)
    expect(summary.files).toBe(60)
  })

  it('git diff 抛错 → 返回零值,绝不抛异常', () => {
    const summary = collectGitDiffSummary('/tmp/fake-repo', {
      exec: () => {
        throw new Error('git not found / no HEAD')
      }
    })
    expect(summary).toEqual({
      files: 0,
      insertions: 0,
      deletions: 0,
      changedFiles: [],
      truncated: false
    })
  })

  it('git status 抛错但 diff 成功 → 仍返回 stat 数据,changedFiles 为空', () => {
    const summary = collectGitDiffSummary('/tmp/fake-repo', {
      exec: (_file, args) => {
        if (args[0] === 'diff') return ' 1 file changed, 5 insertions(+)\n'
        throw new Error('status oom')
      }
    })
    expect(summary.files).toBe(1)
    expect(summary.insertions).toBe(5)
    expect(summary.changedFiles).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('解析多行 numstat, 二进制 - 视为 0', () => {
    const raw = ['12\t3\ta.ts', '-\t-\timg.png', '0\t5\tb.ts'].join('\n')
    const map = parseNumstat(raw)
    expect(map.get('a.ts')).toEqual({ insertions: 12, deletions: 3 })
    expect(map.get('img.png')).toEqual({ insertions: 0, deletions: 0 })
    expect(map.get('b.ts')).toEqual({ insertions: 0, deletions: 5 })
  })

  it('空输入返回空 Map', () => {
    expect(parseNumstat('').size).toBe(0)
  })

  it('忽略不符合格式的行', () => {
    const map = parseNumstat('not-a-numstat-line\n')
    expect(map.size).toBe(0)
  })
})

describe('collectNumstat', () => {
  it('成功时返回 Map<path,{ins,del}>', () => {
    const map = collectNumstat('/tmp/fake-repo', 'init-sha', {
      exec: () => '5\t2\tfoo.ts\n-\t-\tbar.png\n'
    })
    expect(map.get('foo.ts')).toEqual({ insertions: 5, deletions: 2 })
    expect(map.get('bar.png')).toEqual({ insertions: 0, deletions: 0 })
  })

  it('git 抛错时返回空 Map, 不抛异常', () => {
    expect(
      collectNumstat('/tmp/fake-repo', 'HEAD', {
        exec: () => {
          throw new Error('no head')
        }
      }).size
    ).toBe(0)
  })
})

describe('getHeadSha', () => {
  it('成功时返回 trim 后的 sha', () => {
    expect(getHeadSha('/tmp/fake-repo', { exec: () => 'abc123def\n' })).toBe('abc123def')
  })

  it('git 抛错时返回空串', () => {
    expect(
      getHeadSha('/tmp/fake-repo', {
        exec: () => {
          throw new Error('no head')
        }
      })
    ).toBe('')
  })
})
