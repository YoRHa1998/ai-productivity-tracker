/**
 * Codex CLI 的 MCP 配置是 TOML(`~/.codex/config.toml`),且是用户手维护的敏感文件
 * (含 model_providers / projects 信任级 / features 等)。这里**不做全量 TOML round-trip**
 * (会丢注释 / 重排 / 改引号风格),而是**外科式文本 upsert**:只删除并重写我们这一个
 * `[mcp_servers."ai-productivity-tracker"]` 表块(含其可能的子表),其余字节原样保留。
 *
 * 这与 install-mcp.ts 对 Cursor/Claude 的 JSON「只动我们这一个 key」契约一致。
 */

export const CODEX_MCP_SERVER_KEY = 'ai-productivity-tracker'
export const CODEX_LEGACY_MCP_SERVER_KEYS = ['ai-productivity']

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 构造我们这一个 mcp_servers 表块(始终用引号形式的 key,兼容含特殊字符的 server 名) */
export function buildCodexMcpBlock(command: string, args: string[]): string {
  const argList = args.map((a) => `"${tomlEscape(a)}"`).join(', ')
  return [
    `[mcp_servers."${CODEX_MCP_SERVER_KEY}"]`,
    `command = "${tomlEscape(command)}"`,
    `args = [${argList}]`
  ].join('\n')
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line)
}

/**
 * 该 header 行是否属于「我们 / 老 key」的表块。
 *
 * 命中:
 *   [mcp_servers."ai-productivity-tracker"]        (精确)
 *   [mcp_servers.ai-productivity-tracker]          (bare key 形式)
 *   [mcp_servers."ai-productivity-tracker".xxx]    (子表前缀)
 * 以及 legacy key 的同形态。
 */
function headerBelongsToOurs(line: string): { ours: boolean; legacy: boolean } {
  const trimmed = line.trim()
  const keys = [
    { key: CODEX_MCP_SERVER_KEY, legacy: false },
    ...CODEX_LEGACY_MCP_SERVER_KEYS.map((key) => ({ key, legacy: true }))
  ]
  for (const { key, legacy } of keys) {
    const exactQuoted = `[mcp_servers."${key}"]`
    const exactBare = `[mcp_servers.${key}]`
    const prefixQuoted = `[mcp_servers."${key}".`
    const prefixBare = `[mcp_servers.${key}.`
    if (
      trimmed === exactQuoted ||
      trimmed === exactBare ||
      trimmed.startsWith(prefixQuoted) ||
      trimmed.startsWith(prefixBare)
    ) {
      return { ours: true, legacy }
    }
  }
  return { ours: false, legacy: false }
}

export interface CodexMcpUpsertResult {
  text: string
  hadEntry: boolean
  replacedLegacy: boolean
}

/**
 * 在给定 config.toml 文本里 upsert 我们的 mcp_servers 块。
 *
 * - 删除已存在的「我们 / 老 key」表块(从 header 行到下一个顶层表 header 之前)
 * - 在文件末尾追加全新块
 * - 其它内容(包括其它 mcp_servers / model_providers / projects / features / 注释)原样保留
 */
export function upsertCodexMcpConfig(
  original: string,
  command: string,
  args: string[]
): CodexMcpUpsertResult {
  const lines = original.length ? original.split('\n') : []
  const kept: string[] = []
  let hadEntry = false
  let replacedLegacy = false

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isTableHeader(line)) {
      const { ours, legacy } = headerBelongsToOurs(line)
      if (ours) {
        if (legacy) replacedLegacy = true
        else hadEntry = true
        // 跳过本块:从该 header 行起,直到下一个顶层表 header(或 EOF)
        i++
        while (i < lines.length && !isTableHeader(lines[i])) i++
        continue
      }
    }
    kept.push(line)
    i++
  }

  // 去掉 kept 末尾多余空行,统一加一个空行分隔再追加块
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()

  const block = buildCodexMcpBlock(command, args)
  const parts: string[] = []
  if (kept.length > 0) {
    parts.push(kept.join('\n'))
    parts.push('') // 空行分隔
  }
  parts.push(block)
  // 文件以换行结尾
  return { text: parts.join('\n') + '\n', hadEntry, replacedLegacy }
}
