#!/usr/bin/env node
/**
 * `pnpm release [patch|minor|major|prerelease|<exact>]`
 *
 * 自动化发布流程:
 *   1. 检测项目级 .npmrc.publish + npm whoami(隔离 npm 账号,不污染 ~/.npmrc)
 *   2. git 工作区必须干净(允许 lock 文件)
 *   3. 跑 typecheck + test + lint + format:check 全套门禁
 *   4. bump packages/cli/package.json version
 *   5. 链式 build (ui vite + cli esbuild)
 *   6. 校验产物体积(< 3MB tarball,与 PRD §V14 验收对齐)
 *   7. 干跑 `npm publish --dry-run`(默认),或带 --publish 真发
 *   8. 仅在 --publish 模式下打 git tag v<version> + commit
 *      (dry-run 模式完全只读,不改 git 与 package.json,可反复迭代)
 *
 * npm 账号隔离:
 *   如果仓库根存在 `.npmrc.publish`(应当 gitignore),会自动给所有 npm 命令
 *   注入 `--userconfig=<abs>`,使用项目专用 token,不动开发者全局 ~/.npmrc。
 *   首次准备:
 *     npm login --userconfig=./.npmrc.publish --auth-type=web --scope=@ai-productivity-tracker
 *
 * 不会自动 push,需要人工 review。
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const cliDir = join(repoRoot, 'packages', 'cli')
const cliPkgPath = join(cliDir, 'package.json')

const args = process.argv.slice(2)
const bumpArg = args.find((a) => !a.startsWith('--')) ?? 'patch'
const doPublish = args.includes('--publish')
const skipGitClean = args.includes('--skip-git-clean')
const skipTests = args.includes('--skip-tests')

const MAX_TARBALL_BYTES = 3 * 1024 * 1024 // PRD V14: ≤ 3MB

/**
 * 项目级 userconfig:让本仓库 publish 用专用 npm 账号,
 * 不污染开发者 `~/.npmrc` 全局登录态。
 *
 * 文件存在 → 自动给所有 npm 子命令注入 `--userconfig=<abs path>` + `--registry=<official>`。
 * 文件不存在 → 退回全局 `~/.npmrc`(开发态首次跑 release.mjs 走这条)。
 *
 * 为什么同时显式带 --registry?
 *   pnpm 跑 script 时会把全局 ~/.npmrc 的所有配置作为 `npm_config_*` env 注入子进程,
 *   env 优先级高于 --userconfig 文件,会覆盖 .npmrc.publish 里的 registry 设置(实测公司
 *   私有源 http://npm.truesightai.com/ 把官方 https://registry.npmjs.org/ 顶掉,导致 token
 *   被发到错误 registry → ENEEDAUTH)。
 *   CLI flag 优先级最高,显式加上能稳定碾压 env 干扰。
 */
const projectUserConfig = join(repoRoot, '.npmrc.publish')
const hasProjectUserConfig = existsSync(projectUserConfig)
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
const userConfigFlag = hasProjectUserConfig
  ? ` --userconfig=${projectUserConfig} --registry=${OFFICIAL_REGISTRY}`
  : ''

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  return execSync(cmd, { cwd: repoRoot, stdio: 'inherit', ...opts })
}

function runCapture(cmd, opts = {}) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf-8', ...opts }).trim()
}

function bumpVersion(current, type) {
  // 支持显式版本号
  if (/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(type)) {
    return type
  }
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) throw new Error(`不识别的当前版本号: ${current}`)
  const [, majS, minS, patS, pre] = m
  const maj = +majS
  const min = +minS
  const pat = +patS
  switch (type) {
    case 'major':
      return `${maj + 1}.0.0`
    case 'minor':
      return `${maj}.${min + 1}.0`
    case 'patch':
      if (pre) return `${maj}.${min}.${pat}` // 落正式版,去掉 pre
      return `${maj}.${min}.${pat + 1}`
    case 'prerelease': {
      const tag = pre?.split('.')[0] ?? 'rc'
      const num = pre?.match(/(\d+)$/)?.[1]
      const next = num ? +num + 1 : 1
      return `${maj}.${min}.${pat}-${tag}.${next}`
    }
    default:
      throw new Error(`未知 bump 类型: ${type}`)
  }
}

