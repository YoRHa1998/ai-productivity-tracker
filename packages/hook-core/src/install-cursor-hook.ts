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

/**
 * v1.0.0-rc.18 起 hooks.json 包含 3 个 ai-productivity hook 事件入口:
 *  - `beforeSubmitPrompt`:本轮起点信号
 *  - `afterAgentThought`:thinking 块累加
 *  - `afterAgentResponse`:本轮终点 + token 上报
 * 三处共用一份 `node <cli.mjs> hook` 入口,由 stdin 里的 `hook_event_name` 自分流。
 */
export interface CursorHooksFile {
  version?: number
  hooks?: {
    afterAgentResponse?: CursorHookEntry[]
    beforeSubmitPrompt?: CursorHookEntry[]
    afterAgentThought?: CursorHookEntry[]
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
  /** v1.0.0-rc.18:任一事件命中既有 marker 即视为 replaced(粒度按 hooks.json 级,不区分 3 处) */
  replaced: boolean
  /**
   * v1.0.0-rc.18:被替换的老 command 字符串集合。任一事件命中 marker 即收集,
   * 顺序为 `[afterAgentResponse, beforeSubmitPrompt, afterAgentThought]`。
   * 兼容老调用方使用首元素的场景,无被替换返 null。
   */
  previousCommand: string | null
}

/**
 * v1.0.0-rc.18 在指定 hooks 数组中按 marker 覆盖式注入 finalCommand;
 * 返回是否替换、被替换的老 command。
 */
function upsertHookEntry(
  entries: CursorHookEntry[],
  finalCommand: string
): { replaced: boolean; previous: string | null } {
  const idx = entries.findIndex(
    (entry) => typeof entry.command === 'string' && entry.command.includes(HOOK_MARKER)
  )
  if (idx >= 0) {
    const previous = entries[idx].command
    entries[idx] = { command: finalCommand }
    return { replaced: true, previous }
  }
  entries.push({ command: finalCommand })
  return { replaced: false, previous: null }
}

/**
 * 把 Cursor 3 个 hook 入口写到 ~/.cursor/hooks.json:
 *  - `afterAgentResponse`(既有)
 *  - `beforeSubmitPrompt`(v1.0.0-rc.18 新增:本轮起点)
 *  - `afterAgentThought`(v1.0.0-rc.18 新增:纯思考累加)
 *
 * 已经含 marker 的条目会被原地覆盖;否则追加。其它非 ai-productivity 条目保留不动。
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
  const beforeSubmit = (hooks.hooks.beforeSubmitPrompt as CursorHookEntry[]) ?? []
  const afterThought = (hooks.hooks.afterAgentThought as CursorHookEntry[]) ?? []

  const finalCommand = buildHookCommand(options.command, debug)
  const r1 = upsertHookEntry(afterAgent, finalCommand)
  const r2 = upsertHookEntry(beforeSubmit, finalCommand)
  const r3 = upsertHookEntry(afterThought, finalCommand)

  hooks.hooks.afterAgentResponse = afterAgent
  hooks.hooks.beforeSubmitPrompt = beforeSubmit
  hooks.hooks.afterAgentThought = afterThought

  writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n', 'utf-8')

  const replaced = r1.replaced || r2.replaced || r3.replaced
  // 任一被替换则返回最早出现的旧值(优先 afterAgentResponse → beforeSubmit → afterThought),
  // 与老调用方仅看 previousCommand 显示「将被覆盖」的语义保持一致。
  const previousCommand = r1.previous ?? r2.previous ?? r3.previous ?? null

  return { hooksPath, finalCommand, replaced, previousCommand }
}

/**
 * 读 ~/.cursor/hooks.json,返回是否存在 marker 命中、对应命令字符串、是否在 DEBUG 模式、
 * 以及是否是「老 CLI 路径」(用于前端提示用户将被覆盖)。
 */
export interface CursorHookInspectResult {
  hooksFileExists: boolean
  /**
   * v1.0.0-rc.18 起需要 3 个 hook(afterAgentResponse + beforeSubmitPrompt + afterAgentThought)
   * 都装才算 true。任何一处缺失或老 daemon 装的单 afterAgentResponse 都视为未完整安装,
   * 看板 / doctor 会提示重跑 `aipt install`。
   */
  hookInstalled: boolean
  /** 命令字符串:从 afterAgentResponse 那条取(3 处一致时取首);3 处都缺时为 null */
  hookCommand: string | null
  debugMode: boolean
  legacyHookDetected: boolean
  /**
   * v1.0.0-rc.18 各事件独立装机状态。便于 UI/doctor 精准提示「缺哪条」。
   */
  perEvent: {
    afterAgentResponse: boolean
    beforeSubmitPrompt: boolean
    afterAgentThought: boolean
  }
}

function findMarkerEntry(entries: CursorHookEntry[] | undefined): CursorHookEntry | undefined {
  if (!entries) return undefined
  return entries.find((e) => typeof e?.command === 'string' && e.command.includes(HOOK_MARKER))
}

export function inspectCursorHook(hooksPath: string = cursorHooksPath()): CursorHookInspectResult {
  const result: CursorHookInspectResult = {
    hooksFileExists: false,
    hookInstalled: false,
    hookCommand: null,
    debugMode: false,
    legacyHookDetected: false,
    perEvent: {
      afterAgentResponse: false,
      beforeSubmitPrompt: false,
      afterAgentThought: false
    }
  }
  if (!existsSync(hooksPath)) return result
  result.hooksFileExists = true
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as CursorHooksFile
    const a = findMarkerEntry(parsed.hooks?.afterAgentResponse as CursorHookEntry[] | undefined)
    const b = findMarkerEntry(parsed.hooks?.beforeSubmitPrompt as CursorHookEntry[] | undefined)
    const t = findMarkerEntry(parsed.hooks?.afterAgentThought as CursorHookEntry[] | undefined)

    result.perEvent.afterAgentResponse = Boolean(a)
    result.perEvent.beforeSubmitPrompt = Boolean(b)
    result.perEvent.afterAgentThought = Boolean(t)

    // v1.0.0-rc.18 完整安装要求 3 个事件都装好;任一缺失 → 用户需要重跑 install。
    result.hookInstalled = Boolean(a && b && t)

    // command / debugMode / legacy 从首个命中的 entry 取,优先级 afterAgentResponse → submit → thought
    const primary = a ?? b ?? t
    if (primary?.command) {
      result.hookCommand = primary.command
      result.debugMode = primary.command.includes(DEBUG_ENV_PREFIX)
      result.legacyHookDetected = primary.command.includes(LEGACY_CLI_PATH_PATTERN)
    }
  } catch {
    // 解析失败:保持默认 false
  }
  return result
}
