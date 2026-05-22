import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readProjectNameFromPackageJson } from './project-meta.js'

describe('readProjectNameFromPackageJson', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aip-pm-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('package.json 有合法 name 时返回该 name', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@scope/my-app', version: '1.0.0' })
    )
    expect(readProjectNameFromPackageJson(dir)).toBe('@scope/my-app')
  })

  it('package.json 不存在时回退到 gitRoot basename', () => {
    expect(readProjectNameFromPackageJson(dir)).toBe(dir.split('/').pop())
  })

  it('package.json 损坏时回退到 basename', () => {
    writeFileSync(join(dir, 'package.json'), 'not json {{{')
    expect(readProjectNameFromPackageJson(dir)).toBe(dir.split('/').pop())
  })

  it('package.json 没有 name 字段时回退到 basename', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    expect(readProjectNameFromPackageJson(dir)).toBe(dir.split('/').pop())
  })

  it('package.json name 是空串时回退到 basename', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '   ' }))
    expect(readProjectNameFromPackageJson(dir)).toBe(dir.split('/').pop())
  })

  it('空 gitRoot 返回空串', () => {
    expect(readProjectNameFromPackageJson('')).toBe('')
  })
})
