import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCursorSessionReminderCommand,
  buildCursorStopCheckCommand,
  buildClaudeStopCheckCommand,
  CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT,
  CLAUDE_MARK_TOOL_MARKER,
  CLAUDE_STOP_CHECK_MARKER,
  CURSOR_MARK_TOOL_MARKER,
  CURSOR_STOP_CHECK_MARKER,
  CURSOR_STOP_LOOP_LIMIT,
  cleanupLegacyClaudeMarkToolEntries,
  cleanupLegacyClaudeStopHookEntries,
  inspectAiTrackClaudeStopCheck,
  inspectAiTrackCursorHook,
  inspectAiTrackSkillBundle,
  installAiTrackClaudeStopCheck,
  installAiTrackCursorHook,
  installAiTrackSkillBundle
} from './skill-sync.js'
import { CURSOR_SESSION_REMINDER_MARKER } from '@ai-productivity-tracker/core'

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'aip-skill-sync-'))
  // os.homedir() 在 macOS/Linux 上读 HOME 环境变量,通过覆盖它可以让函数返回临时目录
  originalHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

describe('Cursor hooks.json 注入(v2.14.0:stop + sessionStart reminder + 清理老 mark-tool)', () => {
  it('空 hooks.json 场景 → 同时创建 stop / sessionStart entry,afterMCPExecution 不存在', async () => {
    const res = await installAiTrackCursorHook()
    expect(res.stopCheck.replaced).toBe(false)
    expect(res.sessionReminder.replaced).toBe(false)
    expect(res.sessionReminder.finalCommand).toBe(buildCursorSessionReminderCommand())
    expect(res.legacyMarkToolRemoved).toBe(false)
    expect(res.legacyMarkToolPreviousCommand).toBeNull()

    const parsed = JSON.parse(readFileSync(path.join(tmpHome, '.cursor', 'hooks.json'), 'utf-8'))
    expect(parsed.version).toBe(1)
    expect(parsed.hooks.stop).toEqual([
      { command: buildCursorStopCheckCommand(), loop_limit: CURSOR_STOP_LOOP_LIMIT }
    ])
    expect(parsed.hooks.sessionStart).toEqual([{ command: buildCursorSessionReminderCommand() }])
    // 没有老条目,install 不应该自动新建空数组
    expect(parsed.hooks.afterMCPExecution).toBeUndefined()
  })

  it('已有 mark-tool 老条目 + 其他 hook 时:清理老条目,保留其他 entry', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterAgentResponse: [
            {
              command: 'node /Users/x/Downloads/ai-productivity-mcp.mjs hook # ai-productivity-hook'
            }
          ],
          afterMCPExecution: [
            { command: 'node /Users/x/.tanmi-workspace/scripts/foo.cjs' },
            {
              command: `node /old/path/mcp.mjs mark-tool-called ${CURSOR_MARK_TOOL_MARKER}`,
              matcher: 'MCP: ai_productivity_attach_summary'
            }
          ]
        }
      })
    )
    const res = await installAiTrackCursorHook()
    expect(res.legacyMarkToolRemoved).toBe(true)
    expect(res.legacyMarkToolPreviousCommand).toContain('/old/path/mcp.mjs')

    const parsed = JSON.parse(readFileSync(path.join(dir, 'hooks.json'), 'utf-8'))
    expect(parsed.hooks.afterAgentResponse).toEqual([
      { command: 'node /Users/x/Downloads/ai-productivity-mcp.mjs hook # ai-productivity-hook' }
    ])
    // 用户其他 entry 仍然在,只删了 ai-productivity-mark-tool-called 那条
    expect(parsed.hooks.afterMCPExecution).toEqual([
      { command: 'node /Users/x/.tanmi-workspace/scripts/foo.cjs' }
    ])
    expect(parsed.hooks.stop).toEqual([
      { command: buildCursorStopCheckCommand(), loop_limit: CURSOR_STOP_LOOP_LIMIT }
    ])
  })

  it('afterMCPExecution 数组只剩老 mark-tool 条目时,清理后整个 key 被删', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterMCPExecution: [
            { command: `node /old/path/mcp.mjs mark-tool-called ${CURSOR_MARK_TOOL_MARKER}` }
          ]
        }
      })
    )
    await installAiTrackCursorHook()
    const parsed = JSON.parse(readFileSync(path.join(dir, 'hooks.json'), 'utf-8'))
    expect(parsed.hooks.afterMCPExecution).toBeUndefined()
  })

  it('已有同 marker stop entry 时原地覆盖 command,不复制多条', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: `node /old/path/mcp.mjs stop-check ${CURSOR_STOP_CHECK_MARKER}` }]
        }
      })
    )
    const res = await installAiTrackCursorHook()
    expect(res.stopCheck.replaced).toBe(true)
    expect(res.stopCheck.previousCommand).toContain('/old/path/mcp.mjs')

    const parsed = JSON.parse(readFileSync(path.join(dir, 'hooks.json'), 'utf-8'))
    expect(parsed.hooks.stop).toHaveLength(1)
    expect(parsed.hooks.stop[0].command).toBe(buildCursorStopCheckCommand())
    expect(parsed.hooks.stop[0].loop_limit).toBe(CURSOR_STOP_LOOP_LIMIT)
  })

  it('inspect:检测 tanmi-workspace 失效路径 → legacyHookDetected=true', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: [{ command: 'node /Users/x/.tanmi-workspace/scripts/foo.cjs' }]
        }
      })
    )
    const status = await inspectAiTrackCursorHook()
    expect(status.legacyHookDetected).toBe(true)
    expect(status.legacyMarkToolDetected).toBe(false)
    expect(status.stopCheckInstalled).toBe(false)
  })

  it('inspect:残留 mark-tool 条目 → legacyMarkToolDetected=true', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          afterMCPExecution: [
            { command: `node /old/path/mcp.mjs mark-tool-called ${CURSOR_MARK_TOOL_MARKER}` }
          ]
        }
      })
    )
    const status = await inspectAiTrackCursorHook()
    expect(status.legacyMarkToolDetected).toBe(true)
  })

  it('inspect:已安装且最新 → up-to-date,无 mark-tool 残留', async () => {
    await installAiTrackCursorHook()
    const status = await inspectAiTrackCursorHook()
    expect(status.stopCheckInstalled).toBe(true)
    expect(status.stopCheckUpToDate).toBe(true)
    expect(status.sessionReminderInstalled).toBe(true)
    expect(status.sessionReminderUpToDate).toBe(true)
    expect(status.legacyMarkToolDetected).toBe(false)
  })

  // ===== v2.14.0 sessionStart reminder hook 专项覆盖 =====

  it('v2.14.0:已有同 marker sessionStart entry 时原地覆盖 command,不复制多条', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: `bash -c 'echo old' ${CURSOR_SESSION_REMINDER_MARKER}` }]
        }
      })
    )
    const res = await installAiTrackCursorHook()
    expect(res.sessionReminder.replaced).toBe(true)
    expect(res.sessionReminder.previousCommand).toContain('echo old')
    expect(res.sessionReminder.finalCommand).toBe(buildCursorSessionReminderCommand())

    const parsed = JSON.parse(readFileSync(path.join(dir, 'hooks.json'), 'utf-8'))
    expect(parsed.hooks.sessionStart).toHaveLength(1)
    expect(parsed.hooks.sessionStart[0].command).toBe(buildCursorSessionReminderCommand())
  })

  it('v2.14.0:已有其他 sessionStart entry(用户自有 audit / env hook)→ 保留,只追加 reminder', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: './hooks/session-init.sh # user-custom-audit' }]
        }
      })
    )
    const res = await installAiTrackCursorHook()
    expect(res.sessionReminder.replaced).toBe(false)

    const parsed = JSON.parse(readFileSync(path.join(dir, 'hooks.json'), 'utf-8'))
    expect(parsed.hooks.sessionStart).toHaveLength(2)
    expect(parsed.hooks.sessionStart[0].command).toBe('./hooks/session-init.sh # user-custom-audit')
    expect(parsed.hooks.sessionStart[1].command).toBe(buildCursorSessionReminderCommand())
  })

  it('v2.14.0:reminder command 形态合法 — 含 marker + bash -c + CURSOR_PROJECT_DIR 探 branch', async () => {
    const cmd = buildCursorSessionReminderCommand()
    expect(cmd).toContain(CURSOR_SESSION_REMINDER_MARKER)
    expect(cmd).toMatch(/^bash -c /)
    expect(cmd).toContain('CURSOR_PROJECT_DIR')
    expect(cmd).toContain('symbolic-ref')
    expect(cmd).toContain('additional_context')
    // 兜底:任何失败必须输出合法 JSON `{}`,避免污染 Cursor sessionStart 解析
    expect(cmd).toContain('printf "%s" "{}"')
  })

  it('v2.14.0:inspect 旧仓库未装 reminder → installed=false,upToDate=false', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: buildCursorStopCheckCommand(), loop_limit: CURSOR_STOP_LOOP_LIMIT }]
        }
      })
    )
    const status = await inspectAiTrackCursorHook()
    expect(status.stopCheckInstalled).toBe(true)
    expect(status.sessionReminderInstalled).toBe(false)
    expect(status.sessionReminderUpToDate).toBe(false)
    expect(status.sessionReminderCurrentCommand).toBeNull()
  })

  it('v2.14.0:inspect 命中老 reminder 命令但版本旧 → installed=true,upToDate=false', async () => {
    const dir = path.join(tmpHome, '.cursor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: `bash -c 'echo stale' ${CURSOR_SESSION_REMINDER_MARKER}` }]
        }
      })
    )
    const status = await inspectAiTrackCursorHook()
    expect(status.sessionReminderInstalled).toBe(true)
    expect(status.sessionReminderUpToDate).toBe(false)
    expect(status.sessionReminderCurrentCommand).toContain('echo stale')
  })
})

