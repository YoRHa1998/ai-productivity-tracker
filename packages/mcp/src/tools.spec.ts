import { describe, it, expect, vi } from 'vitest'
import { registerAiProductivityTools } from './tools.js'
import { AgentClient, AgentClientError } from './agent-client.js'

interface CapturedTool {
  name: string
  config: { description: string; inputSchema: unknown }
  handler: (
    args: unknown
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>
}

class FakeServer {
  tools: CapturedTool[] = []
  registerTool(
    name: string,
    config: CapturedTool['config'],
    handler: CapturedTool['handler']
  ): void {
    this.tools.push({ name, config, handler })
  }
}

function fakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  const base: Partial<AgentClient> = {
    async init() {
      return { jiraKey: 'ABC-1', branch: 'b', gitRoot: '/r', panelUrl: 'https://x/y' }
    },
    async status() {
      return {
        bound: true,
        branch: 'b',
        issueKey: 'ABC-1',
        jiraKey: 'ABC-1',
        cumulativeToken: 100,
        startedAt: null,
        gitRoot: '/r'
      }
    }
  }
  return { ...base, ...overrides } as AgentClient
}

describe('registerAiProductivityTools', () => {
  it('注册 init / status / attach_summary / extract_bundle / save_lessons 共 5 个 tool', () => {
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient()
    )
    const names = server.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'ai_productivity_attach_summary',
      'ai_productivity_extract_bundle',
      'ai_productivity_init',
      'ai_productivity_save_lessons',
      'ai_productivity_status'
    ])
  })

  it('ai_productivity_init 调用 client.init 并把结果文本化', async () => {
    const initSpy = vi.fn().mockResolvedValue({
      jiraKey: 'ABC-42',
      branch: 'feature/ABC-42-x',
      gitRoot: '/r',
      panelUrl: 'https://p/42'
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ init: initSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_init')!
    const result = await tool.handler({
      jira: 'https://jira/browse/ABC-42',
      title: 'New',
      projectRoot: '/r'
    })
    expect(initSpy).toHaveBeenCalledWith({
      jiraInput: 'https://jira/browse/ABC-42',
      title: 'New',
      projectRoot: '/r',
      summary: undefined,
      manualEstimateMinutes: undefined,
      complexity: undefined
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('ABC-42')
    expect(result.content[0].text).toContain('https://p/42')
    expect(result.content[0].text).toContain('~/.ai-productivity-tracker')
  })

  it('init 失败时返回 isError=true 与错误信息', async () => {
    const initSpy = vi.fn().mockRejectedValue(new AgentClientError(412, '请先配置'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ init: initSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_init')!
    const result = await tool.handler({ jira: 'ABC-1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('请先配置')
  })

  it('daemon 不可达(status=0)时附加引导用户检查 daemon 的文案', async () => {
    const initSpy = vi
      .fn()
      .mockRejectedValue(new AgentClientError(0, '本地 agent 不可达: ECONNREFUSED'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ init: initSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_init')!
    const result = await tool.handler({ jira: 'ABC-1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ai-productivity-tracker daemon 似乎没有运行')
    expect(result.content[0].text).toContain('ai-productivity-tracker doctor')
  })

  it('401 时附加 runtime.json token 不一致的引导', async () => {
    const initSpy = vi.fn().mockRejectedValue(new AgentClientError(401, '未授权'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ init: initSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_init')!
    const result = await tool.handler({ jira: 'ABC-1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('runtime.json')
  })

  it('其它错误不会附加引导文案', async () => {
    const initSpy = vi.fn().mockRejectedValue(new AgentClientError(500, '内部错误'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ init: initSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_init')!
    const result = await tool.handler({ jira: 'ABC-1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('daemon 似乎没有运行')
    expect(result.content[0].text).not.toContain('runtime.json')
  })

  it('ai_productivity_status 调用 client.status 并文本化输出', async () => {
    const statusSpy = vi.fn().mockResolvedValue({
      bound: true,
      branch: 'feature/ABC-1',
      issueKey: 'ABC-1',
      jiraKey: 'ABC-1',
      cumulativeToken: 5000,
      startedAt: null,
      gitRoot: '/r'
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ status: statusSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_status')!
    const result = await tool.handler({ projectRoot: '/r' })
    expect(statusSpy).toHaveBeenCalledWith({ projectRoot: '/r' })
    expect(result.content[0].text).toContain('ABC-1')
    expect(result.content[0].text).toContain('5000')
  })

  it('ai_productivity_attach_summary coding 分支:把结构化字段透传到 client.attachSummary', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      pending: true,
      jiraKey: 'ABC-9',
      iterationSeq: null
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    const result = await tool.handler({
      oneLine: '升级 attach-summary 为结构化字段',
      type: 'coding',
      changeScope: 'mcp tools / agent-client / route 三层联动'
    })
    expect(attachSpy).toHaveBeenCalledWith({
      oneLine: '升级 attach-summary 为结构化字段',
      type: 'coding',
      changeScope: 'mcp tools / agent-client / route 三层联动',
      discussion: undefined,
      jiraKey: undefined,
      branch: undefined,
      source: undefined,
      cwd: undefined
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('attached')
    expect(result.content[0].text).toContain('ABC-9')
    // v2.7.0 起 attached 不再带 #seq,改成 pending 提示
    expect(result.content[0].text).toContain('pending')
    expect(result.content[0].text).not.toMatch(/#\d/)
  })

  it('ai_productivity_attach_summary communication 分支:跳过时输出 skipped+reason', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: false,
      jiraKey: 'ABC-3',
      iterationSeq: null,
      reason: 'no_iteration'
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    const result = await tool.handler({
      oneLine: '讨论了 schema 设计取舍',
      type: 'communication',
      discussion: '比较了「字符串扁平化」与「嵌套对象 + lazy normalize」两种方案'
    })
    expect(attachSpy).toHaveBeenCalledWith({
      oneLine: '讨论了 schema 设计取舍',
      type: 'communication',
      changeScope: undefined,
      discussion: '比较了「字符串扁平化」与「嵌套对象 + lazy normalize」两种方案',
      jiraKey: undefined,
      branch: undefined,
      source: undefined,
      cwd: undefined
    })
    expect(result.content[0].text).toContain('skipped')
    expect(result.content[0].text).toContain('no_iteration')
    expect(result.content[0].text).toContain('ABC-3')
  })

  it('ai_productivity_attach_summary v2.5.0 透传 source=claude-code', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      jiraKey: 'ABC-1',
      iterationSeq: 3
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    await tool.handler({
      oneLine: 'Claude 端硬编码 source',
      type: 'communication',
      discussion: '验证 source 透传',
      source: 'claude-code'
    })
    expect(attachSpy).toHaveBeenCalledWith(expect.objectContaining({ source: 'claude-code' }))
  })

  it('ai_productivity_attach_summary v2.5.0 透传 source=cursor', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      jiraKey: 'ABC-1',
      iterationSeq: 4
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    await tool.handler({
      oneLine: 'Cursor rule 硬编码 source',
      type: 'communication',
      discussion: '验证 source 透传',
      source: 'cursor'
    })
    expect(attachSpy).toHaveBeenCalledWith(expect.objectContaining({ source: 'cursor' }))
  })

  it('ai_productivity_attach_summary v2.5.1 透传显式 cwd', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      jiraKey: 'ABC-1',
      iterationSeq: 5
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    await tool.handler({
      oneLine: '验证 cwd 透传',
      type: 'communication',
      discussion: 'cwd 透传链路',
      source: 'cursor',
      cwd: '/Users/x/repo'
    })
    expect(attachSpy).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/Users/x/repo' }))
  })

  // v2.12.0:zod schema 删 max 后,超长字段不再被 MCP SDK 拦截,直接透传给 client。
  // 截断由 agent 端 `resolveAttachSummary` 完成,zod 层只做必填校验。
  it('ai_productivity_attach_summary v2.12.0:oneLine/changeScope/discussion 超长字段不被 zod 拦截,完整透传给 client', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      pending: true,
      jiraKey: 'ABC-9',
      iterationSeq: null
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!

    const longOneLine = 'A'.repeat(500)
    const longChangeScope = 'B'.repeat(800)
    await tool.handler({
      oneLine: longOneLine,
      type: 'coding',
      changeScope: longChangeScope
    })
    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oneLine: longOneLine,
        type: 'coding',
        changeScope: longChangeScope
      })
    )

    attachSpy.mockClear()
    const longDiscussion = 'C'.repeat(1500)
    await tool.handler({
      oneLine: longOneLine,
      type: 'communication',
      discussion: longDiscussion
    })
    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oneLine: longOneLine,
        type: 'communication',
        discussion: longDiscussion
      })
    )
  })

  // v2.13.3:type 改成 .optional() 后,LLM 漏传 type 不再被 zod 拦,完整透传给 client。
  // agent 端按 communication 兜底处理。
  it('ai_productivity_attach_summary v2.13.3:缺 type 字段不被 zod 拦,完整透传给 client', async () => {
    const attachSpy = vi.fn().mockResolvedValue({
      ok: true,
      updated: true,
      pending: true,
      jiraKey: 'ABC-9',
      iterationSeq: null
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!

    await tool.handler({
      oneLine: '只填了 oneLine,type 缺失'
    })
    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oneLine: '只填了 oneLine,type 缺失',
        type: undefined
      })
    )
  })

  it('ai_productivity_attach_summary agent 报错时返回 isError=true 并附状态码', async () => {
    const attachSpy = vi.fn().mockRejectedValue(new AgentClientError(400, 'changeScope 不能为空'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ attachSummary: attachSpy })
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_attach_summary')!
    const result = await tool.handler({
      oneLine: '一句话',
      type: 'coding'
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('changeScope 不能为空')
    expect(result.content[0].text).toContain('400')
  })

  // v2.16.0 P0 lessons-extract: ai_productivity_extract_bundle + ai_productivity_save_lessons

  it('注册 v2.16.0 lessons-extract 配套两个新 tool', () => {
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient()
    )
    const names = server.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'ai_productivity_attach_summary',
      'ai_productivity_extract_bundle',
      'ai_productivity_init',
      'ai_productivity_save_lessons',
      'ai_productivity_status'
    ])
  })

  it('ai_productivity_extract_bundle 调 client.extractBundle 并把 JSON 文本化', async () => {
    const bundleSpy = vi.fn().mockResolvedValue({
      jiraKey: 'INSTANT-5321',
      requirement: { jiraKey: 'INSTANT-5321', title: 'demo' },
      iterations: [{ seq: 1 }, { seq: 2 }],
      existingLessons: []
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ extractBundle: bundleSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_extract_bundle')!
    const result = await tool.handler({ jiraKey: 'INSTANT-5321' })
    expect(bundleSpy).toHaveBeenCalledWith({ jiraKey: 'INSTANT-5321', cwd: undefined })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('INSTANT-5321')
    expect(result.content[0].text).toContain('iterations: 2')
    expect(result.content[0].text).toContain('BUNDLE_JSON_BEGIN')
    expect(result.content[0].text).toContain('BUNDLE_JSON_END')
  })

  it('ai_productivity_save_lessons 透传 jiraKey 兜底到每条 lesson, 并文本化 saved/replaced/rejected', async () => {
    const saveSpy = vi.fn().mockResolvedValue({
      saved: [{ id: 'lsn-XYZ-123', type: 'pitfall', title: '坑1' }],
      savedCount: 1,
      replaced: [],
      rejected: [{ index: 1, reason: 'type 必须是 ...' }]
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ saveLessons: saveSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_save_lessons')!
    const result = await tool.handler({
      jiraKey: 'INSTANT-5321',
      lessons: [{ type: 'pitfall', title: '坑1', content: '描述', jiraKey: '' }]
    })
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: 'INSTANT-5321',
        lessons: [expect.objectContaining({ jiraKey: 'INSTANT-5321', type: 'pitfall' })]
      })
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已落盘 1 条经验')
    expect(result.content[0].text).toContain('拒收')
    expect(result.content[0].text).toContain('复盘经验')
  })

  it('ai_productivity_save_lessons agent 报错返回 isError=true', async () => {
    const saveSpy = vi.fn().mockRejectedValue(new AgentClientError(404, '需求未找到'))
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ saveLessons: saveSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_save_lessons')!
    const result = await tool.handler({
      jiraKey: 'NONE-1',
      lessons: [{ type: 'rule', title: 'r', content: 'c', jiraKey: 'NONE-1' }]
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('需求未找到')
  })

  // v2.17.0:lessons=[] 静默路径 + scope/projectSlug 透传 + bundle currentProjectSlug 展示
  it('ai_productivity_save_lessons v2.17.0:lessons=[] 静默路径,文案告知用户「未沉淀」', async () => {
    const saveSpy = vi.fn().mockResolvedValue({
      saved: [],
      savedCount: 0,
      replaced: [],
      rejected: []
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ saveLessons: saveSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_save_lessons')!
    const result = await tool.handler({
      jiraKey: 'INSTANT-9000',
      lessons: []
    })
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ jiraKey: 'INSTANT-9000', lessons: [] })
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('未沉淀新经验')
    expect(result.content[0].text).not.toContain('已落盘')
  })

  it('ai_productivity_save_lessons v2.17.0:scope/projectSlug 完整透传到 client', async () => {
    const saveSpy = vi.fn().mockResolvedValue({
      saved: [{ id: 'lsn-X-1', type: 'rule', title: 't' }],
      savedCount: 1,
      replaced: [],
      rejected: []
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ saveLessons: saveSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_save_lessons')!
    await tool.handler({
      jiraKey: 'INSTANT-9001',
      projectSlug: 'app-batch-slug',
      lessons: [
        {
          jiraKey: 'INSTANT-9001',
          type: 'rule',
          title: '项目规则',
          content: 'c',
          scope: 'project',
          projectSlug: 'my-app'
        },
        {
          jiraKey: 'INSTANT-9001',
          type: 'pitfall',
          title: '通用坑',
          content: 'c',
          scope: 'general'
        }
      ]
    })
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: 'INSTANT-9001',
        projectSlug: 'app-batch-slug',
        lessons: [
          expect.objectContaining({ scope: 'project', projectSlug: 'my-app' }),
          expect.objectContaining({ scope: 'general' })
        ]
      })
    )
  })

  it('ai_productivity_extract_bundle v2.17.0:输出展示 currentProjectSlug', async () => {
    const bundleSpy = vi.fn().mockResolvedValue({
      jiraKey: 'INSTANT-9100',
      currentProjectSlug: 'truesight-web-tools',
      requirement: { jiraKey: 'INSTANT-9100', title: 'demo' },
      iterations: [],
      existingLessons: []
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ extractBundle: bundleSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_extract_bundle')!
    const result = await tool.handler({ jiraKey: 'INSTANT-9100' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('currentProjectSlug: truesight-web-tools')
    expect(result.content[0].text).toContain('BUNDLE_JSON_BEGIN')
  })

  // v2.18.0:extract_bundle 输出在 BUNDLE_JSON 前追加客观信号可读摘要
  it('ai_productivity_extract_bundle v2.18.0:输出含「=== 客观信号 ===」摘要(boost / topThinkSeqs / fileChurnMap)', async () => {
    const bundleSpy = vi.fn().mockResolvedValue({
      jiraKey: 'INSTANT-5321',
      currentProjectSlug: 'truesight-web-tools',
      requirement: { jiraKey: 'INSTANT-5321', title: 'demo' },
      iterations: [],
      existingLessons: [],
      computedSignals: {
        boost: 8.2,
        linkedBugCount: 0,
        cumulativeEffectiveTokens: 234_000,
        cumulativeThinkSeconds: 421,
        fileChurnMap: [
          {
            path: 'apps/local-agent-service/src/services/foo.ts',
            insertions: 120,
            deletions: 80,
            touchedSeqs: [2, 3, 5, 7, 11]
          }
        ],
        abnormalStopReasons: [],
        topThinkSeqs: [12, 7, 19]
      }
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ extractBundle: bundleSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_extract_bundle')!
    const result = await tool.handler({ jiraKey: 'INSTANT-5321' })
    expect(result.isError).toBeUndefined()
    const text = result.content[0].text
    expect(text).toContain('=== 客观信号(供 LLM 推理参考)===')
    expect(text).toContain('boost: 8.20x')
    expect(text).toContain('linkedBugCount: 0')
    expect(text).toMatch(/234\.0k/)
    expect(text).toMatch(/7\.0min|7min/)
    expect(text).toContain('top 3 思考时长轮次: #12 #7 #19')
    expect(text).toContain('apps/local-agent-service/src/services/foo.ts')
    expect(text).toContain('反复修改文件')
    expect(text).toContain('+120 -80')
    // 摘要必须在 BUNDLE_JSON_BEGIN 之前
    expect(text.indexOf('=== 客观信号')).toBeLessThan(text.indexOf('BUNDLE_JSON_BEGIN'))
  })

  it('ai_productivity_extract_bundle v2.18.0:老 agent 缺 computedSignals 时降级,不输出摘要块', async () => {
    const bundleSpy = vi.fn().mockResolvedValue({
      jiraKey: 'INSTANT-LEGACY',
      currentProjectSlug: '',
      requirement: { jiraKey: 'INSTANT-LEGACY', title: 'legacy' },
      iterations: [{ seq: 1 }],
      existingLessons: []
      // 故意缺 computedSignals
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ extractBundle: bundleSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_extract_bundle')!
    const result = await tool.handler({ jiraKey: 'INSTANT-LEGACY' })
    expect(result.isError).toBeUndefined()
    const text = result.content[0].text
    expect(text).not.toContain('=== 客观信号')
    // 仍然输出 BUNDLE_JSON 主体,保证老 agent 兼容
    expect(text).toContain('BUNDLE_JSON_BEGIN')
    expect(text).toContain('INSTANT-LEGACY')
  })

  // v2.18.0:lessonInputSchema 不强制 LLM 传 signals/trustReasons(由 agent 端注入)
  it('ai_productivity_save_lessons v2.18.0:LLM 不传 signals/trustReasons 时 zod 不拦,完整透传', async () => {
    const saveSpy = vi.fn().mockResolvedValue({
      saved: [{ id: 'lsn-X', type: 'pitfall', title: 't' }],
      savedCount: 1,
      replaced: [],
      rejected: []
    })
    const server = new FakeServer()
    registerAiProductivityTools(
      server as unknown as Parameters<typeof registerAiProductivityTools>[0],
      fakeClient({ saveLessons: saveSpy } as Partial<AgentClient>)
    )
    const tool = server.tools.find((t) => t.name === 'ai_productivity_save_lessons')!
    const result = await tool.handler({
      jiraKey: 'INSTANT-9200',
      lessons: [
        {
          jiraKey: 'INSTANT-9200',
          type: 'pitfall',
          title: '坑',
          content: '只填了必填字段'
          // 不填 signals / trustReasons / seenInJiraKeys / hitCount,这些是 agent 端自动注入
        }
      ]
    })
    expect(result.isError).toBeUndefined()
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        lessons: [expect.objectContaining({ type: 'pitfall', title: '坑' })]
      })
    )
  })
})
