import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * 读取业务项目根目录的 `package.json` 中 `name` 字段, 作为 AI 提效需求的
 * `projectSlug` 显示。
 *
 * 失败兜底链:
 * 1. 没有 `package.json` / 解析失败 -> 回退到 `gitRoot` 的 basename
 * 2. 字段为空字符串或非 string -> 同上
 * 3. gitRoot 为空 -> 返回空串
 *
 * 设计要点:
 * - 同步实现, init 流程无需 await
 * - 绝不抛异常, 任何意外都回退到 basename, 保证 init 不被项目结构问题阻塞
 */
export function readProjectNameFromPackageJson(gitRoot: string): string {
  if (!gitRoot) return ''
  const fallback = safeBasename(gitRoot)
  const pkgPath = join(gitRoot, 'package.json')
  if (!existsSync(pkgPath)) return fallback

  try {
    const raw = readFileSync(pkgPath, 'utf-8')
    const parsed = JSON.parse(raw) as { name?: unknown }
    if (typeof parsed?.name !== 'string') return fallback
    const trimmed = parsed.name.trim()
    return trimmed.length ? trimmed : fallback
  } catch {
    return fallback
  }
}

function safeBasename(gitRoot: string): string {
  try {
    return basename(resolve(gitRoot))
  } catch {
    return ''
  }
}
