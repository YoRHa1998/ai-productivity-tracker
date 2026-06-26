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

import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

// ───────────────────────────────────────────────────────────────────────
// 1. 隔离配置
// ───────────────────────────────────────────────────────────────────────

const DEV_PORT = Number(process.env.AIPT_DEV_PORT ?? '27350')
// vite dev server 端口(与 packages/ui/vite.config.ts 的 server.port 保持一致)。
// 同样需要 pre-flight 释放:实测漂移的孤儿 prod daemon 会沿 17350→17351… 占到这里,
// 害得 fresh vite 只能退到 IPv6 ::1,浏览器(走 IPv4)却命中了那个老 daemon。
const DEV_UI_PORT = Number(process.env.AIPT_DEV_UI_PORT ?? '17351')
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
// 1.5 端口 pre-flight:保证 daemon 端口 + vite UI 端口都干净
// ───────────────────────────────────────────────────────────────────────
//
// 背景坑(两条,根因同源):
//   1. daemon 端口最终会过 `pickAvailablePort(preferred)`,DEV_PORT 被占时**静默漂移**
//      到下一个空闲端口(27350 → 27351);但下面 vite 代理目标写死 DEV_PORT,一旦漂移
//      UI 的 /ai-productivity 请求就打到「占着 DEV_PORT 的那个进程」而非新 daemon。
//   2. vite UI 端口(17351)也可能被占:实测全局 `aipt daemon` 同样用 pickAvailablePort
//      从 17350 起递增,旧实例不被回收时会沿 17350→17351→17352… 漂移并永久占着
//      (孤儿 PPID=1)。fresh vite 在 IPv4 17351 被占后只能退到 IPv6 ::1:17351,
//      浏览器走 IPv4 反而命中那个老 daemon → 旧代码无新端点 → 回退 SPA → 「响应非 JSON」。
//
// 处理原则:dev 的两个端口都不该住着别的 ai-productivity daemon。
//   - 占用者是 ai-productivity daemon(本仓库 tsx dev daemon 或全局 aipt daemon)→ 视为
//     上次残留/漂移过来的孤儿,清理掉(SIGTERM,2s 不退再 SIGKILL)。
//   - 但**绝不动** runtime.json 记录的当前活跃 prod daemon(理论上它不该落在 dev 端口上,
//     真落上了说明环境异常,宁可报错退出也不误杀)。
//   - 占用者是无关进程 → 不擅自杀,打印明显提示并退出,让用户自行处理或换端口。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function listPortListeners(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf-8' }).trim()
    return out
      ? out
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  } catch {
    // lsof 非 0 退出码 = 该端口没人监听
    return []
  }
}

/** 读 ~/.ai-productivity-tracker/runtime.json 里活跃 prod daemon 的 pid(误杀保护用) */
function readActiveProdPid() {
  try {
    const raw = readFileSync(join(homedir(), '.ai-productivity-tracker', 'runtime.json'), 'utf-8')
    const pid = JSON.parse(raw)?.pid
    return typeof pid === 'number' && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 是否是 ai-productivity 的 daemon 进程(本仓库 tsx dev / 全局 aipt / bundle cli.mjs) */
function isAiptDaemonCmd(cmd) {
  if (!/\bdaemon\b/.test(cmd)) return false
  return (
    cmd.includes('packages/cli/src/index.ts') || // 本仓库 tsx dev daemon
    /\baipt\b/.test(cmd) || // 全局 bin
    /cli\.mjs\b/.test(cmd) // esbuild bundle 产物
  )
}

function ensureDevPortFree(port, label, activeProdPid) {
  let pids = listPortListeners(port)
  if (pids.length === 0) return

  for (const pid of pids) {
    let cmd = ''
    try {
      cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8' }).trim()
    } catch {
      continue
    }
    if (activeProdPid && Number(pid) === activeProdPid) {
      console.error(`[dev] ${label} 端口 ${port} 被当前活跃 prod daemon(pid ${pid})占用。`)
      console.error(
        `[dev] 不擅自终止 prod daemon,请用 AIPT_DEV_PORT / AIPT_DEV_UI_PORT 换端口后重试。`
      )
      process.exit(1)
    }
    if (!isAiptDaemonCmd(cmd)) {
      console.error(`[dev] ${label} 端口 ${port} 被非 ai-productivity 进程占用(pid ${pid}):${cmd}`)
      console.error(`[dev] 请先释放该端口,或用 AIPT_DEV_PORT / AIPT_DEV_UI_PORT 换端口后重试。`)
      process.exit(1)
    }
    console.log(
      `[dev] ${label} 端口 ${port} 被残留/漂移的 ai-productivity daemon(pid ${pid})占用,正在清理...`
    )
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {
      /* 已退出 */
    }
  }

  // 等待端口释放(最多 ~2s);仍未释放则 SIGKILL 兜底
  for (let i = 0; i < 20; i++) {
    sleepSync(100)
    pids = listPortListeners(port)
    if (pids.length === 0) return
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* ignore */
    }
  }
  sleepSync(300)
}

const activeProdPid = readActiveProdPid()
ensureDevPortFree(DEV_PORT, 'daemon', activeProdPid)
ensureDevPortFree(DEV_UI_PORT, 'vite', activeProdPid)

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
