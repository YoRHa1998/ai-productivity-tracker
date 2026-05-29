#!/usr/bin/env node
/**
 * `pnpm dev` —— 本地开发一键起服务。
 *
 * 目标:
 *   - daemon 用 tsx 直跑(改 .ts 文件后重启脚本即生效;无需 build)
 *   - UI 走 vite dev server(改 .vue / .ts 自动 HMR)
 *   - 读真实生产数据(`~/.ai-productivity-tracker/data/`),所有需求 / iteration / lessons 都看得见
 *   - 与全局 `npm i -g @ai-productivity-tracker/cli` 安装的 rc 版本完全互不踩
 *
 * 隔离策略:
 *   - 端口:dev daemon 默认 27350(可 `AIPT_DEV_PORT` 覆盖),避开生产 17350
 *   - vite 端口:默认 17351(由 packages/ui/vite.config.ts 决定)
 *   - home:`<repo>/.dev-home/`(通过 `AIPT_HOME_DIR` env 注入)
 *     daemon 的 runtime.json / logs/ / hook-state/ 都落到这里,不污染 ~/.ai-productivity-tracker/
 *   - dataRoot:**显式共享**生产 `~/.ai-productivity-tracker/data/`,所以你能直接看真实需求
 *
 * 影响范围:
 *   - 全局 cli(rc.x)的 daemon 仍可继续跑 17350 端口(它写自己的 runtime.json)
 *   - Cursor / Claude 的 MCP 仍连生产 daemon(它们读的是 ~/.ai-productivity-tracker/runtime.json)
 *   - 浏览器开 http://127.0.0.1:17351 看到的是 dev UI(连 dev daemon,读真实 data)
 *
 * 优雅退出:Ctrl-C 后并行 SIGTERM 两个子进程,等子进程结束再 exit。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ───────────────────────────────────────────────────────────────────────
// 1. 隔离配置
// ───────────────────────────────────────────────────────────────────────

const DEV_PORT = Number(process.env.AIPT_DEV_PORT ?? '27350')
const DEV_HOME = process.env.AIPT_DEV_HOME ?? join(repoRoot, '.dev-home')
// 真实生产 data 目录(rc.x daemon 落盘 + 用户在 Cursor 里跑出来的需求都在这里)
const PROD_DATA_ROOT = join(homedir(), '.ai-productivity-tracker', 'data')
/**
 * 默认让 dev daemon 跳过 transcript-watcher(只做只读 + Web/API 调试)。
 * 因为 prod daemon 仍在跑同一份 ~/.claude/projects/*.jsonl 监听,两个 watcher 同跑会:
 *   - 同一轮对话被各自 flush → iterations 重复落盘
 *   - 共享 transcript-state.json offset 文件 → 写盘竞争
 * 关掉后 dev daemon 退化为「读 data + 跑 API + 托管 SPA」三件套,真实采集仍交给 prod daemon。
 *
 * 若你需要在 dev 上调试 watcher 本身(改 transcript-watcher.ts 看效果),
 * 跑 `AIPT_DEV_ENABLE_WATCHER=1 pnpm dev`,launcher 不会再注入 disable 开关。
 * 此时建议先 `lsof -ti :17350 | xargs kill` 停 prod daemon 避免双 watcher 撞车。
 */
const DEV_ENABLE_WATCHER = process.env.AIPT_DEV_ENABLE_WATCHER === '1'

if (!existsSync(DEV_HOME)) {
  mkdirSync(DEV_HOME, { recursive: true, mode: 0o700 })
}

// 共享真实 data 但隔离 home。
// 注意:hook-core sentinel 读 `AIPT_LOCAL_AGENT_ROOT`,
// dev daemon 自己也设置一份指向 DEV_HOME,避免 dev 写真实生产 hook-state/。
const SHARED_ENV = {
  ...process.env,
  AIPT_HOME_DIR: DEV_HOME,
  AIPT_DATA_ROOT: PROD_DATA_ROOT,
  AIPT_PORT: String(DEV_PORT),
  AIPT_HOST: '127.0.0.1',
  AIPT_LOCAL_AGENT_ROOT: DEV_HOME
}
if (!DEV_ENABLE_WATCHER) {
  SHARED_ENV.AIPT_DISABLE_TRANSCRIPT_WATCHER = '1'
}
// 显式抹掉外层可能继承的 AIPT_TOKEN(否则 dev daemon 会和生产 daemon 共用同一个 token);
// 留空让 daemon 走自然分支:沿用 dev home 中上次 runtime.json 的 token,或随机生成新 token。
delete SHARED_ENV.AIPT_TOKEN

