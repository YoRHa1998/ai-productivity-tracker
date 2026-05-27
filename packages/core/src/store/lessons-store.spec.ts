import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildLessonsBundle,
  computeSignals,
  findMergeCandidate,
  generateLessonId,
  isStrongCandidateIteration,
  listLessons,
  loadLesson,
  mergeSignals,
  readLessonsIndex,
  recomputeTrustReasons,
  removeLesson,
  STRONG_THINK_SECONDS,
  tagsJaccard,
  titleSimilarity,
  writeLessons,
  type LessonSignals,
  type StoredLesson,
  type WriteLessonInput
} from './lessons-store.js'
import { lessonFilePath, lessonsIndexPath } from './paths.js'
import { saveRequirement, updateRequirement } from './requirement-store.js'
import { appendIteration } from './iteration-store.js'

function makeInput(overrides: Partial<WriteLessonInput> = {}): WriteLessonInput {
  return {
    jiraKey: 'PROJ-1',
    type: 'pitfall',
    title: 'baseUrl 缺协议导致 422',
    content: 'Atlassian new URL 第二参数必须含 https://, 否则抛 TypeError 被吞.',
    rootCause: 'normalizeJiraBaseUrl 缺失',
    fix: '在 store 层补 normalize',
    reusableWhen: '所有调 atlassian REST 的入口',
    tags: ['jira', 'baseUrl'],
    affectedFiles: [
      'apps/local-agent-service/src/services/ai-productivity/store/jira-config-store.ts'
    ],
    iterationSeqs: [3, 4],
    trust: 'high',
    ...overrides
  }
}

