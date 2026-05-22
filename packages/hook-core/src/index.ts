/**
 * @platform/ai-productivity-hook-core
 *
 * 提供 Cursor / Claude IDE afterAgentResponse Hook 的核心逻辑:
 *   - runHook: stdin → token 累计 → POST agent / 兜底直写 bindings.json
 *   - installCursorHookFile / inspectCursorHook: 在 ~/.cursor/hooks.json 注入 / 检查 hook
 *
 * 设计目标:可被独立 CLI 或 MCP server 的单文件 .mjs 通过 argv-router 复用,
 * 让最终用户不必单独安装 CLI。
 */

export {
  runHook,
  parseHookTokens,
  buildDedupeKey,
  tryParseHookInput,
  buildRawHookPayload,
  resolveProjectRoot,
  type HookInput
} from './hook.js'

export {
  installCursorHookFile,
  inspectCursorHook,
  buildHookCommand,
  cursorHooksPath,
  HOOK_MARKER,
  DEBUG_ENV_PREFIX,
  LEGACY_CLI_PATH,
  LEGACY_CLI_PATH_PATTERN,
  type InstallCursorHookOptions,
  type InstallCursorHookResult,
  type CursorHookInspectResult,
  type CursorHookEntry,
  type CursorHooksFile
} from './install-cursor-hook.js'

export {
  loadAgentEndpoint,
  postHookToAgent,
  DEFAULT_AGENT_BASE,
  AGENT_CONFIG_PATH,
  type AgentHookPayload,
  type AgentHookResponse,
  type AgentHookResult
} from './lib/agent-client.js'

export { findAipDir, bindingsPath, AIP_DIR_NAME, BINDINGS_FILE } from './lib/paths.js'

export {
  readBindings,
  withBindingsLock,
  type BindingEntry,
  type PendingEntry,
  type BindingsFile
} from './lib/files.js'

export { extractIssueKey, getCurrentBranch, ISSUE_KEY_REGEX } from './lib/git.js'

export {
  gcSentinels,
  readRecentAttachSentinel,
  RECENT_ATTACH_WINDOW_MS,
  recentAttachSentinelPath,
  sentinelDir,
  writeRecentAttachSentinel,
  type RecentAttachPayload
} from './lib/sentinel.js'

export {
  isRequirementInitialized,
  resolveTrackingContext,
  type TrackingContext
} from './lib/tracking-context.js'

export {
  FOLLOWUP_REASON,
  runStopCheck,
  runStopCheckCli,
  type StopCheckOptions,
  type StopCheckOutcome,
  type StopDialect,
  type StopOutcomeKind
} from './stop-check.js'
