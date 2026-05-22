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
 */
export function isPanelOriginAllowed(config: ServerConfig, req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  if (isLocalOrigin(origin)) return true
  if (config.allowedOrigins.includes(origin)) return true
  return false
}