/**
 * publish 前主动跑 npm whoami 确认有 token,没登录就提前 fail,
 * 避免 publish 跑了一半才报 401。
 *
 * dry-run 模式下也跑一次,确保用户配置链路完整可用。
 */
/**
 * 跑 `npm whoami` 时显式控制 stdio + 不继承到屏幕,
 * 把 stderr 完整捕获返回给调用方决定如何展示。
 */
function npmWhoami() {
  const cmd = `npm whoami${userConfigFlag}`
  try {
    const out = execSync(cmd, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return { ok: true, name: out }
  } catch (err) {
    return {
      ok: false,
      stderr: err.stderr?.toString().trim() ?? err.message ?? 'unknown',
      cmd
    }
  }
}

function verifyNpmAuth() {
  if (!hasProjectUserConfig) {
    console.log('  ℹ 未发现 .npmrc.publish,将使用全局 ~/.npmrc 登录态')
    const r = npmWhoami()
    if (r.ok) {
      console.log(`  ✓ 全局 npm 登录身份: ${r.name}`)
    } else {
      console.warn('  ⚠ 全局 ~/.npmrc 未登录;真发(--publish)时会失败,dry-run 可继续')
    }
    return
  }
  console.log(`  ✓ 检测到项目 userconfig: ${projectUserConfig}`)
  const r = npmWhoami()
  if (r.ok) {
    console.log(`  ✓ 项目 npm 登录身份: ${r.name}`)
    return
  }
  console.error('  ✗ .npmrc.publish 内 token 已失效或未登录。')
  console.error(`    cmd:    ${r.cmd}`)
  console.error(`    stderr: ${r.stderr.split('\n')[0]}`)
  console.error(`    请先跑: npm login --userconfig=${projectUserConfig} --auth-type=web`)
  if (doPublish) {
    process.exit(1)
  } else {
    console.warn('  (dry-run 模式继续,但真发前必须先登录)')
  }
}

function ensureGitClean() {
  if (skipGitClean) {
    console.warn('⚠ 跳过 git clean 检查(--skip-git-clean)')
    return
  }
  const status = runCapture('git status --porcelain')
  if (status) {
    console.error('git 工作区不干净:')
    console.error(status)
    console.error('请先 commit 或 stash 后再发布。')
    process.exit(1)
  }
}

function runQualityGate() {
  if (skipTests) {
    console.warn('⚠ 跳过测试与 lint(--skip-tests)')
    return
  }
  run('pnpm typecheck')
  run('pnpm test')
  run('pnpm lint')
  run('pnpm format:check')
}

function buildArtifacts() {
  // 链式 build = ui vite build + cli esbuild bundle
  run('pnpm --filter @ai-productivity-tracker/cli build')
}

/**
 * Publish-only manifest:把 cli/package.json 临时改成"发布版"。
 *
 * 原因:本仓库是 pnpm workspace,cli 的 devDependencies 含 `workspace:*` 协议
 * (链接到 monorepo 内的 core/hook-core/mcp/server)。这些依赖在 esbuild bundle 时
 * 已经被内联进 dist/cli.mjs,运行时不依赖任何外部 npm 包。但 npm publish 会原样
 * 把 package.json(含 workspace:* 字段)塞进 tarball,某些 npm 版本对用户端
 * `npm install <pkg>` 触发 EUNSUPPORTEDPROTOCOL 报错(实测 rc.1 时确认存在)。
 *
 * 解决:publish 前替换为精简 manifest(删除 devDependencies + dev-only scripts),
 * publish 完毕后还原原始内容(保留 monorepo 开发体验)。
 */
function withPublishableManifest(action) {
  const orig = readFileSync(cliPkgPath, 'utf-8')
  const pkg = JSON.parse(orig)
  // 发布版只保留运行时必要字段;dev 才用的字段全清
  delete pkg.devDependencies
  delete pkg.scripts // 发布产物没有 build/test/dev 必要;保留 scripts 反而误导用户
  writeFileSync(cliPkgPath, JSON.stringify(pkg, null, 2) + '\n')
  try {
    return action()
  } finally {
    writeFileSync(cliPkgPath, orig)
  }
}

function verifyTarballSize() {
  // npm pack 干跑拿到产物大小(纯本地操作,不调 registry,可不带 userconfig
  // 但为统一行为还是带上,避免某些 npm 版本读全局 registry 出意外重定向)
  const out = runCapture(`npm pack --dry-run --json${userConfigFlag}`, { cwd: cliDir })
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    console.warn('⚠ 无法解析 npm pack --dry-run --json 输出,跳过体积校验')
    return
  }
  const meta = Array.isArray(parsed) ? parsed[0] : parsed
  const size = meta?.size ?? meta?.['packed-size'] ?? 0
  const files = meta?.entryCount ?? meta?.['entry-count'] ?? 0
  console.log(`📦 npm tarball: ${(size / 1024).toFixed(1)} KiB (${files} files)`)
  if (size > MAX_TARBALL_BYTES) {
    console.error(
      `❌ tarball 超过 ${(MAX_TARBALL_BYTES / 1024 / 1024).toFixed(1)} MB 阈值,拒绝发布`
    )
    process.exit(1)
  }
}

