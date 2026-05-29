import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOME_DIR_ENV,
  HOME_DIR_NAME,
  aiptHome,
  configJsonPath,
  dataRoot,
  logsDir,
  runtimeJsonPath
} from './paths.js'

describe('paths', () => {
  let origHome: string | undefined
  let origData: string | undefined
  let origHomeDir: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    origData = process.env.AIPT_DATA_ROOT
    origHomeDir = process.env[HOME_DIR_ENV]
    process.env.HOME = '/tmp/fake-home'
    delete process.env.AIPT_DATA_ROOT
    delete process.env[HOME_DIR_ENV]
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origData === undefined) delete process.env.AIPT_DATA_ROOT
    else process.env.AIPT_DATA_ROOT = origData
    if (origHomeDir === undefined) delete process.env[HOME_DIR_ENV]
    else process.env[HOME_DIR_ENV] = origHomeDir
  })

  it('aiptHome 命名固定且与 dir name 常量一致', () => {
    expect(aiptHome()).toBe(`/tmp/fake-home/${HOME_DIR_NAME}`)
  })

  it('runtimeJsonPath / configJsonPath / logsDir 都在 aiptHome 之下', () => {
    expect(runtimeJsonPath()).toBe('/tmp/fake-home/.ai-productivity-tracker/runtime.json')
    expect(configJsonPath()).toBe('/tmp/fake-home/.ai-productivity-tracker/config.json')
    expect(logsDir()).toBe('/tmp/fake-home/.ai-productivity-tracker/logs')
  })

  it('dataRoot 默认 = aiptHome/data', () => {
    expect(dataRoot()).toBe('/tmp/fake-home/.ai-productivity-tracker/data')
  })

  it('dataRoot 优先使用 AIPT_DATA_ROOT env', () => {
    process.env.AIPT_DATA_ROOT = '/custom/root'
    expect(dataRoot()).toBe('/custom/root')
  })

  it('dataRoot 空 env(空白)应当被忽略,fallback 到默认', () => {
    process.env.AIPT_DATA_ROOT = '   '
    expect(dataRoot()).toBe('/tmp/fake-home/.ai-productivity-tracker/data')
  })

  it('dataRoot env 路径会被 resolve 成绝对路径', () => {
    process.env.AIPT_DATA_ROOT = './relative'
    const result = dataRoot()
    expect(result.startsWith('/')).toBe(true)
    expect(result.endsWith('/relative')).toBe(true)
  })

  it('aiptHome 优先使用 AIPT_HOME_DIR env(开发态 sandbox 隔离 runtime.json/logs/hook-state)', () => {
    process.env[HOME_DIR_ENV] = '/tmp/aipt-dev-home'
    expect(aiptHome()).toBe('/tmp/aipt-dev-home')
    expect(runtimeJsonPath()).toBe('/tmp/aipt-dev-home/runtime.json')
    expect(logsDir()).toBe('/tmp/aipt-dev-home/logs')
  })

  it('aiptHome 空白 AIPT_HOME_DIR 被忽略,fallback 到默认 ~/.ai-productivity-tracker', () => {
    process.env[HOME_DIR_ENV] = '   '
    expect(aiptHome()).toBe(`/tmp/fake-home/${HOME_DIR_NAME}`)
  })

  it('AIPT_HOME_DIR 与 AIPT_DATA_ROOT 互不干扰(分别覆盖 home / data)', () => {
    process.env[HOME_DIR_ENV] = '/tmp/aipt-dev-home'
    process.env.AIPT_DATA_ROOT = '/real/data'
    expect(aiptHome()).toBe('/tmp/aipt-dev-home')
    expect(dataRoot()).toBe('/real/data')
  })
})
