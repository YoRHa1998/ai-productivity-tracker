import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveRequirement } from './requirement-store.js'
import {
  clearPendingSummary,
  consumePendingSummary,
  peekPendingSummary,
  writePendingSummary,
  PENDING_SUMMARY_FILE
} from './pending-summary.js'

describe('pending-summary store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-pending-'))
    saveRequirement({ jiraKey: 'PROJ-7', title: 'demo' }, { root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writePendingSummary 落 communication 类总结并能 peek 出来', () => {
    const written = writePendingSummary(
      'PROJ-7',
      { oneLine: '聊聊架构', type: 'communication', discussion: '讨论了一下数据流' },
      'cursor',
      root
    )
    expect(written).toBeTruthy()
    expect(written?.summary.type).toBe('communication')
    expect(written?.summary.discussion).toBe('讨论了一下数据流')
    expect(written?.source).toBe('cursor')

    const peeked = peekPendingSummary('PROJ-7', root)
    expect(peeked?.summary.oneLine).toBe('聊聊架构')
    expect(existsSync(join(root, 'PROJ-7', PENDING_SUMMARY_FILE))).toBe(true)
  })

  it('writePendingSummary 落 coding 类总结时保留 changeScope 字段', () => {
    const written = writePendingSummary(
      'PROJ-7',
      {
        oneLine: '修复 attach 逻辑',
        type: 'coding',
        changeScope: 'attach-summary handler 改写 pending'
      },
      'claude-code',
      root
    )
    expect(written?.summary.type).toBe('coding')
    expect(written?.summary.changeScope).toBe('attach-summary handler 改写 pending')
    expect(written?.source).toBe('claude-code')
  })

  it('writePendingSummary 后调用 consume 返回内容并删除文件', () => {
    writePendingSummary(
      'PROJ-7',
      { oneLine: 'x', type: 'communication', discussion: 'y' },
      undefined,
      root
    )
    const file = join(root, 'PROJ-7', PENDING_SUMMARY_FILE)
    expect(existsSync(file)).toBe(true)

    const consumed = consumePendingSummary('PROJ-7', root)
    expect(consumed?.summary.oneLine).toBe('x')
    expect(existsSync(file)).toBe(false)

    // 再次 consume 拿不到内容
    expect(consumePendingSummary('PROJ-7', root)).toBeNull()
  })

  it('多次 writePendingSummary 以最后一次为准', () => {
    writePendingSummary(
      'PROJ-7',
      { oneLine: '一', type: 'communication', discussion: '一一' },
      undefined,
      root
    )
    writePendingSummary(
      'PROJ-7',
      { oneLine: '二', type: 'communication', discussion: '二二' },
      undefined,
      root
    )
    const consumed = consumePendingSummary('PROJ-7', root)
    expect(consumed?.summary.oneLine).toBe('二')
    expect(consumed?.summary.discussion).toBe('二二')
  })

  it('peekPendingSummary 不删文件', () => {
    writePendingSummary(
      'PROJ-7',
      { oneLine: 'x', type: 'communication', discussion: 'y' },
      undefined,
      root
    )
    peekPendingSummary('PROJ-7', root)
    peekPendingSummary('PROJ-7', root)
    expect(existsSync(join(root, 'PROJ-7', PENDING_SUMMARY_FILE))).toBe(true)
  })

  it('文件不存在时所有函数都返回 null / 安全 no-op', () => {
    expect(peekPendingSummary('PROJ-7', root)).toBeNull()
    expect(consumePendingSummary('PROJ-7', root)).toBeNull()
    expect(() => clearPendingSummary('PROJ-7', root)).not.toThrow()
  })

  it('文件损坏(非 JSON)时 peek/consume 返回 null,consume 仍清除残留', () => {
    writePendingSummary(
      'PROJ-7',
      { oneLine: 'x', type: 'communication', discussion: 'y' },
      undefined,
      root
    )
    const file = join(root, 'PROJ-7', PENDING_SUMMARY_FILE)
    writeFileSync(file, '{ not json', 'utf-8')
    expect(peekPendingSummary('PROJ-7', root)).toBeNull()
    consumePendingSummary('PROJ-7', root)
    expect(existsSync(file)).toBe(false)
  })

  it('readFileSync 损坏 JSON: 内容验证 (用作回归保证)', () => {
    const file = join(root, 'PROJ-7', PENDING_SUMMARY_FILE)
    writePendingSummary(
      'PROJ-7',
      { oneLine: 'hello', type: 'communication', discussion: 'world' },
      'cursor',
      root
    )
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    expect(raw.version).toBe(1)
    expect(raw.summary.oneLine).toBe('hello')
    expect(raw.source).toBe('cursor')
    expect(typeof raw.createdAt).toBe('string')
  })
})
