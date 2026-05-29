import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadAgentEndpoint, postHookToAgent, postTurnThoughtToAgent } from './agent-client.js'

describe('postHookToAgent', () => {
  it('endpoint 为 null 时返回 unconfigured,不发请求', async () => {
    const fakeFetch = (() => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const result = await postHookToAgent({ tokens: 100, source: 'cursor-hook' }, null, fakeFetch)
    expect(result).toEqual({ kind: 'unconfigured' })
  })

  it('agent 返回 OK envelope 时返回 ok', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({
          code: 'OK',
          message: '',
          data: {
            ok: true,
            deduped: false,
            bound: true,
            accumulated: 100,
            cumulativeToken: 100,
            jiraKey: 'INSTANT-1'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const result = await postHookToAgent(
      { projectRoot: '/x', tokens: 100, source: 'cursor-hook', dedupeKey: 'k' },
      { baseUrl: 'http://127.0.0.1:17280', token: 'abc' },
      fakeFetch
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.data.bound).toBe(true)
      expect(result.data.cumulativeToken).toBe(100)
      expect(result.data.jiraKey).toBe('INSTANT-1')
    }
    expect(calls[0].url).toBe('http://127.0.0.1:17280/ai-productivity/hook')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer abc')
    const sentBody = JSON.parse(calls[0].init.body as string)
    expect(sentBody.tokens).toBe(100)
    expect(sentBody.dedupeKey).toBe('k')
  })

  it('agent 返回 401 时返回 http-error', async () => {
    const fakeFetch = (async () =>
      new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    const result = await postHookToAgent(
      { tokens: 1, source: 'cursor-hook' },
      { baseUrl: 'http://127.0.0.1:17280', token: 'wrong' },
      fakeFetch
    )
    expect(result.kind).toBe('http-error')
    if (result.kind === 'http-error') {
      expect(result.status).toBe(401)
    }
  })

  it('网络异常时返回 network-error', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const result = await postHookToAgent(
      { tokens: 1, source: 'cursor-hook' },
      { baseUrl: 'http://127.0.0.1:17280', token: 'x' },
      fakeFetch
    )
    expect(result.kind).toBe('network-error')
    if (result.kind === 'network-error') {
      expect(result.message).toContain('ECONNREFUSED')
    }
  })

  it('agent 返回 ERROR envelope 时归为 http-error', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 'ERROR', message: 'boom', data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })) as unknown as typeof fetch
    const result = await postHookToAgent(
      { tokens: 1, source: 'cursor-hook' },
      { baseUrl: 'http://127.0.0.1:17280', token: 'x' },
      fakeFetch
    )
    expect(result.kind).toBe('http-error')
    if (result.kind === 'http-error') {
      expect(result.message).toBe('boom')
    }
  })
})

