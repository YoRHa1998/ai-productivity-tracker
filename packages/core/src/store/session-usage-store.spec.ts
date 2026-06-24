import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  accumulateSessionUsage,
  readSessionUsage,
  pruneSessions,
  querySessions,
  isPlaceholderTitle,
  sanitizeTitle,
  truncateTitle,
  writeSessionUsage,
  RETENTION_DAYS,
  TITLE_MAX_LEN,
  type SessionUsageFile,
  type SessionUsageRecord
} from './session-usage-store.js'
import { recordUsage, setAiUsageEnabled, __resetAiUsageCacheForTest } from './ai-usage-store.js'
import type { AiUsageEvent } from './ai-usage-store.js'
import { sessionUsagePath } from './paths.js'

function evt(partial: Partial<AiUsageEvent> & Pick<AiUsageEvent, 'source'>): AiUsageEvent {
  return {
    source: partial.source,
    sessionId: partial.sessionId ?? 's1',
    model: partial.model,
    provider: partial.provider,
    toolCalls: partial.toolCalls,
    title: partial.title,
    jiraKey: partial.jiraKey,
    projectName: partial.projectName,
    branch: partial.branch,
    at: partial.at ?? new Date().toISOString(),
    tokens: partial.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 }
  }
}

function rec(
  partial: Partial<SessionUsageRecord> & Pick<SessionUsageRecord, 'lastAt'>
): SessionUsageRecord {
  return {
    source: partial.source ?? 'cursor',
    sessionId: partial.sessionId ?? 'sid',
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheCreation: partial.cacheCreation ?? 0,
    total: partial.total ?? 0,
    turns: partial.turns ?? 0,
    toolCalls: partial.toolCalls ?? 0,
    model: partial.model,
    title: partial.title,
    jiraKey: partial.jiraKey,
    firstAt: partial.firstAt ?? partial.lastAt,
    lastAt: partial.lastAt
  }
}

describe('session-usage-store: accumulate', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('按会话累加 token 细分 / turns / toolCalls,刷新时间窗(含跨日)', () => {
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at: '2026-06-23T10:00:00.000Z',
        toolCalls: 2,
        tokens: { input: 100, output: 10, cacheRead: 5, cacheCreation: 20, total: 130 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'sess-a',
        at: '2026-06-24T09:00:00.000Z',
        toolCalls: 3,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, total: 7 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['codex:sess-a']
    expect(r.input).toBe(101)
    expect(r.output).toBe(12)
    expect(r.cacheRead).toBe(8)
    expect(r.cacheCreation).toBe(24)
    expect(r.total).toBe(137)
    expect(r.turns).toBe(2)
    expect(r.toolCalls).toBe(5)
    expect(r.firstAt).toBe('2026-06-23T10:00:00.000Z')
    expect(r.lastAt).toBe('2026-06-24T09:00:00.000Z')
  })

  it('空 sessionId 直接跳过,不创建记录', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: '',
        tokens: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
      }),
      root
    )
    expect(existsSync(sessionUsagePath(root))).toBe(false)
    expect(Object.keys(readSessionUsage(root).sessions)).toHaveLength(0)
  })

  it('source 前缀消歧:同 sessionId 跨工具不串号', () => {
    const tokens = { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
    accumulateSessionUsage(evt({ source: 'cursor', sessionId: 'dup', tokens }), root)
    accumulateSessionUsage(evt({ source: 'codex', sessionId: 'dup', tokens }), root)
    const sessions = readSessionUsage(root).sessions
    expect(Object.keys(sessions).sort()).toEqual(['codex:dup', 'cursor:dup'])
  })

  it('total 缺失时按 input+output+cacheCreation 兜底(剔除 cacheRead)', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        tokens: { input: 5, output: 5, cacheRead: 100, cacheCreation: 2, total: 0 }
      }),
      root
    )
    expect(readSessionUsage(root).sessions['cursor:s'].total).toBe(12)
  })

  it('title 仅首次写入,后续轮不覆盖;model / jiraKey 非空覆盖', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '第一句话',
        model: 'm1',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '后续轮的话',
        model: 'm2',
        jiraKey: 'INSTANT-1',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['cursor:s']
    expect(r.title).toBe('第一句话')
    expect(r.model).toBe('m2')
    expect(r.jiraKey).toBe('INSTANT-1')
  })

  it('原子写:不留 .tmp 残留', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const p = sessionUsagePath(root)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
  })
})

