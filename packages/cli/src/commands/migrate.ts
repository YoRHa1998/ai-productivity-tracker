/**
 * `aipt migrate`:把老 truesight-agent 数据搬到新根。
 *
 * 源: ~/.truesight-local-agent/ai-productivity/
 * 目标: ~/.ai-productivity-tracker/data/
 *
 * 策略:
 *   - 源目录不存在 → 直接返回 0(无需迁移)
 *   - 目标目录已有 requirement.json / lessons / index.json 等真实数据 → 默认拒绝覆盖,
 *     需要 --force 才会合并(逐文件 cp,目标已存在的同名文件跳过)
 *   - 目标目录为空或只有空 INDEX.json → 直接 `cp -r`
 *
 * 不修改老目录(保留原样,作为 source of truth 直到用户手动删除)。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { dataRoot, ensureHomeDirs, legacyDataRoot } from '../lib/paths.js'

export interface MigrateArgs {
  force?: boolean
}

export async function runMigrate(args: MigrateArgs = {}): Promise<number> {
  ensureHomeDirs()
  const src = legacyDataRoot()
  const dst = dataRoot()

  console.log(`Migrate plan:`)
  console.log(`  source: ${src}`)
  console.log(`  target: ${dst}`)
  console.log('')

  if (!existsSync(src)) {
    console.log('未发现老数据目录,无需迁移。')
    return 0
  }
  if (!statSync(src).isDirectory()) {
    console.error(`${src} 不是目录,拒绝操作。`)
    return 1
  }

  const dstExists = existsSync(dst) && statSync(dst).isDirectory()
  const dstNotEmpty = dstExists && hasNonTrivialContent(dst)

  if (dstNotEmpty && !args.force) {
    console.error('目标目录已有数据。为避免覆盖,默认拒绝迁移。')
    console.error(
      '如果你确认要把老数据合并进来(同名文件保留目标版本,新文件追加),请加 --force 再跑一次。'
    )
    return 2
  }

  if (!dstExists) mkdirSync(dst, { recursive: true, mode: 0o700 })

  if (!dstNotEmpty) {
    // 全量 cp,允许覆盖空目录里的 INDEX.json 之类
    cpSync(src, dst, { recursive: true, errorOnExist: false, force: true })
    console.log('✓ 已全量复制老数据到新目录。')
  } else {
    // force 合并模式:逐文件 cp,目标已存在的跳过
    let copied = 0
    let skipped = 0
    walk(src, (rel) => {
      const srcFile = join(src, rel)
      const dstFile = join(dst, rel)
      if (existsSync(dstFile)) {
        skipped++
        return
      }
      const dstDir = join(dst, rel, '..')
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true })
      cpSync(srcFile, dstFile)
      copied++
    })
    console.log(`✓ 增量合并: 新增 ${copied} 个文件, 跳过 ${skipped} 个已存在的`)
  }

  console.log('')
  console.log('迁移完成。老数据保留在 ' + src + ' 未动,确认无误后可手动删除。')
  console.log('下次启动 daemon 会自动从新目录读取数据。')
  return 0
}

function hasNonTrivialContent(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    return entries.filter((e) => !e.startsWith('.')).length > 0
  } catch {
    return false
  }
}

function walk(root: string, cb: (relativePath: string) => void, prefix = ''): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = join(root, name)
    const rel = prefix ? `${prefix}/${name}` : name
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(abs, cb, rel)
    } else {
      cb(rel)
    }
  }
}