describe('postTurnThoughtToAgent 解析 200 响应体(区分 applied / no_pending_turn)', () => {
  const endpoint = { baseUrl: 'http://127.0.0.1:17350', token: 'tok' }

  function okEnvelope(data: unknown): Response {
    return new Response(JSON.stringify({ code: 'OK', message: '', data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  it('applied=true 时透传 totalMs', async () => {
    const fakeFetch = (async () =>
      okEnvelope({ ok: true, applied: true, totalMs: 4200 })) as unknown as typeof fetch
    const result = await postTurnThoughtToAgent(
      { conversationId: 'c1', generationId: 'g1', durationMs: 1200 },
      endpoint,
      fakeFetch
    )
    expect(result).toEqual({ kind: 'ok', applied: true, totalMs: 4200, reason: undefined })
  })

  it('applied=false + no_pending_turn 时透传 reason(竞态丢弃信号)', async () => {
    const fakeFetch = (async () =>
      okEnvelope({
        ok: true,
        applied: false,
        reason: 'no_pending_turn'
      })) as unknown as typeof fetch
    const result = await postTurnThoughtToAgent(
      { conversationId: 'c1', generationId: 'g1', durationMs: 1200 },
      endpoint,
      fakeFetch
    )
    expect(result).toEqual({
      kind: 'ok',
      applied: false,
      totalMs: undefined,
      reason: 'no_pending_turn'
    })
  })

  it('endpoint 为 null → unconfigured,不发请求', async () => {
    const fakeFetch = (() => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch
    const result = await postTurnThoughtToAgent(
      { conversationId: 'c1', generationId: 'g1', durationMs: 1 },
      null,
      fakeFetch
    )
    expect(result).toEqual({ kind: 'unconfigured' })
  })

  it('非 200 → http-error 携带状态码', async () => {
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const result = await postTurnThoughtToAgent(
      { conversationId: 'c1', generationId: 'g1', durationMs: 1 },
      endpoint,
      fakeFetch
    )
    expect(result.kind).toBe('http-error')
    if (result.kind === 'http-error') expect(result.status).toBe(500)
  })

  it('200 但非 OK envelope → http-error', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 'ERROR', message: 'bad envelope', data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })) as unknown as typeof fetch
    const result = await postTurnThoughtToAgent(
      { conversationId: 'c1', generationId: 'g1', durationMs: 1 },
      endpoint,
      fakeFetch
    )
    expect(result.kind).toBe('http-error')
    if (result.kind === 'http-error') expect(result.message).toContain('bad envelope')
  })
})

describe('loadAgentEndpoint', () => {
  let tmpDir: string
  let configPath: string
  const origEnvToken = process.env.AIPT_DAEMON_TOKEN
  const origEnvBase = process.env.AIPT_DAEMON_URL

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aip-hook-core-'))
    configPath = join(tmpDir, 'config.json')
    delete process.env.AIPT_DAEMON_TOKEN
    delete process.env.AIPT_DAEMON_URL
  })

  afterEach(() => {
    if (origEnvToken != null) process.env.AIPT_DAEMON_TOKEN = origEnvToken
    else delete process.env.AIPT_DAEMON_TOKEN
    if (origEnvBase != null) process.env.AIPT_DAEMON_URL = origEnvBase
    else delete process.env.AIPT_DAEMON_URL
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('config.json 不存在且无 env → null', () => {
    expect(loadAgentEndpoint(configPath)).toBeNull()
  })

  it('config.json 有 token + port 时,返回拼好的 baseUrl + token', () => {
    writeFileSync(configPath, JSON.stringify({ token: 'tk', port: 17299 }))
    expect(loadAgentEndpoint(configPath)).toEqual({
      baseUrl: 'http://127.0.0.1:17299',
      token: 'tk'
    })
  })

  it('config.json 缺 port 时默认 17350', () => {
    writeFileSync(configPath, JSON.stringify({ token: 'tk' }))
    expect(loadAgentEndpoint(configPath)).toEqual({
      baseUrl: 'http://127.0.0.1:17350',
      token: 'tk'
    })
  })

  it('env AIPT_DAEMON_TOKEN + AIPT_DAEMON_URL 优先于文件', () => {
    writeFileSync(configPath, JSON.stringify({ token: 'tk-file', port: 17280 }))
    process.env.AIPT_DAEMON_TOKEN = 'tk-env'
    process.env.AIPT_DAEMON_URL = 'http://example.com:9090/'
    expect(loadAgentEndpoint(configPath)).toEqual({
      baseUrl: 'http://example.com:9090',
      token: 'tk-env'
    })
  })

  it('config 解析失败 → 无 env 时返回 null', () => {
    writeFileSync(configPath, '{not json')
    expect(loadAgentEndpoint(configPath)).toBeNull()
  })

  it('config 解析失败 + 仅有 env token → 用默认 baseUrl 兜底', () => {
    writeFileSync(configPath, '{not json')
    process.env.AIPT_DAEMON_TOKEN = 'tk-env'
    expect(loadAgentEndpoint(configPath)).toEqual({
      baseUrl: 'http://127.0.0.1:17350',
      token: 'tk-env'
    })
  })

  it('config 无 token 时返回 null', () => {
    writeFileSync(configPath, JSON.stringify({ port: 17280 }))
    expect(loadAgentEndpoint(configPath)).toBeNull()
  })
})