describe('session-usage-store: prune', () => {
  it('删除 lastAt 早于保留天数的会话', () => {
    const now = new Date('2026-06-24T00:00:00.000Z')
    const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * 86400_000).toISOString()
    const fresh = new Date(now.getTime() - 1 * 86400_000).toISOString()
    const file: SessionUsageFile = {
      version: 1,
      sessions: {
        'cursor:old': rec({ sessionId: 'old', lastAt: old }),
        'cursor:fresh': rec({ sessionId: 'fresh', lastAt: fresh })
      }
    }
    pruneSessions(file, now)
    expect(Object.keys(file.sessions)).toEqual(['cursor:fresh'])
  })

  it('超条数上限按最近 lastAt 保留', () => {
    const now = new Date('2026-06-24T00:00:00.000Z')
    const sessions: Record<string, SessionUsageRecord> = {}
    for (let i = 0; i < 5; i++) {
      const lastAt = new Date(now.getTime() - i * 60_000).toISOString()
      sessions[`cursor:s${i}`] = rec({ sessionId: `s${i}`, lastAt })
    }
    const file: SessionUsageFile = { version: 1, sessions }
    pruneSessions(file, now, RETENTION_DAYS, 3)
    expect(Object.keys(file.sessions).sort()).toEqual(['cursor:s0', 'cursor:s1', 'cursor:s2'])
  })
})

describe('session-usage-store: query', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-q-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed() {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'big',
        at: '2026-06-20T10:00:00.000Z',
        tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, total: 1000 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'mid',
        at: '2026-06-22T10:00:00.000Z',
        tokens: { input: 500, output: 0, cacheRead: 0, cacheCreation: 0, total: 500 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'small',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0, total: 50 }
      }),
      root
    )
  }

  it('默认按 total 倒序', () => {
    seed()
    const rows = querySessions({}, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['big', 'mid', 'small'])
    expect(rows[0].totalTokens).toBe(1000)
  })

  it('dir=asc 反转;sort=lastAt 按最近活跃', () => {
    seed()
    expect(querySessions({ dir: 'asc' }, root).map((r) => r.sessionId)).toEqual([
      'small',
      'mid',
      'big'
    ])
    expect(querySessions({ sort: 'lastAt' }, root).map((r) => r.sessionId)).toEqual([
      'small',
      'mid',
      'big'
    ])
  })

  it('source 过滤', () => {
    seed()
    const rows = querySessions({ source: 'cursor' }, root)
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['big', 'small'])
  })

  it('from/to 时间窗过滤', () => {
    seed()
    const rows = querySessions(
      { from: '2026-06-21T00:00:00.000Z', to: '2026-06-23T00:00:00.000Z' },
      root
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['mid'])
  })

  it('limit 截断', () => {
    seed()
    expect(querySessions({ limit: 1 }, root).map((r) => r.sessionId)).toEqual(['big'])
  })

  it('keys 集合命中:仅返回 key 命中的会话', () => {
    seed()
    const rows = querySessions({ keys: ['cursor:small'] }, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['small'])
  })

  it('keys 混合来源:跨 source 合并按 total 倒序', () => {
    seed()
    const rows = querySessions({ keys: ['codex:mid', 'cursor:big'] }, root)
    // big(1000) > mid(500)
    expect(rows.map((r) => r.sessionId)).toEqual(['big', 'mid'])
  })

  it('keys 在排序 / 截断之前施加,不被 top-N 挤掉', () => {
    seed()
    // 仅命中 small(50,最小用量),limit=1 仍应返回它而非整库 top-1(big)
    const rows = querySessions({ keys: ['cursor:small'], limit: 1 }, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['small'])
  })

  it('keys 含不存在的 key:安全忽略,不报错', () => {
    seed()
    const rows = querySessions({ keys: ['cursor:big', 'cursor:nope', 'claude-code:ghost'] }, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['big'])
  })

  it('keys 空 / 缺省:向后兼容不过滤', () => {
    seed()
    expect(querySessions({ keys: [] }, root)).toHaveLength(3)
    expect(querySessions({}, root)).toHaveLength(3)
  })

  it('keys 与 source 过滤可叠加', () => {
    seed()
    // big 是 cursor、mid 是 codex;限定 source=cursor 后 mid 被排除
    const rows = querySessions({ keys: ['cursor:big', 'codex:mid'], source: 'cursor' }, root)
    expect(rows.map((r) => r.sessionId)).toEqual(['big'])
  })
})

