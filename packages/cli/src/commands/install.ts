/**
 * `aipt install [--ide=cursor|claude|all]`:一键注入 IDE 配置。
 *
 * 含 3 件事:
 *   1. MCP server 注入(等价 `aipt install-mcp`):
 *        - --ide=cursor|all → ~/.cursor/mcp.json
 *        - --ide=claude|all → ~/.claude.json(rc.16+ 新增,之前一直漏掉)
 *   2. ~/.cursor/hooks.json:写入 afterAgentResponse / sessionStart / stop hook
 *      (`node <abs-cli.mjs> hook`,Cursor 专属,Claude 通过 Hook+Watcher 走 settings.json)
 *   3. ~/.claude/skills/ai-productivity-track/SKILL.md & ~/.cursor/rules/*.mdc:
 *      装入对话总结 + 经验提取 skill(委托给 @ai-productivity-tracker/server skill-sync)
 *
 * 注意:hook 与 skill 的注入逻辑落地在 server 包(skill-sync.ts),命令行通过
 * `ensureDaemon` + HTTP 调用 daemon 的 /ai-productivity/install-cursor-hook 与
 * /ai-productivity/install-track-skill 端点完成,确保单源真值。
 */

import { fileURLToPath } from 'node:url'

import { ensureDaemon } from '../lib/ensure-daemon.js'
import { inspectRunningDaemon, stopRunningDaemon } from '../lib/restart-daemon.js'
import { VERSION } from '../version.js'
import { runInstallMcpAll } from './install-mcp.js'

export type InstallTargetIde = 'cursor' | 'claude' | 'all'

export interface InstallArgs {
  ide?: InstallTargetIde
  debug?: boolean
  /** 自定义 hook 入口绝对路径(默认 = 当前 cli 入口) */
  hookEntry?: string
  /**
   * v2.18.1 默认 install 时若发现本机 daemon 的运行版本与当前 cli 版本不一致,
   * 自动停掉老 daemon(后续 ensureDaemon 拉新)。如果用户因为某些罕见原因不想
   * 自动重启(例如调试老 daemon 行为),传 `--no-restart-daemon` 跳过该步骤。
   */
  noRestartDaemon?: boolean
}

export async function runInstall(args: InstallArgs = {}): Promise<number> {
  const ide = args.ide ?? 'all'

  // Step 0: 版本对齐 —— npm 升级 cli 后,本机老 daemon 进程仍跑旧 ESM bundle,
  // 导致 install 注入的新 Hook / skill 与运行中 daemon 接口错位(已踩过坑:
  // rc.13 → rc.14 升级后,看板「数据整理」按钮调用 rc.14 新增的
  // /merge-split-iterations 端点,被 rc.12 daemon 进程返 404)。
  await maybeRestartStaleDaemon(args.noRestartDaemon === true)

  // Step 1: install-mcp(纯本地配置文件操作,不依赖 daemon)
  // Cursor (~/.cursor/mcp.json) 与 Claude Code (~/.claude.json) 在 install-mcp.ts
  // 内部按 target 分发,任一文件失败不阻断另一个,最终 worst exit code 决定是否继续。
  const installMcpIde = ide
  console.log(
    installMcpIde === 'all'
      ? 'Step 1/3: 注入 ~/.cursor/mcp.json + ~/.claude.json'
      : installMcpIde === 'cursor'
        ? 'Step 1/3: 注入 ~/.cursor/mcp.json'
        : 'Step 1/3: 注入 ~/.claude.json'
  )
  const mcpCode = await runInstallMcpAll({ ide: installMcpIde })
  if (mcpCode !== 0) return mcpCode
  console.log('')

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

/**
 * v2.18.1 Step 0:如果本机正在跑的 daemon 与当前 cli 版本不一致(或 daemon 已挂
 * 但 lockfile 残留),停掉它让后续 Step 2 的 ensureDaemon 拉新版本。
 *
 * 不主动失败:停机超时 / 不在跑 / 已是同版本 都正常返回,install 流程继续。
 * 老 daemon 通过 SIGTERM 优雅停机(自己会清 runtime.json + 关 watcher);超时
 * fallback SIGKILL,然后 stopRunningDaemon 兜底强清 lockfile,保证下一步
 * ensureDaemon 能起干净新 daemon。
 */
async function maybeRestartStaleDaemon(skip: boolean): Promise<void> {
  if (skip) {
    console.log('Step 0/3: 跳过 daemon 版本检查(--no-restart-daemon)')
    console.log('')
    return
  }
  const info = await inspectRunningDaemon()
  if (!info.running) {
    if (info.lock) {
      console.log(
        `Step 0/3: 发现 runtime.json 残留(pid=${info.lock.pid} 已退),清理后由后续步骤拉新 daemon`
      )
      // 复用 stopRunningDaemon 的兜底清理路径
      await stopRunningDaemon()
    } else {
      console.log('Step 0/3: 本机暂无 daemon 在运行,后续步骤将自动拉起')
    }
    console.log('')
    return
  }
  const daemonVersion = info.daemonVersion ?? '(unknown)'
  if (daemonVersion === VERSION) {
    console.log(`Step 0/3: daemon 已是当前 cli 版本 (v${VERSION}),复用`)
    console.log('')
    return
  }
  console.log(`Step 0/3: 检测到旧版本 daemon (v${daemonVersion} → v${VERSION}),正在优雅停机...`)
  const stop = await stopRunningDaemon()
  if (stop.status === 'graceful') {
    console.log(`  ✓ 旧 daemon (pid=${stop.pid}) 已优雅停机 (耗时 ${stop.durationMs}ms)`)
  } else if (stop.status === 'forced') {
    console.log(`  ⚠ 旧 daemon (pid=${stop.pid}) 优雅停机超时,已 SIGKILL 强制结束`)
  } else if (stop.status === 'timeout') {
    console.warn(
      `  ⚠ 旧 daemon (pid=${stop.pid}) SIGKILL 后仍未退,继续执行;若新 daemon 起不来请手动 kill -9 ${stop.pid}`
    )
  }
  console.log('  下一步会自动拉起新版本 daemon')
  console.log('')
}
