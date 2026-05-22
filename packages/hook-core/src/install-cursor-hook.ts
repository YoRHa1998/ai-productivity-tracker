import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOOK_MARKER = '# ai-productivity-hook'
export const DEBUG_ENV_PREFIX = 'AI_PRODUCTIVITY_DEBUG_HOOK=1'
/**
 * 老 CLI 安装位置(供老用户排查参考);v2.2 起新装会落到 MCP .mjs。
 * 仅供文案展示,不用于 hooks.json 内容匹配(那里走可移植子串 LEGACY_CLI_PATH_PATTERN)。
 */
export const LEGACY_CLI_PATH = join(homedir(), '.local', 'bin', 'ai-productivity')

/**
 * 用于识别"老 CLI hook 命令"的子串(可移植,不依赖 HOME):
 * 老命令形如 `<home>/.local/bin/ai-productivity hook # ai-productivity-hook`,
 * 而新命令形如 `node <abs-mjs> hook # ai-productivity-hook`,后者一定不含 `.local/bin/ai-productivity`。
 */
export const LEGACY_CLI_PATH_PATTERN = '/.local/bin/ai-productivity'

export function cursorHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

/**
 * 构造一条带 marker 的完整 hooks.json command。
 * 调用方传入 base(`node <abs-mjs> hook` 或老 `~/.local/bin/ai-productivity hook`),
 * 函数追加 marker, 必要时前置 AI_PRODUCTIVITY_DEBUG_HOOK=1 环境变量。
 */
export function buildHookCommand(base: string, debug: boolean): string {
  const command = `${base} ${HOOK_MARKER}`
  return debug ? `${DEBUG_ENV_PREFIX} ${command}` : command
}

export interface CursorHookEntry {
  command: string
  [key: string]: unknown
}

export interface CursorHooksFile {
  version?: number
  hooks?: {
    afterAgentResponse?: CursorHookEntry[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface InstallCursorHookOptions {
  /** 完整的 hook 命令(不含 marker、不含 debug 前缀),例如 `node /abs/path/ai-productivity-mcp.mjs hook` */
  command: string
  debug?: boolean
  /** 自定义 hooks.json 路径,测试时使用 */
  hooksPath?: string
}

export interface InstallCursorHookResult {
  hooksPath: string
  finalCommand: string
  /** 是否覆盖了一条已经存在的 hook(命中 marker) */
  replaced: boolean
  /** 被替换的老 command 字符串(若 replaced=true) */
  previousCommand: string | null
}

/**
 * 把 Cursor afterAgentResponse hook 写到 ~/.cursor/hooks.json。
 * 已经含 marker 的条目会被原地覆盖;否则追加新条目。其他字段保留。
 */
export function installCursorHookFile(options: InstallCursorHookOptions): InstallCursorHookResult {
  const hooksPath = options.hooksPath ?? cursorHooksPath()
  const debug = options.debug ?? false

  const cursorDir = join(hooksPath, '..')
  if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true })

  let hooks: CursorHooksFile = { version: 1, hooks: {} }
  if (existsSync(hooksPath)) {
    try {
      hooks = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CursorHooksFile
    } catch {
      // 解析失败时直接覆盖,避免锁死整个 hooks.json
    }
  }

  hooks.version = hooks.version ?? 1
  hooks.hooks = hooks.hooks ?? {}
  const afterAgent = (hooks.hooks.afterAgentResponse as CursorHookEntry[]) ?? []

  const finalCommand = buildHookCommand(options.command, debug)
  const idx = afterAgent.findIndex(
    (entry) => typeof entry.command === 'string' && entry.command.includes(HOOK_MARKER)
  )

  let replaced = false
  let previousCommand: string | null = null
  if (idx >= 0) {
    previousCommand = afterAgent[idx].command
    afterAgent[idx] = { command: finalCommand }
    replaced = true
  } else {
    afterAgent.push({ command: finalCommand })
  }

  hooks.hooks.afterAgentResponse = afterAgent

  writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n', 'utf-8')

  return { hooksPath, finalCommand, replaced, previousCommand }
}

/**
 * 读 ~/.cursor/hooks.json,返回是否存在 marker 命中、对应命令字符串、是否在 DEBUG 模式、
 * 以及是否是「老 CLI 路径」(用于前端提示用户将被覆盖)。
 */
export interface CursorHookInspectResult {
  hooksFileExists: boolean
  hookInstalled: boolean
  hookCommand: string | null
  debugMode: boolean
  legacyHookDetected: boolean
}

export function inspectCursorHook(hooksPath: string = cursorHooksPath()): CursorHookInspectResult {
  const result: CursorHookInspectResult = {
    hooksFileExists: false,
    hookInstalled: false,
    hookCommand: null,
    debugMode: false,
    legacyHookDetected: false
  }
  if (!existsSync(hooksPath)) return result
  result.hooksFileExists = true
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CursorHooksFile
    const entries = parsed.hooks?.afterAgentResponse ?? []
    const found = entries.find(
      (e) => typeof e?.command === 'string' && e.command.includes(HOOK_MARKER)
    )
    if (found?.command) {
      result.hookInstalled = true
      result.hookCommand = found.command
      result.debugMode = found.command.includes(DEBUG_ENV_PREFIX)
      result.legacyHookDetected = found.command.includes(LEGACY_CLI_PATH_PATTERN)
    }
  } catch {
    // 解析失败:保持默认 false
  }
  return result
}
