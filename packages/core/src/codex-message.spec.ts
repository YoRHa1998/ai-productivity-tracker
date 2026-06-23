import { describe, it, expect } from 'vitest'

import {
  effectiveCodexTokens,
  parseCodexSessionMeta,
  parseCodexTokenCount,
  parseCodexTurnBoundary,
  parseCodexTurnContext
} from './codex-message.js'

describe('parseCodexSessionMeta', () => {
  it('解析 session_meta:sessionId / cwd / git.branch', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-16T11:00:22.896Z',
      type: 'session_meta',
      payload: {
        id: '019ed016-e561-7cc3',
        cwd: '/Users/foo/repo',
        git: { branch: 'feature/ABC-123-x', commit_hash: 'deadbeef' }
      }
    })
    const meta = parseCodexSessionMeta(line)
    expect(meta).toEqual({
      sessionId: '019ed016-e561-7cc3',
      cwd: '/Users/foo/repo',
      gitBranch: 'feature/ABC-123-x',
      timestamp: '2026-06-16T11:00:22.896Z'
    })
  })

  it('git.branch=HEAD(detached)→ gitBranch=null', () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: { id: 's1', cwd: '/x', git: { branch: 'HEAD' } }
    })
    expect(parseCodexSessionMeta(line)?.gitBranch).toBeNull()
  })

  it('无 git 字段 → gitBranch=null', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/x' } })
    expect(parseCodexSessionMeta(line)?.gitBranch).toBeNull()
  })

  it('缺 id / cwd → null', () => {
    expect(parseCodexSessionMeta(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull()
  })

  it('非 session_meta / 非法 JSON → null', () => {
    expect(parseCodexSessionMeta(JSON.stringify({ type: 'turn_context', payload: {} }))).toBeNull()
    expect(parseCodexSessionMeta('not json')).toBeNull()
  })
})

describe('parseCodexTurnContext', () => {
  it('解析 turn_id / model / cwd', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-16T11:00:22.901Z',
      type: 'turn_context',
      payload: { turn_id: 't-1', model: 'gpt-5.5', cwd: '/Users/foo/repo' }
    })
    expect(parseCodexTurnContext(line)).toEqual({
      turnId: 't-1',
      model: 'gpt-5.5',
      cwd: '/Users/foo/repo',
      timestamp: '2026-06-16T11:00:22.901Z'
    })
  })

  it('缺 model → unknown', () => {
    const line = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't-1' } })
    expect(parseCodexTurnContext(line)?.model).toBe('unknown')
  })

  it('非 turn_context → null', () => {
    expect(parseCodexTurnContext(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull()
  })
})

describe('parseCodexTokenCount + effectiveCodexTokens', () => {
  it('解析 total_token_usage 累计值', () => {
    const line = JSON.stringify({
      timestamp: '2026-06-16T11:00:40.001Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 19629,
            cached_input_tokens: 4480,
            output_tokens: 241,
            total_tokens: 19870
          }
        }
      }
    })
    const tc = parseCodexTokenCount(line)
    expect(tc?.total).toEqual({
      inputTokens: 19629,
      cachedInputTokens: 4480,
      outputTokens: 241,
      totalTokens: 19870
    })
    // effective = input - cached + output = 19629 - 4480 + 241 = 15390
    expect(effectiveCodexTokens(tc!.total)).toBe(15390)
  })

  it('effective 永不为负', () => {
    expect(
      effectiveCodexTokens({
        inputTokens: 10,
        cachedInputTokens: 100,
        outputTokens: 5,
        totalTokens: 0
      })
    ).toBe(0)
  })

  it('非 token_count 的 event_msg → null', () => {
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })
    expect(parseCodexTokenCount(line)).toBeNull()
  })
})

describe('parseCodexTurnBoundary', () => {
  it.each([['task_started'], ['user_message'], ['task_complete']])(
    '识别 event_msg/%s',
    (subtype) => {
      const line = JSON.stringify({
        timestamp: '2026-06-16T11:00:45.445Z',
        type: 'event_msg',
        payload: { type: subtype, turn_id: 't-1' }
      })
      const b = parseCodexTurnBoundary(line)
      expect(b?.kind).toBe(subtype)
      expect(b?.timestamp).toBe('2026-06-16T11:00:45.445Z')
    }
  )

  it('其它 event_msg 子类型(agent_message / token_count)→ null', () => {
    expect(
      parseCodexTurnBoundary(
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })
      )
    ).toBeNull()
    expect(
      parseCodexTurnBoundary(
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })
      )
    ).toBeNull()
  })

  it('非 event_msg → null', () => {
    expect(parseCodexTurnBoundary(JSON.stringify({ type: 'response_item' }))).toBeNull()
  })
})
