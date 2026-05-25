import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { applyCors, isLocalOrigin, isPanelOriginAllowed } from './cors.js'
import type { ServerConfig } from '../config.js'

const baseConfig: ServerConfig = {
  token: 't',
  port: 17350,
  host: '127.0.0.1',
  allowedOrigins: []
}

function makeReq(headers: Record<string, string | undefined>, method = 'GET'): IncomingMessage {
  const normalized: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') normalized[k.toLowerCase()] = v
  }
  return { headers: normalized, method } as unknown as IncomingMessage
}

function makeRes(): ServerResponse & { _status?: number; _ended?: boolean } {
  const headers = new Map<string, string>()
  const res = {
    _status: undefined as number | undefined,
    _ended: false,
    setHeader(k: string, v: string) {
      headers.set(k.toLowerCase(), v)
    },
    getHeader(k: string) {
      return headers.get(k.toLowerCase())
    },
    writeHead(status: number) {
      res._status = status
    },
    end() {
      res._ended = true
    }
  }
  return res as unknown as ServerResponse & { _status?: number; _ended?: boolean }
}

describe('isLocalOrigin', () => {
  it('放行 loopback hostname', () => {
    expect(isLocalOrigin('http://127.0.0.1:17350')).toBe(true)
    expect(isLocalOrigin('http://localhost:5173')).toBe(true)
    expect(isLocalOrigin('http://app.localhost:8080')).toBe(true)
  })

  it('拒绝非 loopback 域名', () => {
    expect(isLocalOrigin('https://example.com')).toBe(false)
    expect(isLocalOrigin('http://192.168.1.10:17350')).toBe(false)
  })

  it('恶意/非法 URL 返回 false 不抛错', () => {
    expect(isLocalOrigin('not a url')).toBe(false)
    expect(isLocalOrigin('')).toBe(false)
  })
})

describe('isPanelOriginAllowed', () => {
  it('Origin 是 loopback → 放行', () => {
    const req = makeReq({ origin: 'http://127.0.0.1:17350' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('Origin 命中 allowedOrigins 白名单 → 放行', () => {
    const req = makeReq({ origin: 'https://panel.example.com' })
    expect(
      isPanelOriginAllowed({ ...baseConfig, allowedOrigins: ['https://panel.example.com'] }, req)
    ).toBe(true)
  })

  it('Origin 跨域且不在白名单 → 拒绝', () => {
    const req = makeReq({ origin: 'https://evil.com' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
  })

  // 关键回归:浏览器同源 GET 不发 Origin,401 根因场景
  it('无 Origin、Referer 是 loopback → 放行(同源 GET 兜底)', () => {
    const req = makeReq({ referer: 'http://127.0.0.1:17350/' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('无 Origin、Referer 是 SPA hash 路由 → 仍能解析 origin 放行', () => {
    const req = makeReq({ referer: 'http://127.0.0.1:17350/#/workspace' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('无 Origin、Referer 在白名单 → 放行', () => {
    const req = makeReq({ referer: 'https://panel.example.com/dashboard' })
    expect(
      isPanelOriginAllowed({ ...baseConfig, allowedOrigins: ['https://panel.example.com'] }, req)
    ).toBe(true)
  })

  it('无 Origin、Referer 跨域且不在白名单 → 不放行(若无 Sec-Fetch-Site)', () => {
    const req = makeReq({ referer: 'https://evil.com/' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
  })

  it('无 Origin/Referer、Sec-Fetch-Site=same-origin → 放行(Referer 被隐私策略屏蔽兜底)', () => {
    const req = makeReq({ 'sec-fetch-site': 'same-origin' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('Sec-Fetch-Site=same-site → 放行', () => {
    const req = makeReq({ 'sec-fetch-site': 'same-site' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('Sec-Fetch-Site=cross-site → 拒绝', () => {
    const req = makeReq({ 'sec-fetch-site': 'cross-site' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
  })

  it('Sec-Fetch-Site=none(地址栏直接访问) → 拒绝(应该走 webRoot 静态资源而不是 panel API)', () => {
    const req = makeReq({ 'sec-fetch-site': 'none' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
  })

  it('Sec-Fetch-Site 值大小写不敏感', () => {
    const req = makeReq({ 'sec-fetch-site': 'Same-Origin' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })

  it('三个头全无 → 拒绝(curl / Hook 等无浏览器上下文的客户端必须走 token)', () => {
    const req = makeReq({})
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
  })

  it('Referer 是损坏字符串 → 不抛错,继续走 Sec-Fetch-Site 兜底', () => {
    const req = makeReq({ referer: '<<<not a url>>>' })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(false)
    const req2 = makeReq({ referer: '<<<not a url>>>', 'sec-fetch-site': 'same-origin' })
    expect(isPanelOriginAllowed(baseConfig, req2)).toBe(true)
  })

  it('恶意构造的 Origin 与同源 Referer 冲突时,Referer 兜底仍生效(防 Origin 投毒)', () => {
    // 即便 Origin 是 evil.com,只要 Referer 还是 loopback,我们依然放行;
    // 因为 daemon 只听 127.0.0.1,evil.com 实际无法发起请求到本机,
    // 这种诡异组合只可能是测试/代理人为构造,不要因此误杀正常本机请求。
    const req = makeReq({
      origin: 'https://evil.com',
      referer: 'http://127.0.0.1:17350/'
    })
    expect(isPanelOriginAllowed(baseConfig, req)).toBe(true)
  })
})

describe('applyCors', () => {
  it('同源 loopback Origin → 写回 ACAO + Credentials', () => {
    const req = makeReq({ origin: 'http://127.0.0.1:17350' })
    const res = makeRes()
    const consumed = applyCors(res, baseConfig, req)
    expect(consumed).toBe(false)
    expect(res.getHeader('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:17350')
    expect(res.getHeader('Access-Control-Allow-Credentials')).toBe('true')
  })

  it('OPTIONS preflight → 直接 204 并返回 true', () => {
    const req = makeReq({ origin: 'http://127.0.0.1:17350' }, 'OPTIONS')
    const res = makeRes()
    const consumed = applyCors(res, baseConfig, req)
    expect(consumed).toBe(true)
    expect(res._status).toBe(204)
    expect(res._ended).toBe(true)
  })

  it('跨域且不在白名单 → 不写 ACAO,但仍放过让主路由走 token 校验', () => {
    const req = makeReq({ origin: 'https://evil.com' })
    const res = makeRes()
    const consumed = applyCors(res, baseConfig, req)
    expect(consumed).toBe(false)
    expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined()
  })

  it('private-network preflight 请求头 → 回写 Allow-Private-Network', () => {
    const req = makeReq({
      origin: 'http://127.0.0.1:17350',
      'access-control-request-private-network': 'true'
    })
    const res = makeRes()
    applyCors(res, baseConfig, req)
    expect(res.getHeader('Access-Control-Allow-Private-Network')).toBe('true')
  })
})