describe('recordUsage 集成会话维度', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-rec-'))
    __resetAiUsageCacheForTest()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    __resetAiUsageCacheForTest()
  })

  it('enabled 时写会话维度,带 title/jiraKey 落库', () => {
    setAiUsageEnabled(true, root)
    recordUsage(
      evt({
        source: 'claude-code',
        sessionId: 'sx',
        title: '帮我写个函数',
        jiraKey: 'INSTANT-9',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, total: 15 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['claude-code:sx']
    expect(r.total).toBe(15)
    expect(r.title).toBe('帮我写个函数')
    expect(r.jiraKey).toBe('INSTANT-9')
  })

  it('disabled 时不写会话维度', () => {
    setAiUsageEnabled(false, root)
    recordUsage(
      evt({
        source: 'cursor',
        sessionId: 'sx',
        tokens: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0, total: 10 }
      }),
      root
    )
    expect(existsSync(sessionUsagePath(root))).toBe(false)
  })
})

describe('sanitizeTitle', () => {
  it('提取最后一个 user_query 正文,剥离外围标签', () => {
    expect(sanitizeTitle('<timestamp>2026</timestamp> <user_query> 你好</user_query>')).toBe('你好')
  })

  it('命令行 + 真实输入并存时取最后一个 user_query', () => {
    const text =
      '<user_query>/cmd 模板</user_query>\n更多上下文\n<user_query>真正的问题</user_query>'
    expect(sanitizeTitle(text)).toBe('真正的问题')
  })

  it('容忍未闭合 user_query(被截断的脏标题)', () => {
    expect(sanitizeTitle('<timestamp>x</timestamp> <user_query> 帮我写代码')).toBe('帮我写代码')
  })

  it('已取 user_query 正文时保留含尖括号的正常文本(泛型)', () => {
    expect(sanitizeTitle('<user_query>实现 Array<T> 工具类型</user_query>')).toBe(
      '实现 Array<T> 工具类型'
    )
  })

  it('无 user_query 时移除噪声标签块及其内容', () => {
    const text =
      '<timestamp>2026-06-24</timestamp><system_reminder>be nice</system_reminder>真实输入'
    expect(sanitizeTitle(text)).toBe('真实输入')
  })

  it('无 user_query 时剥离残留的成对 / 单个尖括号标签', () => {
    expect(sanitizeTitle('<foo>保留我</foo>')).toBe('保留我')
    expect(sanitizeTitle('前缀 <bar> 中段')).toBe('前缀 中段')
  })

  it('未闭合的噪声标签块吞到文末', () => {
    expect(sanitizeTitle('<additional_data> 一堆系统数据 to the end')).toBe('')
  })

  it('空 / 非字符串安全兜底', () => {
    expect(sanitizeTitle('')).toBe('')
    expect(sanitizeTitle(undefined)).toBe('')
    expect(sanitizeTitle(123 as unknown)).toBe('')
  })

  it('幂等:对已清洗文本再跑结果不变', () => {
    const once = sanitizeTitle('<timestamp>x</timestamp> <user_query> 你好</user_query>')
    expect(sanitizeTitle(once)).toBe(once)
    const noisy = sanitizeTitle('<system_reminder>r</system_reminder>纯文本')
    expect(sanitizeTitle(noisy)).toBe(noisy)
  })
})

