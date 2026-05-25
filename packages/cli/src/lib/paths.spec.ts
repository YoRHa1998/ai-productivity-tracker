import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  HOME_DIR_NAME,
  LEGACY_HOME_DIR_NAME,
  aiptHome,
  configJsonPath,
  dataRoot,
  legacyAiptHome,
  legacyDataRoot,
  logsDir,
  runtimeJsonPath
} from './paths.js'

describe('paths', () => {
  let origHome: string | undefined
  let origData: string | undefined
  let origLegacy: string | undefined

  beforeEach(() => {
    origHome = process.env.HOME
    origData = process.env.AIPT_DATA_ROOT
    origLegacy = process.env.TRUESIGHT_AIP_ROOT
    process.env.HOME = '/tmp/fake-home'
    delete process.env.AIPT_DATA_ROOT
    delete process.env.TRUESIGHT_AIP_ROOT
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origData === undefined) delete process.env.AIPT_DATA_ROOT
    else process.env.AIPT_DATA_ROOT = origData
    if (origLegacy === undefined) delete process.env.TRUESIGHT_AIP_ROOT
    else process.env.TRUESIGHT_AIP_ROOT = origLegacy
  })

  it('aiptHome 与 legacyAiptHome 命名固定且与 dir name 常量一致', () => {
    expect(aiptHome()).toBe(`/tmp/fake-home/${HOME_DIR_NAME}`)
    expect(legacyAiptHome()).toBe(`/tmp/fake-home/${LEGACY_HOME_DIR_NAME}`)
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

  it('dataRoot 在缺新 env 时退回 TRUESIGHT_AIP_ROOT(向后兼容)', () => {
    process.env.TRUESIGHT_AIP_ROOT = '/legacy/root'
    expect(dataRoot()).toBe('/legacy/root')
  })

  it('dataRoot AIPT_DATA_ROOT 优先级高于 TRUESIGHT_AIP_ROOT', () => {
    process.env.AIPT_DATA_ROOT = '/new/root'
    process.env.TRUESIGHT_AIP_ROOT = '/legacy/root'
    expect(dataRoot()).toBe('/new/root')
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

  it('legacyDataRoot 固定 = legacyAiptHome + ai-productivity', () => {
    expect(legacyDataRoot()).toBe('/tmp/fake-home/.truesight-local-agent/ai-productivity')
  })
})
