import { describe, it, expect } from 'vitest'
import {
  parseClaudeJsonlLine,
  parseClaudeStopHookSummary,
  parseClaudeUserMessage,
  effectiveTokens
} from './claude-message.js'

function assistantLine(
  overrides: Record<string, unknown> = {},
  usageOverrides: Record<string, unknown> = {},
  messageOverrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'assistant',
    uuid: 'u-1',
    sessionId: 's-1',
    cwd: '/Users/x/proj',
    gitBranch: 'feature/ABC-1-test',
    timestamp: '2026-05-14T03:26:38.071Z',
    version: '2.1.74',
    message: {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: 'end_turn',
      ...messageOverrides,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 100,
        ...usageOverrides
      }
    },
    ...overrides
  })
}

describe('parseClaudeJsonlLine', () => {
  it('解析 assistant message 的全部关键字段', () => {
    const result = parseClaudeJsonlLine(assistantLine())
    expect(result).toEqual({
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      sessionId: 's-1',
      uuid: 'u-1',
      timestamp: '2026-05-14T03:26:38.071Z',
      model: 'claude-sonnet-4-6',
      apiMessageId: 'm',
      stopReason: 'end_turn',
      tokens: { input: 10, output: 20, cacheCreation: 5, cacheRead: 100, total: 135 }
    })
  })

  it('v2.9.4 解析 message.id 写入 apiMessageId(\u540c\u4e00\u6b21 API \u54cd\u5e94\u88ab\u62c6\u591a\u884c\u65f6\u5171\u4eab\u8be5\u503c)', () => {
    const result = parseClaudeJsonlLine(
      assistantLine({}, {}, { id: 'msg_01SbiUFey9vLGi5zKGBTfZE2' })
    )
    expect(result?.apiMessageId).toBe('msg_01SbiUFey9vLGi5zKGBTfZE2')
  })

  it("v2.9.4 message.id \u7f3a\u5931 \u2192 apiMessageId='' \u9000\u5316\u5230\u6307\u7eb9\u5151\u5e95\u8def\u5f84", () => {
    const line = JSON.stringify({
      type: 'assistant',
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      sessionId: 's-1',
      uuid: 'u-1',
      timestamp: '2026-05-14T03:26:38.071Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    })
    const result = parseClaudeJsonlLine(line)
    expect(result?.apiMessageId).toBe('')
  })

  it('gitBranch=HEAD 视为 null(detached)', () => {
    const result = parseClaudeJsonlLine(assistantLine({ gitBranch: 'HEAD' }))
    expect(result?.gitBranch).toBeNull()
  })

  it('gitBranch 空字符串视为 null', () => {
    const result = parseClaudeJsonlLine(assistantLine({ gitBranch: '' }))
    expect(result?.gitBranch).toBeNull()
  })

  it('非 assistant type 返回 null', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user' } })
    expect(parseClaudeJsonlLine(line)).toBeNull()
  })

  it('queue-operation 等控制行返回 null', () => {
    const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' })
    expect(parseClaudeJsonlLine(line)).toBeNull()
  })

  it('total tokens 为 0 时返回 null(避免无效记录)', () => {
    const result = parseClaudeJsonlLine(
      assistantLine(
        {},
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      )
    )
    expect(result).toBeNull()
  })

  it('cwd 缺失返回 null', () => {
    const result = parseClaudeJsonlLine(assistantLine({ cwd: '' }))
    expect(result).toBeNull()
  })

  it('usage 字段缺失返回 null', () => {
    const line = JSON.stringify({
      type: 'assistant',
      cwd: '/x',
      gitBranch: 'b',
      message: { role: 'assistant', model: 'm' }
    })
    expect(parseClaudeJsonlLine(line)).toBeNull()
  })

  it('JSON 解析失败返回 null', () => {
    expect(parseClaudeJsonlLine('not json')).toBeNull()
  })

  it('数字字段非数或负数视为 0', () => {
    const result = parseClaudeJsonlLine(
      assistantLine(
        {},
        {
          input_tokens: 'bad' as unknown as number,
          output_tokens: -5,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 0
        }
      )
    )
    expect(result?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheCreation: 7,
      cacheRead: 0,
      total: 7
    })
  })

  it("v2.6.0 stop_reason='tool_use' → stopReason='tool_use'", () => {
    const result = parseClaudeJsonlLine(assistantLine({}, {}, { stop_reason: 'tool_use' }))
    expect(result?.stopReason).toBe('tool_use')
  })

  it("v2.6.0 stop_reason='pause_turn' → stopReason='pause_turn'", () => {
    const result = parseClaudeJsonlLine(assistantLine({}, {}, { stop_reason: 'pause_turn' }))
    expect(result?.stopReason).toBe('pause_turn')
  })

  it('v2.6.0 message.stop_reason 缺失 → stopReason=null(老 Claude Code 兼容)', () => {
    // 使用一个干净的 message 对象,避免 spread 覆盖
    const line = JSON.stringify({
      type: 'assistant',
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      sessionId: 's-1',
      uuid: 'u-1',
      timestamp: '2026-05-14T03:26:38.071Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    })
    const result = parseClaudeJsonlLine(line)
    expect(result?.stopReason).toBeNull()
  })

  it('v2.6.0 未知 stop_reason 字符串 → stopReason=null', () => {
    const result = parseClaudeJsonlLine(assistantLine({}, {}, { stop_reason: 'something_new' }))
    expect(result?.stopReason).toBeNull()
  })
})

describe('parseClaudeStopHookSummary (v2.11.1)', () => {
  function systemLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      parentUuid: 'p-1',
      isSidechain: false,
      type: 'system',
      subtype: 'stop_hook_summary',
      hookCount: 3,
      hookInfos: [],
      sessionId: 'sess-1',
      uuid: 'sh-1',
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      timestamp: '2026-05-21T03:50:18.690Z',
      ...overrides
    })
  }

  it('解析 system stop_hook_summary 行全部关键字段', () => {
    expect(parseClaudeStopHookSummary(systemLine())).toEqual({
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      sessionId: 'sess-1',
      uuid: 'sh-1',
      timestamp: '2026-05-21T03:50:18.690Z'
    })
  })

  it('gitBranch=HEAD 视为 null(detached)', () => {
    expect(parseClaudeStopHookSummary(systemLine({ gitBranch: 'HEAD' }))?.gitBranch).toBeNull()
  })

  it('gitBranch 空字符串视为 null', () => {
    expect(parseClaudeStopHookSummary(systemLine({ gitBranch: '' }))?.gitBranch).toBeNull()
  })

  it('type 非 system 返回 null(防止与 assistant 行混淆)', () => {
    expect(parseClaudeStopHookSummary(systemLine({ type: 'assistant' }))).toBeNull()
  })

  it('subtype 非 stop_hook_summary 返回 null(其它 system 子类不参与 flush)', () => {
    expect(parseClaudeStopHookSummary(systemLine({ subtype: 'turn_complete' }))).toBeNull()
  })

  it('cwd 缺失返回 null', () => {
    expect(parseClaudeStopHookSummary(systemLine({ cwd: '' }))).toBeNull()
  })

  it('JSON 解析失败返回 null', () => {
    expect(parseClaudeStopHookSummary('not json')).toBeNull()
  })

  it('timestamp 缺失时退化为当前时间(防御缺字段)', () => {
    const result = parseClaudeStopHookSummary(systemLine({ timestamp: undefined }))
    expect(result).not.toBeNull()
    expect(typeof result?.timestamp).toBe('string')
    expect(result?.timestamp.length).toBeGreaterThan(0)
  })
})

