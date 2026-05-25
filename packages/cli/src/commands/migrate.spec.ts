import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runMigrate } from './migrate.js'

describe('migrate', () => {
  let tmpHome: string
  let origHome: string | undefined
  let origData: string | undefined
  let origLegacy: string | undefined
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aipt-migrate-'))
    origHome = process.env.HOME
    origData = process.env.AIPT_DATA_ROOT
    origLegacy = process.env.TRUESIGHT_AIP_ROOT
    process.env.HOME = tmpHome
    delete process.env.AIPT_DATA_ROOT
    delete process.env.TRUESIGHT_AIP_ROOT
    logSpy.mockClear()
    errSpy.mockClear()
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origData === undefined) delete process.env.AIPT_DATA_ROOT
    else process.env.AIPT_DATA_ROOT = origData
    if (origLegacy === undefined) delete process.env.TRUESIGHT_AIP_ROOT
    else process.env.TRUESIGHT_AIP_ROOT = origLegacy
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function legacyDir(): string {
    return join(tmpHome, '.truesight-local-agent', 'ai-productivity')
  }
  function newDir(): string {
    return join(tmpHome, '.ai-productivity-tracker', 'data')
  }

  function seedLegacy(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(legacyDir(), rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
    }
  }

  it('源目录不存在 → 返回 0 + 提示无需迁移', async () => {
    const code = await runMigrate()
    expect(code).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/未发现老数据/))
  })

  it('源目录存在但是空 → 全量复制(目标新建)', async () => {
    mkdirSync(legacyDir(), { recursive: true })
    const code = await runMigrate()
    expect(code).toBe(0)
    expect(existsSync(newDir())).toBe(true)
  })

  it('源目录有数据 + 目标为空 → 全量 cp -r', async () => {
    seedLegacy({
      'INSTANT-1/requirement.json': '{"jiraKey":"INSTANT-1"}',
      'INSTANT-1/iterations.jsonl': 'iteration-line\n',
      'lessons/lsn-X.json': '{"id":"lsn-X"}',
      'index.json': '{}'
    })

    const code = await runMigrate()
    expect(code).toBe(0)
    expect(readFileSync(join(newDir(), 'INSTANT-1/requirement.json'), 'utf-8')).toBe(
      '{"jiraKey":"INSTANT-1"}'
    )
    expect(readFileSync(join(newDir(), 'INSTANT-1/iterations.jsonl'), 'utf-8')).toBe(
      'iteration-line\n'
    )
    expect(readFileSync(join(newDir(), 'lessons/lsn-X.json'), 'utf-8')).toBe('{"id":"lsn-X"}')
    expect(readFileSync(join(newDir(), 'index.json'), 'utf-8')).toBe('{}')
  })

  it('目标已有实质数据 + 无 --force → 拒绝,返回 2', async () => {
    seedLegacy({ 'INSTANT-1/requirement.json': '{"a":1}' })
    mkdirSync(newDir(), { recursive: true })
    writeFileSync(join(newDir(), 'index.json'), '{"existing":true}')

    const code = await runMigrate()
    expect(code).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/目标目录已有数据/))
    // 老数据不应被写入
    expect(existsSync(join(newDir(), 'INSTANT-1/requirement.json'))).toBe(false)
  })

  it('目标已有数据 + --force → 走增量合并,已存在的文件不覆盖', async () => {
    seedLegacy({
      'INSTANT-1/requirement.json': '{"from":"legacy"}',
      'INSTANT-1/iterations.jsonl': 'legacy-line\n',
      'INSTANT-2/requirement.json': '{"new":"data"}'
    })
    mkdirSync(join(newDir(), 'INSTANT-1'), { recursive: true })
    writeFileSync(join(newDir(), 'INSTANT-1', 'requirement.json'), '{"from":"existing"}')

    const code = await runMigrate({ force: true })
    expect(code).toBe(0)
    // existing 文件保留(不覆盖)
    expect(readFileSync(join(newDir(), 'INSTANT-1/requirement.json'), 'utf-8')).toBe(
      '{"from":"existing"}'
    )
    // legacy 但 new dir 没有 → 复制
    expect(readFileSync(join(newDir(), 'INSTANT-1/iterations.jsonl'), 'utf-8')).toBe(
      'legacy-line\n'
    )
    expect(readFileSync(join(newDir(), 'INSTANT-2/requirement.json'), 'utf-8')).toBe(
      '{"new":"data"}'
    )
  })

  it('幂等性:全量复制后再跑一次 → 不抛错且行为合理(走 force 路径,跳过所有已存在)', async () => {
    seedLegacy({ 'A-1/r.json': 'X' })
    expect(await runMigrate()).toBe(0)
    // 第二次跑(目标已有数据)默认会拒绝,带 force 应当幂等
    expect(await runMigrate({ force: true })).toBe(0)
    expect(readFileSync(join(newDir(), 'A-1/r.json'), 'utf-8')).toBe('X')
  })

  it('源目录不是目录(误传文件)→ 返回 1', async () => {
    mkdirSync(join(tmpHome, '.truesight-local-agent'), { recursive: true })
    writeFileSync(legacyDir(), 'oops, not a dir')

    const code = await runMigrate()
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/不是目录/))
  })

  it('迁移后老数据保留(不删除)', async () => {
    seedLegacy({ 'X/data.json': '{}' })
    await runMigrate()
    expect(existsSync(join(legacyDir(), 'X/data.json'))).toBe(true)
  })

  it('AIPT_DATA_ROOT env 生效 → 目标根改写到自定义路径', async () => {
    const customRoot = join(tmpHome, 'custom-root')
    process.env.AIPT_DATA_ROOT = customRoot
    seedLegacy({ 'Z-9/r.json': 'C' })

    expect(await runMigrate()).toBe(0)
    expect(readFileSync(join(customRoot, 'Z-9/r.json'), 'utf-8')).toBe('C')
  })

  it('--force 合并模式正确报告新增/跳过计数(log 包含数字)', async () => {
    seedLegacy({
      'a.json': 'A',
      'b.json': 'B',
      'sub/c.json': 'C'
    })
    mkdirSync(newDir(), { recursive: true })
    writeFileSync(join(newDir(), 'a.json'), 'EXISTING')

    await runMigrate({ force: true })
    const allLog = logSpy.mock.calls.flat().join('\n')
    expect(allLog).toMatch(/新增 2 个文件/)
    expect(allLog).toMatch(/跳过 1 个/)
  })
})
