#!/usr/bin/env node
/**
 * `pnpm release [patch|minor|major|prerelease|<exact>]`
 *
 * 自动化发布流程:
 *   1. git 工作区必须干净(允许 lock 文件)
 *   2. 跑 typecheck + test + lint + format:check 全套门禁
 *   3. bump packages/cli/package.json version
 *   4. 链式 build (ui vite + cli esbuild)
 *   5. 校验产物体积(< 3MB tarball,与 PRD §V14 验收对齐)
 *   6. 干跑 `npm publish --dry-run`(默认),或带 --publish 真发
 *   7. 打 git tag v<version> + commit
 *
 * 不会自动 push 与 npm publish 真发,需要人工 review。
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

function verifyTarballSize() {
  // npm pack 干跑拿到产物大小
  const out = runCapture('npm pack --dry-run --json', { cwd: cliDir })
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
    run('npm publish --access public --dry-run', { cwd: cliDir })
    return
  }
  // 真发
  console.log(`🚀 正在发布 @ai-productivity-tracker/cli@${version}`)
  run('npm publish --access public', { cwd: cliDir })
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

  ensureGitClean()
  runQualityGate()

  pkg.version = next
  writeFileSync(cliPkgPath, JSON.stringify(pkg, null, 2) + '\n')

  buildArtifacts()
  verifyTarballSize()

  npmPublish(next)
  gitCommitAndTag(next)

  console.log('')
  console.log(`🎉 完成: @ai-productivity-tracker/cli@${next}`)
  if (!doPublish) {
    console.log('   (--publish 未带,这只是干跑;真发请重跑 + 加 --publish)')
  } else {
    console.log('   下一步: git push && git push --tags')
  }
}

main()