describe('Claude PostToolUse 老条目清理 + Stop hook 注入', () => {
  it('空 settings.json → 仅创建 Stop hook,PostToolUse 不被自动创建', async () => {
    const stopRes = await installAiTrackClaudeStopCheck()
    expect(stopRes.replaced).toBe(false)

    const parsed = JSON.parse(readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'))
    expect(Array.isArray(parsed.hooks.Stop)).toBe(true)
    expect(parsed.hooks.PostToolUse).toBeUndefined()
  })

  it('cleanupLegacyClaudeMarkToolEntries:无老条目 → no-op,不写盘', async () => {
    // 没有 settings.json 文件
    const res = await cleanupLegacyClaudeMarkToolEntries()
    expect(res.removed).toBe(false)
    expect(res.previousCommand).toBeNull()
  })

  it('cleanupLegacyClaudeMarkToolEntries:删除老条目 + 整个 group 一起被删', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'mcp__ai-productivity__ai_productivity_attach_summary',
              hooks: [
                {
                  type: 'command',
                  command: `node /old/mcp.mjs mark-tool-called ${CLAUDE_MARK_TOOL_MARKER}`
                }
              ]
            }
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node /Users/x/.../mcp.mjs hook # ai-productivity-hook`
                }
              ]
            }
          ]
        }
      })
    )
    const res = await cleanupLegacyClaudeMarkToolEntries()
    expect(res.removed).toBe(true)
    expect(res.previousCommand).toContain('/old/mcp.mjs')

    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed.hooks.PostToolUse).toBeUndefined()
    // 不动用户的 Stop entry
    expect(parsed.hooks.Stop).toHaveLength(1)
  })

  it('cleanupLegacyClaudeMarkToolEntries:用户在同 group 还有别的 hook 时只删老条目,group 保留', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'mcp__ai-productivity__ai_productivity_attach_summary',
              hooks: [
                { type: 'command', command: 'node /user/own.mjs # user-custom' },
                {
                  type: 'command',
                  command: `node /old/mcp.mjs mark-tool-called ${CLAUDE_MARK_TOOL_MARKER}`
                }
              ]
            }
          ]
        }
      })
    )
    const res = await cleanupLegacyClaudeMarkToolEntries()
    expect(res.removed).toBe(true)

    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed.hooks.PostToolUse).toHaveLength(1)
    expect(parsed.hooks.PostToolUse[0].hooks).toEqual([
      { type: 'command', command: 'node /user/own.mjs # user-custom' }
    ])
  })

  it('已有 # ai-productivity-hook 的 Stop entry 时,新条目并存而不替换', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/node /old/ai-productivity.mjs hook # ai-productivity-hook'
                }
              ]
            }
          ]
        }
      })
    )
    await installAiTrackClaudeStopCheck()
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const stopGroups = parsed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>
    const allHooks = stopGroups.flatMap((g) => g.hooks ?? [])
    expect(
      allHooks.some(
        (h) => h.command.includes('# ai-productivity-hook') && !h.command.includes('-stop-check')
      )
    ).toBe(true)
    expect(allHooks.some((h) => h.command.includes(CLAUDE_STOP_CHECK_MARKER))).toBe(true)
  })

  it('已有同 marker 的 stop-check entry → 替换 command', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node /old/mcp.mjs stop-check ${CLAUDE_STOP_CHECK_MARKER}`
                }
              ]
            }
          ]
        }
      })
    )
    const res = await installAiTrackClaudeStopCheck()
    expect(res.replaced).toBe(true)
    expect(res.previousCommand).toContain('/old/mcp.mjs')
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const allHooks = (parsed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>).flatMap(
      (g) => g.hooks ?? []
    )
    const ours = allHooks.filter((h) => h.command.includes(CLAUDE_STOP_CHECK_MARKER))
    expect(ours).toHaveLength(1)
    expect(ours[0].command).toBe(buildClaudeStopCheckCommand())
  })

  it('inspect 已安装 + 最新 → up-to-date', async () => {
    await installAiTrackClaudeStopCheck()
    const sStatus = await inspectAiTrackClaudeStopCheck()
    expect(sStatus.installed).toBe(true)
    expect(sStatus.upToDate).toBe(true)
  })
})

describe('installAiTrackSkillBundle 端到端清理(v2.10.0)', () => {
  it('一键注入时同时清理 Cursor afterMCPExecution + Claude PostToolUse 老条目', async () => {
    // 准备:Cursor + Claude 都有老 mark-tool-called 条目
    const cursorFile = path.join(tmpHome, '.cursor', 'hooks.json')
    mkdirSync(path.dirname(cursorFile), { recursive: true })
    writeFileSync(
      cursorFile,
      JSON.stringify({
        version: 1,
        hooks: {
          afterMCPExecution: [
            { command: `node /old/mcp.mjs mark-tool-called ${CURSOR_MARK_TOOL_MARKER}` }
          ]
        }
      })
    )
    const claudeFile = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(claudeFile), { recursive: true })
    writeFileSync(
      claudeFile,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: 'mcp__ai-productivity__ai_productivity_attach_summary',
              hooks: [
                {
                  type: 'command',
                  command: `node /old/mcp.mjs mark-tool-called ${CLAUDE_MARK_TOOL_MARKER}`
                }
              ]
            }
          ]
        }
      })
    )

    const res = await installAiTrackSkillBundle()
    expect(res.cursor.hook.legacyMarkToolRemoved).toBe(true)
    expect(res.claude.legacyMarkToolRemoved).toBe(true)

    const cursorParsed = JSON.parse(readFileSync(cursorFile, 'utf-8'))
    expect(cursorParsed.hooks.afterMCPExecution).toBeUndefined()

    const claudeParsed = JSON.parse(readFileSync(claudeFile, 'utf-8'))
    expect(claudeParsed.hooks.PostToolUse).toBeUndefined()
  })

  it('inspect:bundle 状态包含 claude.legacyMarkToolDetected 字段', async () => {
    const status = await inspectAiTrackSkillBundle()
    expect(status.claude.legacyMarkToolDetected).toBe(false)
    expect(status.cursor.hook.legacyMarkToolDetected).toBe(false)

    // 写一条老 Claude PostToolUse 条目
    const claudeFile = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(claudeFile), { recursive: true })
    writeFileSync(
      claudeFile,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [{ type: 'command', command: `node /old.mjs ${CLAUDE_MARK_TOOL_MARKER}` }]
            }
          ]
        }
      })
    )
    const status2 = await inspectAiTrackSkillBundle()
    expect(status2.claude.legacyMarkToolDetected).toBe(true)
  })
})

describe('Claude Stop hook 老 `~/.local/bin/ai-productivity.mjs` 残留清理(v2.13.0)', () => {
  it('cleanupLegacyClaudeStopHookEntries:无 settings.json → no-op', async () => {
    const res = await cleanupLegacyClaudeStopHookEntries()
    expect(res.removed).toBe(false)
    expect(res.previousCommand).toBeNull()
  })

  it('cleanupLegacyClaudeStopHookEntries:同 group 内还有 stop-check 时只删老条目,group 保留', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `/Users/x/.nvm/versions/node/v22/bin/node /Users/x${CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT} hook # ai-productivity-hook`
                },
                {
                  type: 'command',
                  command: `node /Users/x/Downloads/ai-productivity-mcp.mjs stop-check ${CLAUDE_STOP_CHECK_MARKER}`
                }
              ]
            }
          ]
        }
      })
    )
    const res = await cleanupLegacyClaudeStopHookEntries()
    expect(res.removed).toBe(true)
    expect(res.previousCommand).toContain(CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT)

    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed.hooks.Stop).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks).toHaveLength(1)
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain(CLAUDE_STOP_CHECK_MARKER)
  })

  it('cleanupLegacyClaudeStopHookEntries:Stop 数组只剩老条目时,清理后整个 Stop key 被删', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo' }] }],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node /Users/x${CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT} hook # ai-productivity-hook`
                }
              ]
            }
          ]
        }
      })
    )
    const res = await cleanupLegacyClaudeStopHookEntries()
    expect(res.removed).toBe(true)
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed.hooks.Stop).toBeUndefined()
    // UserPromptSubmit 完全不受影响
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1)
  })

  it('cleanupLegacyClaudeStopHookEntries:二次调用幂等', async () => {
    const file = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node /Users/x${CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT} hook # ai-productivity-hook`
                }
              ]
            }
          ]
        }
      })
    )
    const first = await cleanupLegacyClaudeStopHookEntries()
    expect(first.removed).toBe(true)
    const second = await cleanupLegacyClaudeStopHookEntries()
    expect(second.removed).toBe(false)
    expect(second.previousCommand).toBeNull()
  })

  it('installAiTrackSkillBundle:同时清掉 Stop 老 local-bin hook + 保留新写入的 stop-check', async () => {
    // 用户真实场景模拟:Stop 里既有老 `.local/bin/ai-productivity.mjs hook`,也有新 stop-check
    const claudeFile = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(claudeFile), { recursive: true })
    writeFileSync(
      claudeFile,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `/Users/x/.nvm/versions/node/v22.18.0/bin/node /Users/x${CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT} hook # ai-productivity-hook`
                },
                // 这条是已存在的同 marker stop-check,会被 installAiTrackClaudeStopCheck 替换为新 command
                {
                  type: 'command',
                  command: `node /old/mcp.mjs stop-check ${CLAUDE_STOP_CHECK_MARKER}`
                }
              ]
            }
          ]
        }
      })
    )

    const res = await installAiTrackSkillBundle()
    expect(res.claude.legacyLocalBinHookRemoved).toBe(true)
    expect(res.claude.legacyLocalBinHookPreviousCommand).toContain(
      CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT
    )
    // 新 stop-check 仍然就位
    expect(res.claude.stopCheck.replaced).toBe(true)

    const parsed = JSON.parse(readFileSync(claudeFile, 'utf-8'))
    const allHooks = (parsed.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>).flatMap(
      (g) => g.hooks ?? []
    )
    expect(allHooks).toHaveLength(1)
    expect(allHooks[0].command).toContain(CLAUDE_STOP_CHECK_MARKER)
    expect(allHooks[0].command).not.toContain(CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT)
  })

  it('inspect:bundle 状态包含 claude.legacyLocalBinHookDetected 字段', async () => {
    const empty = await inspectAiTrackSkillBundle()
    expect(empty.claude.legacyLocalBinHookDetected).toBe(false)

    const claudeFile = path.join(tmpHome, '.claude', 'settings.json')
    mkdirSync(path.dirname(claudeFile), { recursive: true })
    writeFileSync(
      claudeFile,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `node /Users/x${CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT} hook # ai-productivity-hook`
                }
              ]
            }
          ]
        }
      })
    )
    const dirty = await inspectAiTrackSkillBundle()
    expect(dirty.claude.legacyLocalBinHookDetected).toBe(true)
  })
})

