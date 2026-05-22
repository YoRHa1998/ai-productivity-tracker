/**
 * `aipt install [--ide=cursor|claude|all]`:一键注入 IDE 配置。
 *
 * 含 3 件事:
 *   1. ~/.cursor/mcp.json:写入 MCP server 条目(等价 `aipt install-mcp`)
 *   2. ~/.cursor/hooks.json:写入 afterAgentResponse hook(`node <abs-cli.mjs> hook`)
 *      + Cursor stop hook(防伪造校验)
 *   3. ~/.claude/skills/ai-productivity-track/SKILL.md & ~/.cursor/rules/*.mdc:
 *      装入对话总结 + 经验提取 skill(委托给 @ai-productivity-tracker/server skill-sync)
 *
 * 注意:hook 与 skill 的注入逻辑落地在 server 包(skill-sync.ts),命令行通过
 * `ensureDaemon` + HTTP 调用 daemon 的 /ai-productivity/install-cursor-hook 与
 * /ai-productivity/install-track-skill 端点完成,确保单源真值。
 */

import { fileURLToPath } from 'node:url'

import { ensureDaemon } from '../lib/ensure-daemon.js'
import { runInstallMcp } from './install-mcp.js'

export type InstallTargetIde = 'cursor' | 'claude' | 'all'

export interface InstallArgs {
  ide?: InstallTargetIde
  debug?: boolean
  /** 自定义 hook 入口绝对路径(默认 = 当前 cli 入口) */
  hookEntry?: string
}

export async function runInstall(args: InstallArgs = {}): Promise<number> {
  const ide = args.ide ?? 'all'

  // Step 1: install-mcp(纯本地配置文件操作,不依赖 daemon)
  if (ide === 'all' || ide === 'cursor') {
    console.log('Step 1/3: 注入 ~/.cursor/mcp.json')
    const code = await runInstallMcp({})
    if (code !== 0) return code
    console.log('')
  }

  // Step 2/3 都需要 daemon 在线
  let endpoint: { baseUrl: string; token: string }
  try {
    console.log('Step 2/3: 启动(或复用)daemon 以完成 hook / skill 注入')
    const result = await ensureDaemon()
    endpoint = result.endpoint
    console.log(`  daemon endpoint: ${endpoint.baseUrl}`)
    console.log('')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`无法启动 daemon: ${msg}`)
    console.error('请先手动跑 `aipt daemon` 排错。')
    return 1
  }

  const hookEntry = args.hookEntry ?? resolveCliEntry()

  // Step 2: Hook 注入(Cursor afterAgentResponse + stop-check)
  if (ide === 'all' || ide === 'cursor') {
    console.log('注入 Cursor afterAgentResponse hook...')
    const ok = await callDaemon(endpoint, 'POST', '/ai-productivity/install-cursor-hook', {
      debug: args.debug ?? false,
      hookEntry
    })
    if (!ok) console.warn('  注入失败,但继续后续步骤')
    else console.log('  ✓ Cursor hook 已注入')
  }

  // Step 3: Skill / Rule 注入(Claude SKILL.md + Cursor rule .mdc)
  console.log('Step 3/3: 注入对话总结 + 经验提取 skill...')
  const skillOk = await callDaemon(endpoint, 'POST', '/ai-productivity/install-track-skill', {})
  if (!skillOk) {
    console.warn('  skill 注入失败,请到看板 → MCP 配置 Tab 点击「一键注入 Skill」按钮重试')
  } else {
    console.log(
      '  ✓ ai-productivity-track + lessons-extract skill 已注入到 ~/.claude/skills 与 ~/.cursor/rules'
    )
  }

  console.log('')
  console.log('✅ 安装完成。重启 IDE 让 MCP / Hook / Skill 生效。')
  console.log(`   看板地址: ${endpoint.baseUrl}`)
  return 0
}

async function callDaemon(
  endpoint: { baseUrl: string; token: string },
  method: string,
  path: string,
  body: unknown
): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`
      },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`  daemon ${method} ${path} 返回 HTTP ${res.status}: ${text.slice(0, 200)}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`  daemon ${method} ${path} 网络异常: ${(err as Error).message}`)
    return false
  }
}

function resolveCliEntry(): string {
  // process.argv[1] 在 esbuild 产物里就是 `<abs>/dist/cli.mjs`
  const arg1 = process.argv[1]
  if (arg1) return arg1
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return ''
  }
}