function npmPublish(version) {
  if (!doPublish) {
    console.log('--publish 未指定,跑 npm publish --dry-run')
    run(`npm publish --access public --dry-run${userConfigFlag}`, { cwd: cliDir })
    return
  }
  // 真发
  console.log(`🚀 正在发布 @ai-productivity-tracker/cli@${version}`)
  run(`npm publish --access public${userConfigFlag}`, { cwd: cliDir })
}

function gitCommitAndTag(version) {
  run(`git add ${cliPkgPath}`)
  run(`git commit -m "【Release】@ai-productivity-tracker/cli v${version}"`)
  run(`git tag v${version}`)
  console.log(`✅ git tag v${version} 已打。手动 \`git push --tags\` 推送。`)
}

function main() {
  if (!existsSync(cliPkgPath)) {
    console.error(`缺少 ${cliPkgPath}`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'))
  const current = pkg.version
  const next = bumpVersion(current, bumpArg)

  console.log(`Release: ${current} → ${next}`)
  console.log(`Mode: ${doPublish ? 'PUBLISH' : 'DRY-RUN'}`)
  console.log('')

  console.log('▶ npm 登录态检查')
  verifyNpmAuth()
  console.log('')

  ensureGitClean()
  runQualityGate()

  // 关键设计:dry-run 模式完全只读,不动 git。
  // 这样多次跑 dry-run 不会留下垃圾 commit/tag,用户可以反复迭代直到满意,
  // 最后一次 --publish 才真正改 version + commit + tag + push npm。
  if (!doPublish) {
    // 临时 bump 到目标版本以便 build + 体积校验产物名对齐,然后回写原版本
    pkg.version = next
    writeFileSync(cliPkgPath, JSON.stringify(pkg, null, 2) + '\n')
    try {
      buildArtifacts()
      // 用 publishable manifest 测体积 + dry-run publish,精确模拟真发产物
      withPublishableManifest(() => {
        verifyTarballSize()
        npmPublish(next) // npm publish --dry-run
      })
    } finally {
      // 恢复原版本号,git 工作区保持完全干净
      pkg.version = current
      writeFileSync(cliPkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }
    console.log('')
    console.log(`🟢 DRY-RUN 完成: 模拟发布 @ai-productivity-tracker/cli@${next}`)
    console.log(`   package.json 已恢复到 ${current},git 工作区未改动。`)
    console.log('   真发请重跑加 --publish:')
    console.log(`     pnpm release ${bumpArg} --publish`)
    return
  }

  // 真发路径:bump + build + publish + commit + tag
  pkg.version = next
  writeFileSync(cliPkgPath, JSON.stringify(pkg, null, 2) + '\n')

  buildArtifacts()
  // publish 在 publishable manifest 下跑,确保发出去的 package.json 干净
  withPublishableManifest(() => {
    verifyTarballSize()
    npmPublish(next)
  })
  gitCommitAndTag(next)

  console.log('')
  console.log(`🎉 PUBLISH 完成: @ai-productivity-tracker/cli@${next}`)
  console.log('   下一步:')
  console.log('     git push && git push --tags')
}

main()