describe('lessons-extract skill 同步注入(v2.16.0)', () => {
  it('install 时同步写入 lessons-extract 到 ~/.claude/skills 与 ~/.cursor/rules', async () => {
    const res = await installAiTrackSkillBundle()

    expect(res.lessonsExtract.version).toBe('1.3.0')
    expect(res.lessonsExtract.claude.path).toBe(
      path.join(tmpHome, '.claude', 'skills', 'lessons-extract', 'SKILL.md')
    )
    expect(res.lessonsExtract.claude.written).toBe(true)
    expect(res.lessonsExtract.claude.replaced).toBe(false)
    expect(res.lessonsExtract.cursor.path).toBe(
      path.join(tmpHome, '.cursor', 'rules', 'lessons-extract.mdc')
    )
    expect(res.lessonsExtract.cursor.written).toBe(true)

    const claudeContent = readFileSync(res.lessonsExtract.claude.path, 'utf-8')
    expect(claudeContent).toContain('lessons-extract')
    expect(claudeContent).toContain('经验提取')
    expect(claudeContent).toContain('ai_productivity_extract_bundle')
    expect(claudeContent).toContain('ai_productivity_save_lessons')

    const cursorContent = readFileSync(res.lessonsExtract.cursor.path, 'utf-8')
    expect(cursorContent).toContain('alwaysApply: false')
    expect(cursorContent).toContain('经验提取')
  })

  it('inspect:bundle 状态包含 lessonsExtract.{claude,cursor} 同步态', async () => {
    const empty = await inspectAiTrackSkillBundle()
    expect(empty.lessonsExtract.version).toBe('1.3.0')
    expect(empty.lessonsExtract.claude.installed).toBe(false)
    expect(empty.lessonsExtract.cursor.installed).toBe(false)

    await installAiTrackSkillBundle()
    const synced = await inspectAiTrackSkillBundle()
    expect(synced.lessonsExtract.claude.installed).toBe(true)
    expect(synced.lessonsExtract.claude.upToDate).toBe(true)
    expect(synced.lessonsExtract.claude.outdated).toBe(false)
    expect(synced.lessonsExtract.cursor.installed).toBe(true)
    expect(synced.lessonsExtract.cursor.upToDate).toBe(true)
  })

  it('inspect:存量内容不一致时 outdated=true', async () => {
    const claudeFile = path.join(tmpHome, '.claude', 'skills', 'lessons-extract', 'SKILL.md')
    mkdirSync(path.dirname(claudeFile), { recursive: true })
    writeFileSync(claudeFile, 'stale content', 'utf-8')

    const status = await inspectAiTrackSkillBundle()
    expect(status.lessonsExtract.claude.installed).toBe(true)
    expect(status.lessonsExtract.claude.upToDate).toBe(false)
    expect(status.lessonsExtract.claude.outdated).toBe(true)

    await installAiTrackSkillBundle()
    const refreshed = await inspectAiTrackSkillBundle()
    expect(refreshed.lessonsExtract.claude.upToDate).toBe(true)
    expect(refreshed.lessonsExtract.claude.outdated).toBe(false)
  })
})
