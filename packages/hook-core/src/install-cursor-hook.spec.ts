import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildHookCommand,
  DEBUG_ENV_PREFIX,
  HOOK_MARKER,
  inspectCursorHook,
  installCursorHookFile,
  LEGACY_CLI_PATH
} from './install-cursor-hook.js'

describe('buildHookCommand', () => {
  it('追加 marker', () => {
    expect(buildHookCommand('node x.mjs hook', false)).toBe(`node x.mjs hook ${HOOK_MARKER}`)
  })
  it('debug 模式前置环境变量', () => {
    expect(buildHookCommand('node x.mjs hook', true)).toBe(
      `${DEBUG_ENV_PREFIX} node x.mjs hook ${HOOK_MARKER}`
    )
  })
})

describe('installCursorHookFile', () => {
  let tmpDir: string
  let hooksPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aip-hook-install-'))
    hooksPath = join(tmpDir, 'hooks.json')
  })
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('全新文件:写入完整 schema(version + afterAgentResponse)', () => {
    const result = installCursorHookFile({ command: 'node mcp.mjs hook', hooksPath })
    expect(result.replaced).toBe(false)
    expect(result.previousCommand).toBeNull()

    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(parsed.version).toBe(1)
    expect(parsed.hooks.afterAgentResponse).toEqual([
      { command: `node mcp.mjs hook ${HOOK_MARKER}` }
    ])
  })

  it('已有非本工具条目时,在末尾追加,不影响他人', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: '/usr/local/bin/some-other-tool' }]
        }
      })
    )
    const result = installCursorHookFile({ command: 'node mcp.mjs hook', hooksPath })
    expect(result.replaced).toBe(false)

    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(parsed.hooks.afterAgentResponse).toEqual([
      { command: '/usr/local/bin/some-other-tool' },
      { command: `node mcp.mjs hook ${HOOK_MARKER}` }
    ])
  })

  it('已有老 CLI marker 条目时,原地覆盖为新命令,返回 previousCommand', () => {
    const legacyCommand = `${LEGACY_CLI_PATH} hook ${HOOK_MARKER}`
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: legacyCommand }]
        }
      })
    )
    const result = installCursorHookFile({ command: 'node mcp.mjs hook', hooksPath })
    expect(result.replaced).toBe(true)
    expect(result.previousCommand).toBe(legacyCommand)

    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(parsed.hooks.afterAgentResponse).toEqual([
      { command: `node mcp.mjs hook ${HOOK_MARKER}` }
    ])
  })

  it('debug=true 时前置 AI_PRODUCTIVITY_DEBUG_HOOK=1', () => {
    installCursorHookFile({ command: 'node mcp.mjs hook', hooksPath, debug: true })
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(parsed.hooks.afterAgentResponse[0].command).toBe(
      `${DEBUG_ENV_PREFIX} node mcp.mjs hook ${HOOK_MARKER}`
    )
  })

  it('解析失败的 hooks.json 会被覆盖重写(不卡死)', () => {
    writeFileSync(hooksPath, '{not json')
    const result = installCursorHookFile({ command: 'node mcp.mjs hook', hooksPath })
    expect(result.replaced).toBe(false)
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    expect(parsed.hooks.afterAgentResponse).toEqual([
      { command: `node mcp.mjs hook ${HOOK_MARKER}` }
    ])
  })
})

describe('inspectCursorHook', () => {
  let tmpDir: string
  let hooksPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aip-hook-inspect-'))
    hooksPath = join(tmpDir, 'hooks.json')
  })
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('文件不存在 → 全 false', () => {
    expect(inspectCursorHook(hooksPath)).toMatchObject({
      hooksFileExists: false,
      hookInstalled: false,
      hookCommand: null,
      debugMode: false,
      legacyHookDetected: false
    })
  })

  it('marker 命中且命令是 mcp.mjs 新格式', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [
            { command: `node /Users/x/Downloads/ai-productivity-mcp.mjs hook ${HOOK_MARKER}` }
          ]
        }
      })
    )
    const r = inspectCursorHook(hooksPath)
    expect(r.hookInstalled).toBe(true)
    expect(r.debugMode).toBe(false)
    expect(r.legacyHookDetected).toBe(false)
  })

  it('marker 命中且命令是老 CLI 路径 → legacyHookDetected=true', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: `${LEGACY_CLI_PATH} hook ${HOOK_MARKER}` }]
        }
      })
    )
    const r = inspectCursorHook(hooksPath)
    expect(r.hookInstalled).toBe(true)
    expect(r.legacyHookDetected).toBe(true)
  })

  it('DEBUG 模式命令识别', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [{ command: `${DEBUG_ENV_PREFIX} node mcp.mjs hook ${HOOK_MARKER}` }]
        }
      })
    )
    const r = inspectCursorHook(hooksPath)
    expect(r.hookInstalled).toBe(true)
    expect(r.debugMode).toBe(true)
  })

  it('hooks.json 无 marker 条目 → hookInstalled=false', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: { afterAgentResponse: [{ command: '/usr/local/bin/some-other-tool' }] }
      })
    )
    const r = inspectCursorHook(hooksPath)
    expect(r.hookInstalled).toBe(false)
    expect(r.hookCommand).toBeNull()
  })
})
