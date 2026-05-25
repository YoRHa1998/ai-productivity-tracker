/**
 * esbuild 单文件 bundle: 把整个 cli + 所有 workspace 包 + node_modules 内联到 dist/cli.mjs。
 *
 * 产物特征:
 *   - shebang `#!/usr/bin/env node` + 版本 marker(供前端 / 看板 / doctor 检测)
 *   - chmod 755
 *   - 同时保留 dist/web/(由 ui 包 vite build 提前产出),daemon static 路由直接消费
 *
 * 体积目标: < 2MB (gzip ~600KB),整包 + ui dist 总 < 3MB。
 */

import { build } from 'esbuild'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const distDir = join(__dirname, 'dist')

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })

const pkgPath = join(__dirname, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const version = pkg.version

const entryFile = join(__dirname, 'src/index.ts')
const outfile = join(distDir, 'cli.mjs')

// 默认产物不含 source map(npm tarball 体积优化)。
// 本地排错可:
//   AIPT_BUILD_SOURCEMAP=1 node build.mjs   → 输出 cli.mjs.map
const includeSourcemap = process.env.AIPT_BUILD_SOURCEMAP === '1'

await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  sourcemap: includeSourcemap,
  minify: false,
  banner: {
    // banner 是 esbuild 不会改写的头部固定结构,适合放稳定 marker。
    js:
      `#!/usr/bin/env node\n` +
      `// ai-productivity-tracker · standalone npm distribution\n` +
      `// __AIPT_CLI_VERSION__: ${version}\n` +
      `// __AI_PRODUCTIVITY_MCP_VERSION__: ${version}\n` +
      // ESM bundle 里 require / __dirname / __filename 是 CommonJS 概念,
      // 默认不可用;通过 createRequire shim 让 bundle 内部 require('node:fs') 等仍可工作
      `import { createRequire as __aiptCreateRequire } from 'module';\n` +
      `const require = __aiptCreateRequire(import.meta.url);\n`
  },
  define: {
    __AIPT_VERSION__: JSON.stringify(version)
  }
})
chmodSync(outfile, 0o755)
console.log(`Built: ${outfile} (v${version})`)

// dist/web/ 由 ui 包 vite build 输出到这里,本脚本仅 sanity-check 是否就位
const webDir = join(distDir, 'web')
const webIndexHtml = join(webDir, 'index.html')
if (!existsSync(webIndexHtml)) {
  console.warn(
    `[warn] ${webIndexHtml} 不存在;daemon 将退化为 API-only 模式。\n` +
      `      请先跑 \`pnpm --filter @ai-productivity-tracker/ui build\` 再来打包 cli。`
  )
} else {
  const indexBytes = readFileSync(webIndexHtml).length
  console.log(`Dashboard SPA bundled: ${webDir} (index.html ${indexBytes} bytes)`)
}

// 拷贝 skills/ 目录(可选,供 daemon /install-track-skill 端点降级读源文件)。
// 当前 skill 模板已内嵌在 @ai-productivity-tracker/core/track-skill-templates.ts,
// 所以这一步只是冗余备份;以后改成读盘模式时直接消费这个产物。
const skillsSource = join(repoRoot, 'skills')
if (existsSync(skillsSource)) {
  const skillsDest = join(distDir, 'skills')
  cpSync(skillsSource, skillsDest, { recursive: true })
  console.log(`Skills mirrored: ${skillsDest}`)
}

// 写一份 version.json 同源,前端 / 看板可用 fetch 拉到稳定版本号
writeFileSync(
  join(distDir, 'version.json'),
  JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2) + '\n'
)

console.log('cli build done.')