describe('parseClaudeUserMessage (v2.12.0)', () => {
  function userLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: 'uu-1',
      sessionId: 'sess-1',
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      timestamp: '2026-05-21T03:30:00.000Z',
      message: {
        role: 'user',
        content: 'hi claude'
      },
      ...overrides
    })
  }

  it('解析 user 行全部关键字段', () => {
    expect(parseClaudeUserMessage(userLine())).toEqual({
      cwd: '/Users/x/proj',
      gitBranch: 'feature/ABC-1-test',
      sessionId: 'sess-1',
      uuid: 'uu-1',
      timestamp: '2026-05-21T03:30:00.000Z',
      text: 'hi claude'
    })
  })

  it('提取 user 文本素材:字符串直取、内容块数组拼 text、tool_result 归空', () => {
    expect(parseClaudeUserMessage(userLine())?.text).toBe('hi claude')
    expect(
      parseClaudeUserMessage(
        userLine({
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' }
            ]
          }
        })
      )?.text
    ).toBe('第一段\n第二段')
    expect(
      parseClaudeUserMessage(
        userLine({
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'x' }]
          }
        })
      )?.text
    ).toBe('')
  })

  it('type 非 user 返回 null(避免误吃 assistant / system 行)', () => {
    expect(parseClaudeUserMessage(userLine({ type: 'assistant' }))).toBeNull()
    expect(parseClaudeUserMessage(userLine({ type: 'system' }))).toBeNull()
  })

  it('message.role 非 user 返回 null(防御异常行)', () => {
    expect(
      parseClaudeUserMessage(userLine({ message: { role: 'assistant', content: 'x' } }))
    ).toBeNull()
  })

  it('cwd 缺失返回 null', () => {
    expect(parseClaudeUserMessage(userLine({ cwd: '' }))).toBeNull()
  })

  it('gitBranch=HEAD 视为 null(detached)', () => {
    expect(parseClaudeUserMessage(userLine({ gitBranch: 'HEAD' }))?.gitBranch).toBeNull()
  })

  it('gitBranch 空字符串视为 null', () => {
    expect(parseClaudeUserMessage(userLine({ gitBranch: '' }))?.gitBranch).toBeNull()
  })

  it('timestamp 缺失时退化为当前时间(防御缺字段,仍返回非空字符串)', () => {
    const result = parseClaudeUserMessage(userLine({ timestamp: undefined }))
    expect(result).not.toBeNull()
    expect(typeof result?.timestamp).toBe('string')
    expect(result?.timestamp.length).toBeGreaterThan(0)
  })

  it('JSON 解析失败返回 null', () => {
    expect(parseClaudeUserMessage('not json')).toBeNull()
  })
})

describe('effectiveTokens', () => {
  it('返回 input + output + cacheCreation,排除 cacheRead', () => {
    expect(
      effectiveTokens({ input: 10, output: 20, cacheCreation: 5, cacheRead: 1000, total: 1035 })
    ).toBe(35)
  })

  it('全 0 返回 0', () => {
    expect(effectiveTokens({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 })).toBe(
      0
    )
  })

  it('仅 cacheRead 非 0 时返回 0', () => {
    expect(
      effectiveTokens({ input: 0, output: 0, cacheCreation: 0, cacheRead: 87000, total: 87000 })
    ).toBe(0)
  })
})
