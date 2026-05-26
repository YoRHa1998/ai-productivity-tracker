/**
 * `aipt doctor`:体检命令。
 *
 * 10 项检查(PRD §13):
 *   1. Node 版本 ≥ 20.10
 *   2. ~/.ai-productivity-tracker/ home 目录存在 + 权限位
 *   3. runtime.json 与 daemon 状态(pid 存活 / port 端口探活)
 *   4. data 根目录可读写 + 是否有数据
 *   5. ~/.cursor/mcp.json 是否含 ai-productivity-tracker server
 *   6. ~/.claude.json 是否含 ai-productivity-tracker server (rc.16+ 新增)
 *   7. ~/.cursor/hooks.json 是否含 afterAgentResponse hook
 *   8. ~/.claude/skills/ai-productivity-track/SKILL.md 是否就位
 *   9. ~/.cursor/rules/ai-productivity-track.mdc 是否就位
 *   10. 老数据 ~/.truesight-local-agent/ai-productivity/ 是否仍未迁移
 *
 * 全部以 ✓/✗/⚠ 三态彩色输出(无 ANSI 颜色依赖,纯字符)。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { VERSION } from '../version.js'
import {
  aiptHome,
  configJsonPath,
  dataRoot,
  legacyDataRoot,
  runtimeJsonPath
} from '../lib/paths.js'
import { readUserConfig } from '../lib/config.js'
import { isPidAlive, readRuntimeLock } from '../lib/runtime-lock.js'
import { MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEYS } from './install-mcp.js'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'info'

interface CheckResult {
  status: CheckStatus
  label: string
  message: string
}

export async function runDoctor(): Promise<number> {
  console.log(`ai-productivity-tracker v${VERSION} — doctor`)
  console.log('')

  const checks: CheckResult[] = []
  checks.push(checkNodeVersion())
  checks.push(checkHome())
  checks.push(checkConfig())
  await pushAsync(checks, checkDaemon())
  checks.push(checkDataRoot())
  checks.push(checkCursorMcpJson())
  checks.push(checkClaudeMcpJson())
  checks.push(checkCursorHooks())
  checks.push(checkClaudeSkill())
  checks.push(checkCursorRule())
  checks.push(checkLegacyData())

  let warnCount = 0
  let failCount = 0
  for (const c of checks) {
    console.log(`  ${symbol(c.status)}  ${c.label}: ${c.message}`)
    if (c.status === 'warn') warnCount++
    else if (c.status === 'fail') failCount++
  }
  console.log('')
  if (failCount === 0 && warnCount === 0) {
    console.log('🎉 全部检查通过。')
  } else {
    console.log(`检查完成: ${failCount} 项失败, ${warnCount} 项警告。`)
  }

  return failCount === 0 ? 0 : 1
}

async function pushAsync(arr: CheckResult[], p: Promise<CheckResult>): Promise<void> {
  arr.push(await p)
}

function symbol(s: CheckStatus): string {
  switch (s) {
    case 'ok':
      return '[ ✓ ]'
    case 'warn':
      return '[ ⚠ ]'
    case 'fail':
      return '[ ✗ ]'
    case 'info':
    default:
      return '[ · ]'
  }
}

function checkNodeVersion(): CheckResult {
  const v = process.versions.node
  const [maj, min] = v.split('.').map((x) => parseInt(x, 10))
  const major = maj ?? 0
  const minor = min ?? 0
  if (major > 20 || (major === 20 && minor >= 10)) {
    return { status: 'ok', label: 'Node version', message: `v${v}` }
  }
  return {
    status: 'fail',
    label: 'Node version',
    message: `v${v} (require >= 20.10)`
  }
}

function checkHome(): CheckResult {
  const home = aiptHome()
  if (!existsSync(home)) {
    return {
      status: 'warn',
      label: 'Home dir',
      message: `${home} 尚未创建(首次跑 daemon / mcp 时会自动创建)`
    }
  }
  try {
    const mode = statSync(home).mode & 0o777
    if (mode !== 0o700) {
      return {
        status: 'warn',
        label: 'Home dir',
        message: `${home} (mode=${mode.toString(8)},建议 700)`
      }
    }
    return { status: 'ok', label: 'Home dir', message: home }
  } catch {
    return { status: 'fail', label: 'Home dir', message: `无法读取 ${home}` }
  }
}

function checkConfig(): CheckResult {
  const file = configJsonPath()
  if (!existsSync(file)) {
    return { status: 'info', label: 'User config', message: '未配置(使用默认值)' }
  }
  const cfg = readUserConfig()
  const hints: string[] = []
  if (cfg.port) hints.push(`port=${cfg.port}`)
  if (cfg.host) hints.push(`host=${cfg.host}`)
  if (cfg.dataRoot) hints.push(`dataRoot=${cfg.dataRoot}`)
  return {
    status: 'ok',
    label: 'User config',
    message: hints.length ? hints.join(' ') : '(空)'
  }
}

async function checkDaemon(): Promise<CheckResult> {
  const lock = readRuntimeLock()
  if (!lock) {
    return {
      status: 'warn',
      label: 'Daemon',
      message: `${runtimeJsonPath()} 不存在(未运行)`
    }
  }
  if (!isPidAlive(lock.pid)) {
    return {
      status: 'warn',
      label: 'Daemon',
      message: `runtime.json 残留 pid=${lock.pid} 已退出(下次 mcp/ui 拉起会自动清理)`
    }
  }
  try {
    const res = await fetch(`http://${lock.host}:${lock.port}/status`, {
      signal: AbortSignal.timeout(800)
    })
    if (!res.ok) {
      return {
        status: 'warn',
        label: 'Daemon',
        message: `${lock.host}:${lock.port} 返回 ${res.status}`
      }
    }
    return {
      status: 'ok',
      label: 'Daemon',
      message: `http://${lock.host}:${lock.port} (pid=${lock.pid}, v${lock.version})`
    }
  } catch {
    return {
      status: 'fail',
      label: 'Daemon',
      message: `pid=${lock.pid} 存活但 ${lock.host}:${lock.port}/status 无响应`
    }
  }
}

function checkDataRoot(): CheckResult {
  const root = dataRoot()
  if (!existsSync(root)) {
    return { status: 'info', label: 'Data root', message: `${root} 不存在(首次 init 时创建)` }
  }
  const requirementDirs = countRequirementDirs(root)
  return {
    status: 'ok',
    label: 'Data root',
    message: `${root} (${requirementDirs} 个 jiraKey 目录)`
  }
}

function countRequirementDirs(root: string): number {
  try {
    // requirement 目录形如 ABC-123,过滤特殊文件名
    return readdirSync(root).filter((n) => /^[A-Z][A-Z0-9]+-\d+$/.test(n)).length
  } catch {
    return 0
  }
}

function checkCursorMcpJson(): CheckResult {
  const file = join(homedir(), '.cursor', 'mcp.json')
  if (!existsSync(file)) {
    return {
      status: 'warn',
      label: 'Cursor mcp.json',
      message: `${file} 不存在(跑 \`aipt install-mcp\` 注入)`
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      mcpServers?: Record<string, unknown>
    }
    const servers = parsed.mcpServers ?? {}
    if (MCP_SERVER_KEY in servers) {
      return { status: 'ok', label: 'Cursor mcp.json', message: `已含 ${MCP_SERVER_KEY}` }
    }
    for (const legacy of LEGACY_MCP_SERVER_KEYS) {
      if (legacy in servers) {
        return {
          status: 'warn',
          label: 'Cursor mcp.json',
          message: `老 key '${legacy}' 仍在,请跑 \`aipt install-mcp\` 升级到新 key`
        }
      }
    }
    return { status: 'warn', label: 'Cursor mcp.json', message: `未注入,跑 \`aipt install-mcp\`` }
  } catch (err) {
    return { status: 'fail', label: 'Cursor mcp.json', message: (err as Error).message }
  }
}

function checkClaudeMcpJson(): CheckResult {
  // Claude Code 把 MCP servers 放在 ~/.claude.json 顶层(rc.16+ 起 install / install-mcp
  // 默认会同时注入此文件,之前一直漏掉)。
  const file = join(homedir(), '.claude.json')
  if (!existsSync(file)) {
    return {
      status: 'info',
      label: 'Claude mcp.json',
      message: `${file} 不存在(未装 Claude Code 时为正常,装了请跑 \`aipt install\` 注入)`
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      mcpServers?: Record<string, { type?: string }>
    }
    const servers = parsed.mcpServers ?? {}
    if (MCP_SERVER_KEY in servers) {
      const entry = servers[MCP_SERVER_KEY]!
      if (entry.type !== 'stdio') {
        return {
          status: 'warn',
          label: 'Claude mcp.json',
          message: `已含 ${MCP_SERVER_KEY},但缺少 type:'stdio',Claude Code 可能跳过该条目,跑 \`aipt install-mcp --ide=claude\` 修复`
        }
      }
      return { status: 'ok', label: 'Claude mcp.json', message: `已含 ${MCP_SERVER_KEY}` }
    }
    for (const legacy of LEGACY_MCP_SERVER_KEYS) {
      if (legacy in servers) {
        return {
          status: 'warn',
          label: 'Claude mcp.json',
          message: `老 key '${legacy}' 仍在,请跑 \`aipt install-mcp --ide=claude\` 升级到新 key`
        }
      }
    }
    return {
      status: 'warn',
      label: 'Claude mcp.json',
      message: `未注入,跑 \`aipt install-mcp --ide=claude\``
    }
  } catch (err) {
    return { status: 'fail', label: 'Claude mcp.json', message: (err as Error).message }
  }
}

function checkCursorHooks(): CheckResult {
  const file = join(homedir(), '.cursor', 'hooks.json')
  if (!existsSync(file)) {
    return { status: 'warn', label: 'Cursor hooks.json', message: '未注入(跑 `aipt install`)' }
  }
  try {
    const raw = readFileSync(file, 'utf-8')
    if (raw.includes('# ai-productivity-hook')) {
      return { status: 'ok', label: 'Cursor hooks.json', message: '已注入 afterAgentResponse hook' }
    }
    return {
      status: 'warn',
      label: 'Cursor hooks.json',
      message: '存在但未含 ai-productivity hook'
    }
  } catch (err) {
    return { status: 'fail', label: 'Cursor hooks.json', message: (err as Error).message }
  }
}

function checkClaudeSkill(): CheckResult {
  const file = join(homedir(), '.claude', 'skills', 'ai-productivity-track', 'SKILL.md')
  if (existsSync(file)) {
    return { status: 'ok', label: 'Claude skill', message: file }
  }
  return { status: 'info', label: 'Claude skill', message: '未注入(跑 `aipt install`)' }
}

function checkCursorRule(): CheckResult {
  const file = join(homedir(), '.cursor', 'rules', 'ai-productivity-track.mdc')
  if (existsSync(file)) {
    return { status: 'ok', label: 'Cursor rule', message: file }
  }
  return { status: 'info', label: 'Cursor rule', message: '未注入(跑 `aipt install`)' }
}

function checkLegacyData(): CheckResult {
  const legacy = legacyDataRoot()
  if (!existsSync(legacy)) {
    return { status: 'info', label: 'Legacy data', message: '无老 truesight-agent 数据(无需迁移)' }
  }
  const newRoot = dataRoot()
  if (existsSync(newRoot)) {
    return {
      status: 'warn',
      label: 'Legacy data',
      message: `老数据仍在 ${legacy};新根已有数据,跑 \`aipt migrate --force\` 合并`
    }
  }
  return {
    status: 'warn',
    label: 'Legacy data',
    message: `检测到老数据,跑 \`aipt migrate\` 平迁到新目录`
  }
}
