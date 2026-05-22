import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentClient, AgentClientError } from './agent-client.js'

const originalFetch = globalThis.fetch

describe('AgentClient', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('init 调用 POST /ai-productivity/init 并带 Bearer', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 'OK',
          message: '',
          data: {
            jiraKey: 'ABC-1',
            branch: 'feature/ABC-1',
            gitRoot: '/x',
            panelUrl: 'https://p/x'
          }
        })
    })

    const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 'agt-tok' })
    const result = await c.init({ jiraInput: 'ABC-1', title: 't', projectRoot: '/x' })
    expect(result.jiraKey).toBe('ABC-1')

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('http://127.0.0.1:17280/ai-productivity/init')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer agt-tok')
  })

  it('status 调用 GET /ai-productivity/status?projectRoot=', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 'OK',
          message: '',
          data: {
            bound: false,
            branch: 'main',
            issueKey: null,
            requirementId: null,
            cumulativeToken: 0,
            startedAt: null,
            gitRoot: '/x'
          }
        })
    })
    const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
    await c.status({ projectRoot: '/x/y' })
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('http://127.0.0.1:17280/ai-productivity/status?projectRoot=%2Fx%2Fy')
  })

  it('网络错误抛出 AgentClientError 且 status=0', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    )
    const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
    await expect(c.status({})).rejects.toMatchObject({
      name: 'AgentClientError',
      status: 0
    })
  })

  it('HTTP 412 抛出 AgentClientError 并保留 status 与 message', async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 412,
      text: async () => JSON.stringify({ code: 'ERROR', message: '请先配置', data: null })
    })
    const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
    try {
      await c.init({ jiraInput: 'X-1', projectRoot: '/x' })
      throw new Error('should fail')
    } catch (err) {
      expect(err).toBeInstanceOf(AgentClientError)
      expect((err as AgentClientError).status).toBe(412)
      expect((err as AgentClientError).message).toBe('请先配置')
    }
  })

  describe('attachSummary cwd 自动注入 (v2.5.1 / v2.7.3)', () => {
    const ORIGINAL_CLAUDE = process.env.CLAUDE_PROJECT_DIR
    const ORIGINAL_CURSOR = process.env.CURSOR_PROJECT_DIR
    const ORIGINAL_WORKSPACE = process.env.WORKSPACE_FOLDER_PATHS

    beforeEach(() => {
      delete process.env.CLAUDE_PROJECT_DIR
      delete process.env.CURSOR_PROJECT_DIR
      delete process.env.WORKSPACE_FOLDER_PATHS
    })

    afterEach(() => {
      if (ORIGINAL_CLAUDE !== undefined) process.env.CLAUDE_PROJECT_DIR = ORIGINAL_CLAUDE
      else delete process.env.CLAUDE_PROJECT_DIR
      if (ORIGINAL_CURSOR !== undefined) process.env.CURSOR_PROJECT_DIR = ORIGINAL_CURSOR
      else delete process.env.CURSOR_PROJECT_DIR
      if (ORIGINAL_WORKSPACE !== undefined) process.env.WORKSPACE_FOLDER_PATHS = ORIGINAL_WORKSPACE
      else delete process.env.WORKSPACE_FOLDER_PATHS
    })

    function mockOk(): void {
      ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 'OK',
            message: '',
            data: { ok: true, updated: true, jiraKey: 'ABC-1', iterationSeq: 1 }
          })
      })
    }

    function mockInitOk(): void {
      ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 'OK',
            message: '',
            data: {
              jiraKey: 'ABC-1',
              branch: 'feature/ABC-1',
              gitRoot: '/x',
              panelUrl: 'https://p/x'
            }
          })
      })
    }

    function mockStatusOk(): void {
      ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 'OK',
            message: '',
            data: {
              bound: false,
              branch: 'main',
              issueKey: null,
              requirementId: null,
              cumulativeToken: 0,
              startedAt: null,
              gitRoot: '/x'
            }
          })
      })
    }

    function readBody(): Record<string, unknown> {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      const init = call[1] as RequestInit
      return JSON.parse(init.body as string) as Record<string, unknown>
    }

    function readUrl(): string {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      return call[0] as string
    }

    it('显式 cwd 优先于环境变量', async () => {
      process.env.CLAUDE_PROJECT_DIR = '/env/claude'
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({
        oneLine: 'x',
        type: 'communication',
        discussion: 'd',
        cwd: '/explicit'
      })
      expect(readBody().cwd).toBe('/explicit')
    })

    it('未传 cwd 时优先取 CLAUDE_PROJECT_DIR', async () => {
      process.env.CLAUDE_PROJECT_DIR = '/env/claude'
      process.env.CURSOR_PROJECT_DIR = '/env/cursor'
      process.env.WORKSPACE_FOLDER_PATHS = '/env/workspace'
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe('/env/claude')
    })

    it('CLAUDE_PROJECT_DIR 缺失时取 CURSOR_PROJECT_DIR', async () => {
      process.env.CURSOR_PROJECT_DIR = '/env/cursor'
      process.env.WORKSPACE_FOLDER_PATHS = '/env/workspace'
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe('/env/cursor')
    })

    it('v2.7.3 CURSOR/CLAUDE PROJECT_DIR 缺失时取 WORKSPACE_FOLDER_PATHS 单值', async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '/Users/me/conductor/workspaces/instant-workspace/minsk'
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe('/Users/me/conductor/workspaces/instant-workspace/minsk')
    })

    it("v2.7.3 WORKSPACE_FOLDER_PATHS ':' 分隔多工作区时取首项", async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '/Users/me/repoA:/Users/me/repoB'
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe('/Users/me/repoA')
    })

    it('v2.7.3 WORKSPACE_FOLDER_PATHS 全为空白时跳过, fallback 到 process.cwd()', async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '  :  '
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe(process.cwd())
    })

    it('三个 env 都缺失时 fallback 到 process.cwd()', async () => {
      mockOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.attachSummary({ oneLine: 'x', type: 'communication', discussion: 'd' })
      expect(readBody().cwd).toBe(process.cwd())
    })

    it('v2.7.3 init 也用 resolveClientCwd 自动注入 WORKSPACE_FOLDER_PATHS 为 projectRoot', async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '/Users/me/repoA'
      mockInitOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.init({ jiraInput: 'ABC-1' })
      expect(readBody().projectRoot).toBe('/Users/me/repoA')
    })

    it('v2.7.3 init 显式 projectRoot 仍优先于 WORKSPACE_FOLDER_PATHS', async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '/Users/me/repoA'
      mockInitOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.init({ jiraInput: 'ABC-1', projectRoot: '/explicit' })
      expect(readBody().projectRoot).toBe('/explicit')
    })

    it('v2.7.3 status 也自动注入 WORKSPACE_FOLDER_PATHS 为 projectRoot query 参数', async () => {
      process.env.WORKSPACE_FOLDER_PATHS = '/Users/me/repoA'
      mockStatusOk()
      const c = new AgentClient({ baseUrl: 'http://127.0.0.1:17280', token: 't' })
      await c.status({})
      expect(readUrl()).toBe(
        'http://127.0.0.1:17280/ai-productivity/status?projectRoot=%2FUsers%2Fme%2FrepoA'
      )
    })
  })
})
