import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ServerConfig } from '../config.js'

/**
 * 同源 loopback (127.0.0.1 / localhost / *.localhost) 默认放行;
 * config.allowedOrigins 内显式列出的额外域名也放行。
 *
 * 不再硬编码任何业务域名(对比源仓库 web-tool-platform 系列)。
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const host = url.hostname
    return host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * 写入 CORS 响应头。如果是 OPTIONS preflight,直接 204 应答并返回 true,主路由跳过。
 */
export function applyCors(
  res: ServerResponse,
  config: ServerConfig,
  req: IncomingMessage
): boolean {
  const origin = req.headers.origin
  if (origin && (isLocalOrigin(origin) || config.allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

/**
 * `panel-origin` 放行规则:同源(本机 loopback)或 config.allowedOrigins 命中时,
 * 看板路由免 Bearer token 鉴权;IDE/Hook 主链路仍要 token。
 *
 * 兜底链(按优先级):
 *  1. `Origin` 命中 loopback / allowedOrigins
 *  2. `Referer` 命中 loopback / allowedOrigins(用于同源 GET/HEAD;
 *     Fetch 标准下浏览器默认不发 Origin)
 *  3. `Sec-Fetch-Site: same-origin | same-site`(现代浏览器同源 GET 必发,
 *     作为 Referer 被隐私策略屏蔽时的二次兜底)
 *
 * 设计原因:daemon 同源托管看板 SPA 时,首屏批量 GET 不带 Origin,
 * 仅靠 `Origin` 判定会让所有 panel 路由统一回 401(见 README 401 Troubleshooting)。
 */
export function isPanelOriginAllowed(config: ServerConfig, req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin) {
    if (isLocalOrigin(origin)) return true
    if (config.allowedOrigins.includes(origin)) return true
  }

  const referer = req.headers.referer
  if (typeof referer === 'string' && referer.length > 0) {
    const refererOrigin = parseOrigin(referer)
    if (refererOrigin) {
      if (isLocalOrigin(refererOrigin)) return true
      if (config.allowedOrigins.includes(refererOrigin)) return true
    }
  }

  const secFetchSite = req.headers['sec-fetch-site']
  if (typeof secFetchSite === 'string') {
    const v = secFetchSite.toLowerCase()
    if (v === 'same-origin' || v === 'same-site') return true
  }

  return false
}

function parseOrigin(urlLike: string): string | null {
  try {
    const u = new URL(urlLike)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}