describe('lessons-store', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aip-lessons-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writeLessons 创建 lessons/<id>.json 并同步 INDEX.json', () => {
    const result = writeLessons([makeInput()], { extractedBy: 'cursor' }, root)
    expect(result.saved).toHaveLength(1)
    expect(result.rejected).toHaveLength(0)
    const id = result.saved[0].id
    expect(id.startsWith('lsn-PROJ-1-')).toBe(true)
    expect(existsSync(lessonFilePath(id, root))).toBe(true)
    expect(existsSync(lessonsIndexPath(root))).toBe(true)
    const idx = readLessonsIndex(root)
    expect(idx.lessons).toHaveLength(1)
    expect(idx.lessons[0].id).toBe(id)
    expect(idx.lessons[0].jiraKey).toBe('PROJ-1')
    expect(idx.lessons[0].type).toBe('pitfall')
  })

  it('writeLessons 同 id 视为覆盖式更新, replaced 列表回填', () => {
    const id = generateLessonId('PROJ-1')
    writeLessons([makeInput({ id, title: 'old' })], {}, root)
    const second = writeLessons([makeInput({ id, title: 'new' })], {}, root)
    expect(second.replaced).toEqual([id])
    const reload = loadLesson(id, root)
    expect(reload?.title).toBe('new')
    expect(readLessonsIndex(root).lessons).toHaveLength(1)
  })

  it('writeLessons 拒收非法字段, 返回 rejected 索引', () => {
    const result = writeLessons(
      [
        makeInput(),
        { jiraKey: '', type: 'rule', title: 't', content: 'c' } as WriteLessonInput,
        { jiraKey: 'X-1', type: 'unknown' as never, title: 't', content: 'c' }
      ],
      {},
      root
    )
    expect(result.saved).toHaveLength(1)
    expect(result.rejected).toEqual([
      { index: 1, reason: expect.stringContaining('jiraKey') },
      { index: 2, reason: expect.stringContaining('type') }
    ])
  })

  it('listLessons 支持 jiraKey / type / tag / q 过滤', () => {
    writeLessons(
      [
        makeInput({ jiraKey: 'A-1', type: 'pitfall', title: '坑1', tags: ['jira'] }),
        makeInput({ jiraKey: 'A-1', type: 'rule', title: '规则1', tags: ['cors'] }),
        makeInput({ jiraKey: 'B-2', type: 'pitfall', title: '坑2', tags: ['watcher'] })
      ],
      {},
      root
    )
    expect(listLessons({}, root)).toHaveLength(3)
    expect(listLessons({ jiraKey: 'A-1' }, root)).toHaveLength(2)
    expect(listLessons({ type: 'pitfall' }, root)).toHaveLength(2)
    expect(listLessons({ tag: 'cors' }, root)).toHaveLength(1)
    expect(listLessons({ q: '规则' }, root)).toHaveLength(1)
  })

  it('removeLesson 同步删 INDEX 条目', () => {
    // v2.18.0 起 writeLessons 会按 type+scope+tags+title/files 自动合并相似 lesson,
    // 这里用两条 type / tags 不同的 lesson 保证产出两个独立文件。
    const { saved } = writeLessons(
      [
        makeInput({ type: 'pitfall', tags: ['jira', 'baseUrl'], title: '坑 A' }),
        makeInput({ type: 'rule', tags: ['cors', 'preflight'], title: '规则 B' })
      ],
      {},
      root
    )
    expect(saved).toHaveLength(2)
    const target = saved[0].id
    expect(removeLesson(target, root)).toBe(true)
    expect(existsSync(lessonFilePath(target, root))).toBe(false)
    const idx = readLessonsIndex(root)
    expect(idx.lessons.find((l) => l.id === target)).toBeUndefined()
    expect(idx.lessons).toHaveLength(1)
  })

  it('removeLesson 对不存在 id 返回 false', () => {
    expect(removeLesson('lsn-NOPE-12345678', root)).toBe(false)
  })

  it('buildLessonsBundle 拼装 requirement + iterations + existingLessons', () => {
    saveRequirement({ jiraKey: 'PROJ-9', title: 'demo' }, { root })
    appendIteration('PROJ-9', { kind: 'init', branch: 'feature/PROJ-9' }, root)
    appendIteration('PROJ-9', { kind: 'coding', branch: 'feature/PROJ-9' }, root)
    writeLessons([makeInput({ jiraKey: 'PROJ-9' })], {}, root)
    writeLessons([makeInput({ jiraKey: 'OTHER-1' })], {}, root)
    const bundle = buildLessonsBundle('PROJ-9', root)
    expect(bundle.jiraKey).toBe('PROJ-9')
    expect(bundle.requirement?.title).toBe('demo')
    expect(bundle.iterations).toHaveLength(2)
    expect(bundle.existingLessons).toHaveLength(1)
    expect(bundle.existingLessons[0].jiraKey).toBe('PROJ-9')
  })

  it('readLessonsIndex 损坏时降级为空索引', () => {
    const path = lessonsIndexPath(root)
    require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true })
    require('node:fs').writeFileSync(path, '{not json}', 'utf-8')
    expect(readLessonsIndex(root).lessons).toEqual([])
  })

  it('writeLessons 字段截断: title >200 / content >4000 / tags 去重 + 上限 16', () => {
    const longTitle = 'a'.repeat(300)
    const longContent = 'b'.repeat(5000)
    const tags = Array.from({ length: 30 }, (_, i) => `tag-${i % 5}`)
    const result = writeLessons(
      [makeInput({ title: longTitle, content: longContent, tags })],
      {},
      root
    )
    const saved = result.saved[0]
    expect(saved.title.length).toBe(200)
    expect(saved.content.length).toBe(4000)
    expect(saved.tags.length).toBe(5)
  })

  // v2.17.0 scope / projectSlug 用例
  it('writeLessons scope 缺省 → 默认 project', () => {
    saveRequirement({ jiraKey: 'PROJ-2', title: 'demo', projectSlug: 'slug-x' }, { root })
    const result = writeLessons([makeInput({ jiraKey: 'PROJ-2' })], {}, root)
    const saved = result.saved[0]
    expect(saved.scope).toBe('project')
    expect(saved.projectSlug).toBe('slug-x')
  })

  it('writeLessons scope=general 强制清空 projectSlug', () => {
    saveRequirement({ jiraKey: 'PROJ-3', title: 'demo', projectSlug: 'slug-y' }, { root })
    const result = writeLessons(
      [
        makeInput({
          jiraKey: 'PROJ-3',
          scope: 'general',
          projectSlug: 'shouldBeCleared' as never
        })
      ],
      {},
      root
    )
    const saved = result.saved[0]
    expect(saved.scope).toBe('general')
    expect(saved.projectSlug).toBe('')
  })

  it('writeLessons scope 非法值 → 兜底 project', () => {
    saveRequirement({ jiraKey: 'PROJ-4', title: 'demo', projectSlug: 'slug-z' }, { root })
    const result = writeLessons([makeInput({ jiraKey: 'PROJ-4', scope: 'foo' as never })], {}, root)
    expect(result.saved[0].scope).toBe('project')
    expect(result.saved[0].projectSlug).toBe('slug-z')
  })

  it('writeLessons scope=project 显式 projectSlug 优先于 requirement 兜底', () => {
    saveRequirement({ jiraKey: 'PROJ-5', title: 'demo', projectSlug: 'auto-slug' }, { root })
    const result = writeLessons(
      [makeInput({ jiraKey: 'PROJ-5', scope: 'project', projectSlug: 'manual-slug' })],
      {},
      root
    )
    expect(result.saved[0].projectSlug).toBe('manual-slug')
  })

  it('listLessons 按 scope / projectSlug 过滤', () => {
    saveRequirement({ jiraKey: 'A-9', title: 't', projectSlug: 'app-a' }, { root })
    saveRequirement({ jiraKey: 'B-9', title: 't', projectSlug: 'app-b' }, { root })
    writeLessons(
      [
        makeInput({ jiraKey: 'A-9', scope: 'project', title: 'a-project' }),
        makeInput({ jiraKey: 'A-9', scope: 'general', title: '通用' }),
        makeInput({ jiraKey: 'B-9', scope: 'project', title: 'b-project' })
      ],
      {},
      root
    )
    expect(listLessons({ scope: 'general' }, root)).toHaveLength(1)
    expect(listLessons({ scope: 'project' }, root)).toHaveLength(2)
    expect(listLessons({ projectSlug: 'app-a' }, root)).toHaveLength(1)
    expect(listLessons({ scope: 'project', projectSlug: 'app-b' }, root)).toHaveLength(1)
  })

  it('readLessonsIndex 老 INDEX 缺 scope/projectSlug 字段 → 兜底空串', () => {
    const path = lessonsIndexPath(root)
    require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true })
    require('node:fs').writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        lessons: [
          {
            id: 'lsn-LEGACY-12345678',
            jiraKey: 'LEGACY-1',
            type: 'rule',
            title: '老经验',
            tags: [],
            trust: 'high',
            createdAt: '2026-01-01T00:00:00Z'
          }
        ]
      }),
      'utf-8'
    )
    const rows = readLessonsIndex(root).lessons
    expect(rows).toHaveLength(1)
    expect(rows[0].scope).toBe('')
    expect(rows[0].projectSlug).toBe('')
  })

  it('listLessons scope=unscoped 仅返回老数据', () => {
    saveRequirement({ jiraKey: 'NEW-1', title: 't', projectSlug: 'p' }, { root })
    writeLessons([makeInput({ jiraKey: 'NEW-1', scope: 'project' })], {}, root)
    // 手工塞一条老格式 INDEX 条目(模拟 v2.16.x 落盘 + 单文件无 scope)
    const lessonId = 'lsn-OLD-99999999'
    const oldLesson = {
      id: lessonId,
      jiraKey: 'OLD-1',
      jiraTitle: '',
      type: 'rule',
      title: '老',
      content: '内容',
      tags: [],
      trust: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      source: { extractedBy: 'manual', extractedAt: '2026-01-01T00:00:00Z' }
      // 故意不含 scope / projectSlug
    }
    require('node:fs').writeFileSync(
      require('node:path').join(root, 'lessons', `${lessonId}.json`),
      JSON.stringify(oldLesson),
      'utf-8'
    )
    // 重新 writeLessons 一次以触发 INDEX rebuild
    writeLessons([makeInput({ jiraKey: 'NEW-1', scope: 'project', title: 'extra' })], {}, root)
    const unscoped = listLessons({ scope: 'unscoped' }, root)
    expect(unscoped.find((l) => l.id === lessonId)).toBeDefined()
    expect(unscoped.every((l) => l.scope === '')).toBe(true)
  })

  it('buildLessonsBundle 返回 currentProjectSlug 并过滤跨项目 existingLessons', () => {
    saveRequirement({ jiraKey: 'CUR-9', title: 'cur', projectSlug: 'cur-app' }, { root })
    saveRequirement({ jiraKey: 'OTH-9', title: 'oth', projectSlug: 'other-app' }, { root })
    writeLessons(
      [
        makeInput({ jiraKey: 'CUR-9', scope: 'project', title: 'self-proj' }),
        makeInput({ jiraKey: 'OTH-9', scope: 'general', title: '通用' }),
        makeInput({ jiraKey: 'OTH-9', scope: 'project', title: 'other-proj' })
      ],
      {},
      root
    )
    const bundle = buildLessonsBundle('CUR-9', root)
    expect(bundle.currentProjectSlug).toBe('cur-app')
    const titles = bundle.existingLessons.map((l) => l.title).sort()
    expect(titles).toEqual(['self-proj', '通用'])
  })

  it('buildLessonsBundle currentProjectSlug 为空时退化为同 jiraKey 全部经验 + 通用', () => {
    // requirement 无 projectSlug 的老场景
    saveRequirement({ jiraKey: 'LEG-1', title: 'legacy' }, { root })
    saveRequirement({ jiraKey: 'CTX-1', title: 'ctx', projectSlug: 'ctx-app' }, { root })
    writeLessons(
      [
        makeInput({ jiraKey: 'LEG-1', scope: 'project', title: '本需求-项目' }),
        makeInput({ jiraKey: 'CTX-1', scope: 'general', title: '通用' }),
        makeInput({ jiraKey: 'CTX-1', scope: 'project', title: '别项目-项目' })
      ],
      {},
      root
    )
    const bundle = buildLessonsBundle('LEG-1', root)
    expect(bundle.currentProjectSlug).toBe('')
    const titles = bundle.existingLessons.map((l) => l.title).sort()
    // 本 jiraKey 自身 + 通用,避免老数据场景漏看
    expect(titles).toContain('本需求-项目')
    expect(titles).toContain('通用')
    expect(titles).not.toContain('别项目-项目')
  })

  // ============ v2.18.0 信号化 + 合并算法 用例 ============

  describe('v2.18.0 纯函数', () => {
    it('tagsJaccard 两端空 → 1.0,任一端空 → 0,大小写不敏感', () => {
      expect(tagsJaccard([], [])).toBe(1)
      expect(tagsJaccard(['a'], [])).toBe(0)
      expect(tagsJaccard([], ['a'])).toBe(0)
      // {jira, cors} vs {JIRA, watcher} -> inter={jira}, union={jira,cors,watcher} = 1/3
      const score = tagsJaccard(['jira', 'cors'], ['JIRA', 'watcher'])
      expect(score).toBeCloseTo(1 / 3, 4)
      // 完全相同 → 1
      expect(tagsJaccard(['a', 'b'], ['b', 'A'])).toBe(1)
    })

    it('titleSimilarity 中英文混排,完全相同→1,完全不同→0', () => {
      expect(titleSimilarity('foo bar baz', 'foo bar baz')).toBe(1)
      expect(titleSimilarity('完全 不同 内容', 'apple banana cherry')).toBe(0)
      // Jira 与 baseUrl 缺协议 vs Jira baseUrl 缺 https 协议
      const s = titleSimilarity('Jira baseUrl 缺协议', 'Jira baseUrl 缺协议提示')
      // 多数 token 重叠 → 应远超 0.5
      expect(s).toBeGreaterThan(0.6)
      // 两端空 → 1
      expect(titleSimilarity('', '')).toBe(1)
      // 一端空 → 0
      expect(titleSimilarity('a', '')).toBe(0)
    })

    it('recomputeTrustReasons 含 boost / bug=0 / 同款踩了 N 次', () => {
      const signals: LessonSignals = {
        sourceBoost: 8.2,
        sourceLinkedBugCount: 0,
        sourceEffectiveTokens: 234_000,
        sourceThinkSeconds: 421,
        sourceAbnormalStopReasons: [],
        sourceMaxChurnFile: {
          path: 'apps/web/src/foo.vue',
          touchCount: 4,
          insertions: 120,
          deletions: 80
        }
      }
      const reasons = recomputeTrustReasons(signals, 3)
      expect(reasons.some((r) => r.includes('boost=8.2x') && r.includes('高效'))).toBe(true)
      expect(reasons.some((r) => r.includes('bug=0') && r.includes('无回归'))).toBe(true)
      expect(reasons.some((r) => r.includes('234.0k') || r.includes('tokens'))).toBe(true)
      expect(
        reasons.some(
          (r) => r.includes('churn') && r.includes('apps/web/src/foo.vue') && r.includes('4轮')
        )
      ).toBe(true)
      expect(reasons.some((r) => r.includes('同款踩了 3 次'))).toBe(true)
    })

    it('recomputeTrustReasons hitCount=1 不输出"同款踩了"', () => {
      const reasons = recomputeTrustReasons(
        {
          sourceBoost: null,
          sourceLinkedBugCount: null,
          sourceEffectiveTokens: null,
          sourceThinkSeconds: null,
          sourceAbnormalStopReasons: [],
          sourceMaxChurnFile: null
        },
        1
      )
      expect(reasons.find((r) => r.includes('同款踩了'))).toBeUndefined()
    })

    it('mergeSignals boost 取较高、bug 取较新、token/think 累加、stopReasons union', () => {
      const prev: LessonSignals = {
        sourceBoost: 3,
        sourceLinkedBugCount: 1,
        sourceEffectiveTokens: 1000,
        sourceThinkSeconds: 60,
        sourceAbnormalStopReasons: ['max_tokens'],
        sourceMaxChurnFile: { path: 'a.ts', touchCount: 2, insertions: 10, deletions: 5 }
      }
      const next: LessonSignals = {
        sourceBoost: 8,
        sourceLinkedBugCount: 0,
        sourceEffectiveTokens: 500,
        sourceThinkSeconds: 30,
        sourceAbnormalStopReasons: ['pause_turn'],
        sourceMaxChurnFile: { path: 'b.ts', touchCount: 5, insertions: 50, deletions: 20 }
      }
      const merged = mergeSignals(prev, next)
      expect(merged.sourceBoost).toBe(8)
      expect(merged.sourceLinkedBugCount).toBe(0)
      expect(merged.sourceEffectiveTokens).toBe(1500)
      expect(merged.sourceThinkSeconds).toBe(90)
      expect(merged.sourceAbnormalStopReasons.sort()).toEqual(['max_tokens', 'pause_turn'])
      expect(merged.sourceMaxChurnFile?.path).toBe('b.ts')
    })
  })

  describe('v2.18.0 computeSignals', () => {
    it('从 requirement.boost + iterations 算出 token / think / churn', () => {
      saveRequirement(
        {
          jiraKey: 'SIG-1',
          title: 'sig',
          projectSlug: 'sig-app',
          manualEstimateMinutes: 600
        },
        { root }
      )
      appendIteration('SIG-1', { kind: 'init', branch: 'feature/SIG-1' }, root)
      // seq 2:大 think + 同一文件第一次出现
      appendIteration(
        'SIG-1',
        {
          kind: 'coding',
          branch: 'feature/SIG-1',
          thinkSeconds: 60,
          cumulativeToken: 50_000,
          elapsedMinutes: 60,
          changedFiles: [{ path: 'apps/web/src/foo.vue', status: 'M' }],
          diffInsertions: 40,
          diffDeletions: 20
        },
        root
      )
      // seq 3:同款文件第二次改 + 另一文件
      appendIteration(
        'SIG-1',
        {
          kind: 'coding',
          branch: 'feature/SIG-1',
          thinkSeconds: 90,
          cumulativeToken: 100_000,
          elapsedMinutes: 60,
          changedFiles: [
            { path: 'apps/web/src/foo.vue', status: 'M' },
            { path: 'apps/api/src/bar.ts', status: 'M' }
          ],
          diffInsertions: 30,
          diffDeletions: 10
        },
        root
      )
      const signals = computeSignals('SIG-1', [2, 3], root)
      expect(signals.sourceBoost).toBeGreaterThan(0) // computeMetrics 算出正数
      expect(signals.sourceEffectiveTokens).toBe(50_000 + 100_000)
      expect(signals.sourceThinkSeconds).toBe(60 + 90)
      // foo.vue 触碰 2 次,bar.ts 触碰 1 次 → maxChurn=foo.vue
      expect(signals.sourceMaxChurnFile?.path).toBe('apps/web/src/foo.vue')
      expect(signals.sourceMaxChurnFile?.touchCount).toBe(2)
      expect(signals.sourceAbnormalStopReasons).toEqual([])
    })

    it('iterationSeqs 缺省 → 累计全需求', () => {
      saveRequirement({ jiraKey: 'SIG-2', title: 'sig2', manualEstimateMinutes: 60 }, { root })
      appendIteration('SIG-2', { kind: 'init', branch: 'f/SIG-2' }, root)
      appendIteration(
        'SIG-2',
        { kind: 'coding', branch: 'f/SIG-2', thinkSeconds: 20, cumulativeToken: 1000 },
        root
      )
      const signals = computeSignals('SIG-2', undefined, root)
      expect(signals.sourceThinkSeconds).toBe(20)
      expect(signals.sourceEffectiveTokens).toBe(1000)
    })

    it('requirement.bugsRefreshedAt 为空时 sourceLinkedBugCount=null', () => {
      saveRequirement({ jiraKey: 'BUG-1', title: 'b', manualEstimateMinutes: 60 }, { root })
      appendIteration('BUG-1', { kind: 'init', branch: 'f/BUG-1' }, root)
      const signals = computeSignals('BUG-1', undefined, root)
      expect(signals.sourceLinkedBugCount).toBeNull()
    })

    it('requirement.bugsRefreshedAt 有值时 sourceLinkedBugCount 取 requirement.linkedBugCount', () => {
      saveRequirement(
        { jiraKey: 'BUG-2', title: 'b', manualEstimateMinutes: 60, linkedBugCount: 2 },
        { root }
      )
      updateRequirement('BUG-2', { bugsRefreshedAt: '2026-05-22T00:00:00Z' }, root)
      appendIteration('BUG-2', { kind: 'init', branch: 'f/BUG-2' }, root)
      const signals = computeSignals('BUG-2', undefined, root)
      expect(signals.sourceLinkedBugCount).toBe(2)
    })
  })

  describe('v2.15.0 isStrongCandidateIteration(per-turn 强候选判定)', () => {
    it('STRONG_THINK_SECONDS 锁定为 180(防误改)', () => {
      expect(STRONG_THINK_SECONDS).toBe(180)
    })

    it('本轮思考时长 ≥ 180s → hit,reasons 含思考时长', () => {
      saveRequirement({ jiraKey: 'STRONG-1', title: 's', manualEstimateMinutes: 60 }, { root })
      appendIteration('STRONG-1', { kind: 'init', branch: 'f/STRONG-1' }, root)
      appendIteration(
        'STRONG-1',
        { kind: 'coding', branch: 'f/STRONG-1', thinkSeconds: 200, cumulativeToken: 1000 },
        root
      )
      const res = isStrongCandidateIteration('STRONG-1', 2, root)
      expect(res.hit).toBe(true)
      expect(res.reasons.some((r) => r.includes('思考时长'))).toBe(true)
    })

    it('本轮被异常 stopReason(max_tokens)打断 → hit,reasons 含异常中断', () => {
      saveRequirement({ jiraKey: 'STRONG-2', title: 's', manualEstimateMinutes: 60 }, { root })
      appendIteration('STRONG-2', { kind: 'init', branch: 'f/STRONG-2' }, root)
      appendIteration(
        'STRONG-2',
        {
          kind: 'coding',
          branch: 'f/STRONG-2',
          thinkSeconds: 10,
          cumulativeToken: 1000,
          rawPayload: { triggerStopReason: 'max_tokens' }
        },
        root
      )
      const res = isStrongCandidateIteration('STRONG-2', 2, root)
      expect(res.hit).toBe(true)
      expect(res.reasons.some((r) => r.includes('异常中断'))).toBe(true)
      expect(res.reasons.some((r) => r.includes('max_tokens'))).toBe(true)
    })

    it('思考短 + 正常 stopReason(end_turn) → 不 hit', () => {
      saveRequirement({ jiraKey: 'STRONG-3', title: 's', manualEstimateMinutes: 60 }, { root })
      appendIteration('STRONG-3', { kind: 'init', branch: 'f/STRONG-3' }, root)
      appendIteration(
        'STRONG-3',
        {
          kind: 'coding',
          branch: 'f/STRONG-3',
          thinkSeconds: 30,
          cumulativeToken: 1000,
          rawPayload: { triggerStopReason: 'end_turn' }
        },
        root
      )
      const res = isStrongCandidateIteration('STRONG-3', 2, root)
      expect(res.hit).toBe(false)
      expect(res.reasons).toEqual([])
    })

    it('阈值边界:正好 180s → hit;179s → 不 hit', () => {
      saveRequirement({ jiraKey: 'STRONG-4', title: 's', manualEstimateMinutes: 60 }, { root })
      appendIteration('STRONG-4', { kind: 'init', branch: 'f/STRONG-4' }, root)
      appendIteration(
        'STRONG-4',
        { kind: 'coding', branch: 'f/STRONG-4', thinkSeconds: 180, cumulativeToken: 1 },
        root
      )
      appendIteration(
        'STRONG-4',
        { kind: 'coding', branch: 'f/STRONG-4', thinkSeconds: 179, cumulativeToken: 1 },
        root
      )
      expect(isStrongCandidateIteration('STRONG-4', 2, root).hit).toBe(true)
      expect(isStrongCandidateIteration('STRONG-4', 3, root).hit).toBe(false)
    })

    it('非法 seq(0 / 负 / 非整数) → 不 hit,不抛', () => {
      expect(isStrongCandidateIteration('STRONG-1', 0, root)).toEqual({ hit: false, reasons: [] })
      expect(isStrongCandidateIteration('STRONG-1', -1, root)).toEqual({ hit: false, reasons: [] })
      expect(isStrongCandidateIteration('STRONG-1', 1.5, root)).toEqual({ hit: false, reasons: [] })
    })

    it('per-turn 单条落盘后再批量 extract 同款 → 自动合并(replaced 命中,hitCount 不虚增)', () => {
      saveRequirement(
        { jiraKey: 'MERGE-PT', title: 's', projectSlug: 'pt-app', manualEstimateMinutes: 60 },
        { root }
      )
      // per-turn 单条沉淀(seq 5)
      const first = writeLessons(
        [
          {
            jiraKey: 'MERGE-PT',
            type: 'pitfall',
            title: '同款踩坑:异步写时序不可控',
            content: 'fire-and-forget 跨进程时序不可控,应改同步写',
            scope: 'project',
            projectSlug: 'pt-app',
            tags: ['sentinel', 'async'],
            iterationSeqs: [5]
          }
        ],
        { extractedBy: 'cursor' },
        root
      )
      expect(first.saved.length).toBe(1)
      const firstId = first.saved[0].id
      // 整需求批量 extract 又推出同款(title/tags 高度相似)→ 应合并到同一条
      const second = writeLessons(
        [
          {
            jiraKey: 'MERGE-PT',
            type: 'pitfall',
            title: '同款踩坑:异步写时序不可控',
            content: 'fire-and-forget 跨进程时序不可控,应改同步写(批量复盘补充)',
            scope: 'project',
            projectSlug: 'pt-app',
            tags: ['sentinel', 'async'],
            iterationSeqs: [5]
          }
        ],
        { extractedBy: 'manual' },
        root
      )
      expect(second.replaced).toContain(firstId)
      // 合并后经验库仍只有一条
      expect(listLessons({ jiraKey: 'MERGE-PT' }, root).length).toBe(1)
    })
  })

  describe('v2.18.0 findMergeCandidate + writeLessons 合并路径', () => {
    function makeLessonForMerge(overrides: Partial<StoredLesson>): StoredLesson {
      return {
        id: 'lsn-A-aaaa1111',
        jiraKey: 'A-1',
        jiraTitle: '',
        type: 'pitfall',
        title: 'baseUrl 缺协议导致 422',
        content: 'x',
        tags: ['jira', 'baseurl'],
        affectedFiles: ['apps/api/src/jira-client.ts'],
        iterationSeqs: [],
        trust: 'high',
        createdAt: '2026-05-01T00:00:00Z',
        source: { extractedBy: 'manual', extractedAt: '2026-05-01T00:00:00Z' },
        scope: 'general',
        projectSlug: '',
        signals: null,
        seenInJiraKeys: ['A-1'],
        hitCount: 1,
        trustReasons: [],
        ...overrides
      } as StoredLesson
    }

    it('findMergeCandidate 命中:同 type/scope/projectSlug + tags Jaccard 高 + 标题相似', () => {
      const existing = [makeLessonForMerge({})]
      const target = makeLessonForMerge({
        id: 'lsn-B-bbbb2222',
        jiraKey: 'B-2',
        title: 'baseUrl 缺协议导致 422 错误', // 高相似
        seenInJiraKeys: ['B-2']
      })
      expect(findMergeCandidate(existing, target)?.id).toBe('lsn-A-aaaa1111')
    })

    it('findMergeCandidate 不命中:tags 重合但 type 不同', () => {
      const existing = [makeLessonForMerge({ type: 'pitfall' })]
      const target = makeLessonForMerge({
        id: 'lsn-B-bbbb2222',
        jiraKey: 'B-2',
        type: 'rule', // 不同 type
        title: 'baseUrl 缺协议导致 422'
      })
      expect(findMergeCandidate(existing, target)).toBeNull()
    })

    it('findMergeCandidate 不命中:scope 不同(general vs project)', () => {
      const existing = [makeLessonForMerge({ scope: 'general', projectSlug: '' })]
      const target = makeLessonForMerge({
        id: 'lsn-B-bbbb2222',
        scope: 'project',
        projectSlug: 'some-app'
      })
      expect(findMergeCandidate(existing, target)).toBeNull()
    })

    it('writeLessons 合并路径:同款 lesson 跨需求第二次落盘 → 老条目累加 seenInJiraKeys + hitCount', () => {
      saveRequirement(
        { jiraKey: 'M-1', title: 't1', projectSlug: 'm-app', manualEstimateMinutes: 60 },
        { root }
      )
      saveRequirement(
        { jiraKey: 'M-2', title: 't2', projectSlug: 'm-app', manualEstimateMinutes: 60 },
        { root }
      )
      appendIteration('M-1', { kind: 'init', branch: 'f/M-1' }, root)
      appendIteration('M-2', { kind: 'init', branch: 'f/M-2' }, root)

      const first = writeLessons(
        [makeInput({ jiraKey: 'M-1', scope: 'general', tags: ['jira', 'baseurl'] })],
        {},
        root
      )
      expect(first.saved).toHaveLength(1)
      const firstId = first.saved[0].id

      const second = writeLessons(
        [
          makeInput({
            jiraKey: 'M-2',
            scope: 'general',
            tags: ['jira', 'baseurl', 'cors'], // tagsJaccard >= 0.5
            title: 'baseUrl 缺协议导致 422 错误'
          })
        ],
        {},
        root
      )
      // 第二次没新建,而是合并到 firstId
      expect(second.replaced).toContain(firstId)
      const totalFiles = readLessonsIndex(root).lessons
      expect(totalFiles).toHaveLength(1)
      const reload = loadLesson(firstId, root)!
      expect(reload.seenInJiraKeys.sort()).toEqual(['M-1', 'M-2'])
      expect(reload.hitCount).toBe(2)
      expect(reload.trustReasons.some((r) => r.includes('同款踩了 2 次'))).toBe(true)
    })

    it('writeLessons 同款 lesson 跨 jiraKey 重复落盘多次 → seenInJiraKeys 不重复 push', () => {
      saveRequirement({ jiraKey: 'X-1', title: 't', projectSlug: 'x-app' }, { root })
      writeLessons([makeInput({ jiraKey: 'X-1', scope: 'general', tags: ['jira'] })], {}, root)
      writeLessons([makeInput({ jiraKey: 'X-1', scope: 'general', tags: ['jira'] })], {}, root)
      writeLessons([makeInput({ jiraKey: 'X-1', scope: 'general', tags: ['jira'] })], {}, root)
      const all = readLessonsIndex(root).lessons
      expect(all).toHaveLength(1)
      const lesson = loadLesson(all[0].id, root)!
      expect(lesson.seenInJiraKeys).toEqual(['X-1'])
      expect(lesson.hitCount).toBe(1)
    })

    it('writeLessons 新建路径:首次 lesson 直接初算 signals + trustReasons', () => {
      saveRequirement(
        { jiraKey: 'N-1', title: 't', projectSlug: 'n-app', manualEstimateMinutes: 600 },
        { root }
      )
      appendIteration('N-1', { kind: 'init', branch: 'f/N-1' }, root)
      appendIteration(
        'N-1',
        {
          kind: 'coding',
          branch: 'f/N-1',
          thinkSeconds: 120,
          cumulativeToken: 50_000,
          elapsedMinutes: 60
        },
        root
      )
      const result = writeLessons(
        [makeInput({ jiraKey: 'N-1', scope: 'project', iterationSeqs: [2] })],
        {},
        root
      )
      const saved = result.saved[0]
      expect(saved.signals).not.toBeNull()
      expect(saved.signals?.sourceThinkSeconds).toBe(120)
      expect(saved.signals?.sourceEffectiveTokens).toBe(50_000)
      expect(saved.seenInJiraKeys).toEqual(['N-1'])
      expect(saved.hitCount).toBe(1)
      // trustReasons 至少含 boost / tokens 之一
      expect(saved.trustReasons.length).toBeGreaterThan(0)
    })

    it('writeLessons 显式 id 命中老文件 → 覆盖式更新 + 保留老 seenInJiraKeys', () => {
      saveRequirement({ jiraKey: 'U-1', title: 't' }, { root })
      const id = generateLessonId('U-1')
      writeLessons([makeInput({ id, jiraKey: 'U-1', title: 'first' })], {}, root)
      // 二次相同 id 但 jiraKey 不同,合并语义:seenInJiraKeys 应包含两者
      const second = writeLessons([makeInput({ id, jiraKey: 'U-2', title: 'second' })], {}, root)
      expect(second.replaced).toContain(id)
      const reload = loadLesson(id, root)!
      expect(reload.seenInJiraKeys.sort()).toEqual(['U-1', 'U-2'])
      // title 用 LLM 最新值(覆盖式更新语义)
      expect(reload.title).toBe('second')
    })
  })

  describe('v2.18.0 buildLessonsBundle.computedSignals', () => {
    it('返回 topThinkSeqs / fileChurnMap / cumulative 三件套', () => {
      saveRequirement(
        { jiraKey: 'BS-1', title: 'bs', projectSlug: 'bs-app', manualEstimateMinutes: 600 },
        { root }
      )
      appendIteration('BS-1', { kind: 'init', branch: 'f/BS-1' }, root)
      appendIteration(
        'BS-1',
        {
          kind: 'coding',
          branch: 'f/BS-1',
          thinkSeconds: 30,
          cumulativeToken: 10_000,
          changedFiles: [{ path: 'a.ts', status: 'M' }],
          diffInsertions: 5,
          diffDeletions: 5
        },
        root
      )
      appendIteration(
        'BS-1',
        {
          kind: 'coding',
          branch: 'f/BS-1',
          thinkSeconds: 200, // 应排第 1
          cumulativeToken: 20_000,
          changedFiles: [{ path: 'a.ts', status: 'M' }],
          diffInsertions: 10,
          diffDeletions: 5
        },
        root
      )
      appendIteration(
        'BS-1',
        {
          kind: 'coding',
          branch: 'f/BS-1',
          thinkSeconds: 100, // 应排第 2
          cumulativeToken: 30_000,
          changedFiles: [{ path: 'b.ts', status: 'M' }],
          diffInsertions: 20,
          diffDeletions: 0
        },
        root
      )
      const bundle = buildLessonsBundle('BS-1', root)
      expect(bundle.computedSignals).toBeDefined()
      expect(bundle.computedSignals.cumulativeThinkSeconds).toBe(30 + 200 + 100)
      // topThinkSeqs 按 think 倒序:seq=3(200s), seq=4(100s), seq=2(30s)
      expect(bundle.computedSignals.topThinkSeqs).toEqual([3, 4, 2])
      // fileChurnMap a.ts 触碰 2 次,b.ts 触碰 1 次 → 排序后 a.ts 在前
      expect(bundle.computedSignals.fileChurnMap[0].path).toBe('a.ts')
      expect(bundle.computedSignals.fileChurnMap[0].touchedSeqs.sort()).toEqual([2, 3])
    })

    it('老 lesson 缺 signals/seenInJiraKeys/hitCount/trustReasons 时 loadLesson 兜底正常', () => {
      // 手工塞老格式 lesson 文件
      const lessonId = 'lsn-OLD-aaaa1111'
      require('node:fs').mkdirSync(require('node:path').join(root, 'lessons'), { recursive: true })
      require('node:fs').writeFileSync(
        require('node:path').join(root, 'lessons', `${lessonId}.json`),
        JSON.stringify({
          id: lessonId,
          jiraKey: 'OLD-1',
          jiraTitle: '',
          type: 'rule',
          title: '老经验',
          content: '内容',
          tags: [],
          trust: 'high',
          createdAt: '2026-01-01T00:00:00Z',
          source: { extractedBy: 'manual', extractedAt: '2026-01-01T00:00:00Z' }
          // 故意缺 signals / seenInJiraKeys / hitCount / trustReasons
        }),
        'utf-8'
      )
      const lesson = loadLesson(lessonId, root)!
      expect(lesson.signals).toBeNull()
      expect(lesson.seenInJiraKeys).toEqual(['OLD-1'])
      expect(lesson.hitCount).toBe(1)
      expect(lesson.trustReasons).toEqual([])
    })
  })
})
