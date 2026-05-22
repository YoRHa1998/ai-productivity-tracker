import { describe, expect, it } from 'vitest'

import {
  buildDedupeKey,
  buildRawHookPayload,
  parseHookTokens,
  resolveProjectRoot,
  tryParseHookInput,
  type HookInput
} from './hook.js'

describe('parseHookTokens', () => {
  it('Cursor 3.3.30 snake_case input_tokens + output_tokens 命中', () => {
    expect(parseHookTokens({ input_tokens: 1000, output_tokens: 200 } as HookInput)).toBe(1200)
  })

  it('v2.7.1 cache_read 被扣除,cache_write 不重复计 (与 Claude effectiveTokens 对齐)', () => {
    expect(
      parseHookTokens({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 800,
        cache_write_tokens: 100
      } as HookInput)
    ).toBe(400)
  })

  it('v2.7.1 Cursor 大上下文 + 高 cache_read 命中场景:cache_read 不应让单轮 token 虚高', () => {
    // 截图问题 1 复现:Cursor 3.3.30 探针实测样本 1
    // input=1133216, output=13716, cache_read=995494, cache_write=137708
    // 旧算法:1133216+13716 = 1146932 (虚高 7~8 倍)
    // 新算法:(1133216-995494) + 13716 = 151438 (与 Claude UI 显示数字接近)
    expect(
      parseHookTokens({
        input_tokens: 1133216,
        output_tokens: 13716,
        cache_read_tokens: 995494,
        cache_write_tokens: 137708
      } as HookInput)
    ).toBe(151438)
  })

  it('只有 output_tokens 时仍然计 0+output', () => {
    expect(parseHookTokens({ output_tokens: 50 } as HookInput)).toBe(50)
  })

  it('Claude usage.input/output_tokens 命中', () => {
    expect(parseHookTokens({ usage: { input_tokens: 100, output_tokens: 30 } } as HookInput)).toBe(
      130
    )
  })

  it('v2.7.1 Claude usage.cache_read_input_tokens 也参与扣除', () => {
    expect(
      parseHookTokens({
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50
        }
      } as HookInput)
    ).toBe(400)
  })

  it('totalTokens 命中', () => {
    expect(parseHookTokens({ totalTokens: 9999 } as HookInput)).toBe(9999)
  })

  it('camelCase fallback', () => {
    expect(parseHookTokens({ inputTokens: 7, outputTokens: 13 } as HookInput)).toBe(20)
  })

  it('promptTokens + completionTokens 老字段', () => {
    expect(parseHookTokens({ promptTokens: 5, completionTokens: 6 } as HookInput)).toBe(11)
  })

  it('全空对象返回 0', () => {
    expect(parseHookTokens({} as HookInput)).toBe(0)
  })

  it('Cursor snake_case 优先级高于 totalTokens(避免 IDE 重复 sum)', () => {
    // v2.7.1:走 (input - cache_read) + output 分支,cache_read 缺省 0
    expect(
      parseHookTokens({ input_tokens: 1, output_tokens: 1, totalTokens: 9999 } as HookInput)
    ).toBe(2)
  })
})

describe('buildDedupeKey', () => {
  it('优先 conversation_id + generation_id', () => {
    expect(buildDedupeKey({ conversation_id: 'conv-1', generation_id: 'gen-1' } as HookInput)).toBe(
      'conv-1#gen-1'
    )
  })

  it('缺 generation_id 时 fallback hook_event_name', () => {
    expect(
      buildDedupeKey({
        conversation_id: 'conv-2',
        hook_event_name: 'afterAgentResponse'
      } as HookInput)
    ).toBe('conv-2#afterAgentResponse')
  })

  it('session_id 作为 conversation_id 的兜底', () => {
    expect(buildDedupeKey({ session_id: 'sess-1', generation_id: 'gen-1' } as HookInput)).toBe(
      'sess-1#gen-1'
    )
  })

  it('无任何 id 字段 → undefined', () => {
    expect(buildDedupeKey({} as HookInput)).toBeUndefined()
  })

  it('null 输入 → undefined', () => {
    expect(buildDedupeKey(null)).toBeUndefined()
  })
})

describe('tryParseHookInput', () => {
  it('合法 JSON 返回对象', () => {
    expect(tryParseHookInput('{"a":1}')).toEqual({ a: 1 })
  })
  it('空字符串返回 null', () => {
    expect(tryParseHookInput('')).toBeNull()
  })
  it('非法 JSON 返回 null', () => {
    expect(tryParseHookInput('{not json')).toBeNull()
  })
})

describe('buildRawHookPayload', () => {
  it('parsed=null 返回 undefined', () => {
    expect(buildRawHookPayload(null)).toBeUndefined()
  })

  it('透传 model / cache / cursor_version,且 text_length=text.length 而非 text 全文', () => {
    const text = 'a'.repeat(2048)
    const payload = buildRawHookPayload({
      model: 'claude-opus-4-7',
      cursor_version: '3.3.30',
      cache_read_tokens: 800,
      cache_write_tokens: 100,
      input_tokens: 1000,
      output_tokens: 200,
      text
    } as HookInput)
    expect(payload).toMatchObject({
      model: 'claude-opus-4-7',
      cursor_version: '3.3.30',
      cache_read_tokens: 800,
      cache_write_tokens: 100,
      input_tokens: 1000,
      output_tokens: 200,
      text_length: 2048
    })
    expect(payload).not.toHaveProperty('text')
  })

  it('text 缺省时 text_length=0', () => {
    const payload = buildRawHookPayload({ model: 'm' } as HookInput)
    expect(payload?.text_length).toBe(0)
  })
})

describe('resolveProjectRoot', () => {
  it('找不到任何含 .ai-productivity 的目录时返回 null', () => {
    const orig = process.env.CURSOR_PROJECT_DIR
    delete process.env.CURSOR_PROJECT_DIR
    delete process.env.CLAUDE_PROJECT_DIR
    try {
      expect(
        resolveProjectRoot({ workspace_roots: ['/nonexistent/path/abc-xyz'] } as HookInput)
      ).toBeNull()
    } finally {
      if (orig != null) process.env.CURSOR_PROJECT_DIR = orig
    }
  })

  it('v2.7.3 在 CURSOR/CLAUDE_PROJECT_DIR 都缺失时尝试 WORKSPACE_FOLDER_PATHS', () => {
    // 仅验证 WORKSPACE_FOLDER_PATHS 被纳入候选(无 .ai-productivity 子目录仍返回 null)
    // 主要目的是确保候选解析路径不报错、不抛、并按预期顺序遍历
    const orig = {
      cursor: process.env.CURSOR_PROJECT_DIR,
      claude: process.env.CLAUDE_PROJECT_DIR,
      workspaces: process.env.WORKSPACE_FOLDER_PATHS
    }
    delete process.env.CURSOR_PROJECT_DIR
    delete process.env.CLAUDE_PROJECT_DIR
    process.env.WORKSPACE_FOLDER_PATHS = '/nonexistent/repoA:/nonexistent/repoB'
    try {
      expect(resolveProjectRoot(null)).toBeNull()
    } finally {
      if (orig.cursor != null) process.env.CURSOR_PROJECT_DIR = orig.cursor
      if (orig.claude != null) process.env.CLAUDE_PROJECT_DIR = orig.claude
      if (orig.workspaces != null) process.env.WORKSPACE_FOLDER_PATHS = orig.workspaces
      else delete process.env.WORKSPACE_FOLDER_PATHS
    }
  })
})