describe('session-usage-store: projectName / branch', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-pb-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('projectName / branch 非空覆盖更新(取最近)', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        projectName: 'proj-a',
        branch: 'feature/INSTANT-1',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        projectName: 'proj-b',
        branch: 'feature/INSTANT-2',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['cursor:s']
    expect(r.projectName).toBe('proj-b')
    expect(r.branch).toBe('feature/INSTANT-2')
  })

  it('后续轮缺失 projectName / branch 时保留既有值(空不覆盖)', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        projectName: 'proj-a',
        branch: 'main',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['cursor:s']
    expect(r.projectName).toBe('proj-a')
    expect(r.branch).toBe('main')
  })

  it('缺失时安全留空,不阻断累加', () => {
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 's',
        tokens: { input: 5, output: 0, cacheRead: 0, cacheCreation: 0, total: 5 }
      }),
      root
    )
    const r = readSessionUsage(root).sessions['codex:s']
    expect(r.total).toBe(5)
    expect(r.projectName).toBeUndefined()
    expect(r.branch).toBeUndefined()
  })

  it('querySessions 视图透传 projectName / branch', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        projectName: 'proj-x',
        branch: 'dev',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    const view = querySessions({}, root)[0]
    expect(view.projectName).toBe('proj-x')
    expect(view.branch).toBe('dev')
  })

  it('历史记录无 projectName / branch 字段读取兼容,展示层清洗脏标题', () => {
    const file: SessionUsageFile = {
      version: 1,
      sessions: {
        'cursor:legacy': rec({
          sessionId: 'legacy',
          lastAt: '2026-06-24T10:00:00.000Z',
          total: 100,
          title: '<timestamp>2026</timestamp> <user_query> 旧脏标题</user_query>'
        })
      }
    }
    writeSessionUsage(file, root)
    const view = querySessions({}, root)[0]
    expect(view.projectName).toBeUndefined()
    expect(view.branch).toBeUndefined()
    // 展示侧幂等去标签(D1):落盘脏标题被清洗
    expect(view.title).toBe('旧脏标题')
    // 落盘数据不被改写
    expect(readSessionUsage(root).sessions['cursor:legacy'].title).toBe(
      '<timestamp>2026</timestamp> <user_query> 旧脏标题</user_query>'
    )
  })
})

describe('isPlaceholderTitle', () => {
  it('空 / 非字符串 / 纯空白 → true', () => {
    expect(isPlaceholderTitle('')).toBe(true)
    expect(isPlaceholderTitle('   ')).toBe(true)
    expect(isPlaceholderTitle(undefined)).toBe(true)
    expect(isPlaceholderTitle(123 as unknown)).toBe(true)
  })

  it('纯标签清洗后为空 → true', () => {
    expect(isPlaceholderTitle('<timestamp>x</timestamp>')).toBe(true)
    expect(isPlaceholderTitle('<additional_data> 一堆系统数据 to the end')).toBe(true)
  })

  it('纯图片占位(含全/半角括号、大小写、多块、带文件名)→ true', () => {
    expect(isPlaceholderTitle('[Image]')).toBe(true)
    expect(isPlaceholderTitle('[image]')).toBe(true)
    expect(isPlaceholderTitle('[图片]')).toBe(true)
    expect(isPlaceholderTitle('【图片】')).toBe(true)
    expect(isPlaceholderTitle('[Image][Image]')).toBe(true)
    expect(isPlaceholderTitle('[Image: foo.png]')).toBe(true)
    expect(isPlaceholderTitle('  [Image]  ')).toBe(true)
  })

  it('含真实正文 → false(不误判)', () => {
    expect(isPlaceholderTitle('修复登录 bug')).toBe(false)
    expect(isPlaceholderTitle('[Image] 帮我看看这张图')).toBe(false)
    expect(isPlaceholderTitle('<user_query>实现 Array<T></user_query>')).toBe(false)
  })

  it('幂等', () => {
    const v = '[Image]'
    expect(isPlaceholderTitle(v)).toBe(isPlaceholderTitle(v))
  })
})

