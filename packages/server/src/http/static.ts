import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

/**
 * 看板 SPA 静态服务:
 *
 * - 精确命中文件 → 直接 stream
 * - 命中目录 → fallback `<dir>/index.html`
 * - 其它 (含 history mode 的子路径) → fallback `<webRoot>/index.html`,让 Vue Router 接管
 *
 * 在路径解析层做 traversal 防御:解析后的 abs 必须以 webRoot 开头。
 */
export function serveStatic(res: ServerResponse, webRoot: string, urlPath: string): boolean {
  const cleanPath = urlPath.split('?')[0]!.split('#')[0]!
  const safeWebRoot = resolve(webRoot)
  let target = resolve(safeWebRoot, '.' + cleanPath)
  if (!target.startsWith(safeWebRoot + sep) && target !== safeWebRoot) {
    target = safeWebRoot
  }

  if (existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, 'index.html')
  }

  if (!existsSync(target)) {
    const fallback = join(safeWebRoot, 'index.html')
    if (existsSync(fallback)) {
      streamFile(res, fallback)
      return true
    }
    return false
  }

  streamFile(res, target)
  return true
}

function streamFile(res: ServerResponse, abs: string): void {
  const ext = extname(abs).toLowerCase()
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  })
  createReadStream(abs).pipe(res)
}