console.log('─── ai-productivity-tracker dev ───')
console.log(`  daemon  : http://127.0.0.1:${DEV_PORT}  (tsx + hot-restart)`)
console.log(`  ui      : http://127.0.0.1:17351        (vite HMR, proxies → daemon)`)
console.log(`  homeDir : ${DEV_HOME}  (runtime.json / logs / hook-state)`)
console.log(`  dataRoot: ${PROD_DATA_ROOT}  (共享生产数据)`)
console.log(
  `  watcher : ${DEV_ENABLE_WATCHER ? 'enabled (会与 prod daemon 抢 ~/.claude/projects,自行权衡)' : 'disabled (避免与 prod daemon 重复采集;调试 watcher 用 AIPT_DEV_ENABLE_WATCHER=1)'}`
)
console.log('  Ctrl-C 退出(不影响全局 cli 的 daemon)')
console.log('───────────────────────────────────')

// ───────────────────────────────────────────────────────────────────────
// 2. 起子进程
// ───────────────────────────────────────────────────────────────────────

/** 给每行输出打颜色前缀,方便区分两路日志 */
function makePrefixer(label, color) {
  const reset = '\x1b[0m'
  const tag = `${color}[${label}]${reset}`
  return (chunk) => {
    const text = chunk.toString()
    const lines = text.split('\n')
    // 最后一段可能是没换行结尾的残段,简单处理:全部前缀
    return lines
      .map((line, i) => (i === lines.length - 1 && line === '' ? '' : `${tag} ${line}`))
      .join('\n')
  }
}

function pipe(child, prefixer, stream) {
  child[stream].setEncoding('utf-8')
  child[stream].on('data', (chunk) => {
    process[stream].write(prefixer(chunk))
  })
}

const daemonPrefix = makePrefixer('daemon', '\x1b[36m')
const vitePrefix = makePrefixer(' vite ', '\x1b[35m')

/**
 * detached:true 把子进程放进**独立进程组**(getpgid === pid),便于退出时一次性
 * `process.kill(-pid)` 杀整组,避免 pnpm wrapper / npm wrapper 退出后 vite 孙子
 * 进程残留占着 17351 端口的常见坑。
 */
const daemonProc = spawn(
  process.execPath,
  ['--import', 'tsx', join(repoRoot, 'packages/cli/src/index.ts'), 'daemon'],
  {
    cwd: repoRoot,
    env: SHARED_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  }
)
pipe(daemonProc, daemonPrefix, 'stdout')
pipe(daemonProc, daemonPrefix, 'stderr')

const viteProc = spawn('pnpm', ['--filter', '@ai-productivity-tracker/ui', 'dev'], {
  cwd: repoRoot,
  env: {
    ...SHARED_ENV,
    // 让 vite proxy 指到我们的 dev daemon
    AIPT_DAEMON_URL: `http://127.0.0.1:${DEV_PORT}`
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
})
pipe(viteProc, vitePrefix, 'stdout')
pipe(viteProc, vitePrefix, 'stderr')

// ───────────────────────────────────────────────────────────────────────
// 3. 优雅退出 + 子进程异常传播
// ───────────────────────────────────────────────────────────────────────

let shuttingDown = false
let exitCode = 0

function killGroup(proc, signal) {
  if (!proc.pid) return
  try {
    // 负号 = 进程组 kill,会把 detached 启动的孙子进程(vite / esbuild watcher 等)一并带走
    process.kill(-proc.pid, signal)
  } catch {
    // ESRCH/EPERM 表示进程已退出或已不存在;再降级试一次直接 kill 进程
    try {
      proc.kill(signal)
    } catch {
      /* 已退出,忽略 */
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[dev] received ${signal}, stopping daemon + vite...`)
  killGroup(daemonProc, 'SIGTERM')
  killGroup(viteProc, 'SIGTERM')
  // 5s 后仍未退则 SIGKILL 整组兜底
  setTimeout(() => {
    for (const p of [daemonProc, viteProc]) {
      if (p.exitCode === null && p.signalCode === null) killGroup(p, 'SIGKILL')
    }
  }, 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

function onChildExit(name, code, signal) {
  console.log(`[dev] ${name} exited (code=${code}, signal=${signal})`)
  if (!shuttingDown) {
    // 其中一个挂了就把另一个也带走,免得用户看到半死状态
    exitCode = code ?? 1
    shutdown('child-exit')
  }
}

daemonProc.on('exit', (code, signal) => onChildExit('daemon', code, signal))
viteProc.on('exit', (code, signal) => onChildExit('vite', code, signal))

// 两个都退后才 exit
let pending = 2
function maybeExit() {
  pending -= 1
  if (pending <= 0) process.exit(exitCode)
}
daemonProc.on('close', maybeExit)
viteProc.on('close', maybeExit)