describe('session-usage-store: title 占位跳过', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-ph-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('首条素材为空 / 纯占位时跳过不写,留待后续真实输入补位', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '[Image]',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    expect(readSessionUsage(root).sessions['cursor:s'].title).toBeUndefined()

    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '修复登录 bug',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    expect(readSessionUsage(root).sessions['cursor:s'].title).toBe('修复登录 bug')
  })

  it('含真实文本的素材正常写入(不误删)', () => {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 's',
        title: '[Image] 看看这张截图',
        tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
      }),
      root
    )
    expect(readSessionUsage(root).sessions['cursor:s'].title).toBe('[Image] 看看这张截图')
  })

  it('幂等:重复写占位仍不落标题', () => {
    const e = evt({
      source: 'cursor',
      sessionId: 's',
      title: '[Image]',
      tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 }
    })
    accumulateSessionUsage(e, root)
    accumulateSessionUsage(e, root)
    expect(readSessionUsage(root).sessions['cursor:s'].title).toBeUndefined()
  })

  it('展示侧:历史落盘的纯占位标题视为空走兜底(undefined),不改写落盘', () => {
    const file: SessionUsageFile = {
      version: 1,
      sessions: {
        'cursor:ph': rec({
          sessionId: 'ph',
          lastAt: '2026-06-24T10:00:00.000Z',
          total: 100,
          title: '[Image]'
        })
      }
    }
    writeSessionUsage(file, root)
    const view = querySessions({}, root)[0]
    expect(view.title).toBeUndefined()
    expect(readSessionUsage(root).sessions['cursor:ph'].title).toBe('[Image]')
  })
})

describe('session-usage-store: project 过滤', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-session-proj-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedProjects() {
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'a',
        projectName: 'acme-web',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0, total: 100 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'codex',
        sessionId: 'b',
        projectName: 'acme-api',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 200, output: 0, cacheRead: 0, cacheCreation: 0, total: 200 }
      }),
      root
    )
    accumulateSessionUsage(
      evt({
        source: 'cursor',
        sessionId: 'c',
        at: '2026-06-24T10:00:00.000Z',
        tokens: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0, total: 50 }
      }),
      root
    )
  }

  it('按 projectName 精确过滤', () => {
    seedProjects()
    expect(querySessions({ project: 'acme-web' }, root).map((r) => r.sessionId)).toEqual(['a'])
    expect(querySessions({ project: 'acme-api' }, root).map((r) => r.sessionId)).toEqual(['b'])
  })

  it('缺省 / 空字符串不过滤(向后兼容)', () => {
    seedProjects()
    expect(
      querySessions({}, root)
        .map((r) => r.sessionId)
        .sort()
    ).toEqual(['a', 'b', 'c'])
    expect(querySessions({ project: '' }, root)).toHaveLength(3)
    expect(querySessions({ project: '   ' }, root)).toHaveLength(3)
  })

  it('与 source / 时间窗叠加', () => {
    seedProjects()
    expect(
      querySessions({ project: 'acme-web', source: 'cursor' }, root).map((r) => r.sessionId)
    ).toEqual(['a'])
    expect(querySessions({ project: 'acme-web', source: 'codex' }, root)).toHaveLength(0)
    expect(
      querySessions({ project: 'acme-api', from: '2026-06-24T00:00:00.000Z' }, root).map(
        (r) => r.sessionId
      )
    ).toEqual(['b'])
  })
})

describe('truncateTitle', () => {
  it('超长截断到上限', () => {
    const long = 'a'.repeat(TITLE_MAX_LEN + 50)
    expect(truncateTitle(long).length).toBe(TITLE_MAX_LEN)
    expect(truncateTitle('abc', 2)).toBe('ab')
  })

  it('折行 / 连续空白压成一行', () => {
    expect(truncateTitle('hello\n\n  world\t!')).toBe('hello world !')
  })

  it('去首尾空白', () => {
    expect(truncateTitle('  hi  ')).toBe('hi')
  })

  it('空输入 / 非字符串安全兜底', () => {
    expect(truncateTitle('')).toBe('')
    expect(truncateTitle('   ')).toBe('')
    expect(truncateTitle(undefined)).toBe('')
    expect(truncateTitle(123 as unknown)).toBe('')
  })
})
