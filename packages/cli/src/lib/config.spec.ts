import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readUserConfig, writeUserConfig } from './config.js'

describe('config', () => {
  let tmpHome: string
  let origHome: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'aipt-cfg-'))
    origHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('readUserConfig 在缺文件时返回空对象', () => {
    expect(readUserConfig()).toEqual({})
  })

  it('readUserConfig 在 JSON 损坏时返回空对象(不抛)', () => {
    const home = join(tmpHome, '.ai-productivity-tracker')
    const fs = require('node:fs') as typeof import('node:fs')
    fs.mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), '{not json')
    expect(readUserConfig()).toEqual({})
  })

  it('writeUserConfig 落盘 → 下次 readUserConfig 拿到相同字段', () => {
    writeUserConfig({ port: 17999, host: '127.0.0.1', logLevel: 'debug' })
    expect(readUserConfig()).toMatchObject({
      port: 17999,
      host: '127.0.0.1',
      logLevel: 'debug'
    })
  })

  it('writeUserConfig 是 merge 而不是 replace', () => {
    writeUserConfig({ port: 17999, watcher: { enabled: true } })
    writeUserConfig({ host: '127.0.0.1' })
    const merged = readUserConfig()
    expect(merged.port).toBe(17999) // 上一次的 port 保留
    expect(merged.host).toBe('127.0.0.1')
    expect(merged.watcher?.enabled).toBe(true) // 嵌套对象的 watcher 也保留
  })

  it('writeUserConfig 嵌套 watcher 是 shallow merge', () => {
    writeUserConfig({ watcher: { enabled: true, claudeProjectsDir: '/a' } })
    writeUserConfig({ watcher: { claudeProjectsDir: '/b' } })
    expect(readUserConfig().watcher).toEqual({
      enabled: true,
      claudeProjectsDir: '/b'
    })
  })
})
