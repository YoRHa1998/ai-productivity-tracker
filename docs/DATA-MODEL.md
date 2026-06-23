# DATA MODEL

> `~/.ai-productivity-tracker/` 下每个文件 schema 详细字段。
> 实现位于 `@ai-productivity-tracker/core/src/store/`。

---

## 1. 目录布局

```
~/.ai-productivity-tracker/
├── config.json                   # 用户偏好(端口/host/dataRoot 锁定)
├── runtime.json                  # daemon 进程协调凭证(pid/port/token)
├── logs/                         # daemon 日志(按需文件 logger)
│   ├── daemon-out.log
│   └── daemon-err.log
├── hook-state/                   # 防伪造校验时间窗
│   └── <JIRA-KEY>.recent-attach.json
└── data/                         # 业务数据根
    ├── index.json                # 全部 jiraKey 索引
    ├── bindings.json             # cwd ↔ jiraKey 路由表
    ├── formula.json              # 提效公式参数
    ├── jira.json                 # Jira 凭证
    ├── pending-summary.json      # attach_summary 等待消费的中间态
    ├── transcript-state.json     # Claude Code jsonl 监听 offset
    ├── codex-state.json          # Codex jsonl 监听 offset + per-session 累计 token 基线
    ├── hook-dedupe.json          # hook dedupeKey LRU(防重复上报)
    ├── lessons/
    │   ├── INDEX.json            # 投影索引(供看板列表筛选)
    │   └── lsn-<JIRA-KEY>-<rand>.json
    └── <JIRA-KEY>/               # 单需求目录
        ├── requirement.json      # 需求元数据
        ├── iterations.jsonl      # 每轮对话一条 iteration
        ├── subtask-events.jsonl  # 子任务勾选事件(v2.x 已下线,字段保留)
        ├── numstat-snapshot.json # 上一轮 numstat 快照(增量 diff 用)
        ├── retrospective.json    # v1.0.0-rc.23 单需求复盘报告(单文件覆盖)
        └── raw/                  # 每轮原始 hook payload(审计)
            ├── 1.json
            ├── 2.json
            └── ...
```

文件权限默认 `0600`;`~/.ai-productivity-tracker/` 目录默认 `0700`。

---

## 2. `runtime.json`

daemon 进程协调凭证。**不应被用户手动编辑**,daemon 启动时原子写,SIGTERM 时清。

```ts
interface RuntimeLock {
  pid: number // daemon 进程 pid
  port: number // daemon listen 端口
  host: string // 固定 '127.0.0.1'
  token: string // 64 字符 hex,Bearer token
  startedAt: string // ISO8601
  version: string // daemon 进程的 cli 版本
  dataRoot: string // 实际生效的 data root 绝对路径
}
```

---

## 3. `config.json`

用户偏好。可手动编辑,daemon 启动时读。

```ts
interface UserConfig {
  port?: number // 锁定端口
  host?: string // 仅允许 '127.0.0.1'
  allowedOrigins?: string[] // 额外放行的 CORS origin(默认空,只放 loopback)
  dataRoot?: string // 覆盖数据根
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRotateDays?: number
  watcher?: {
    enabled?: boolean
    claudeProjectsDir?: string
    staleTurnFlushMs?: number // transcript-watcher buffer 闲置 flush 阈值
  }
}
```

---

## 4. `data/<JIRA-KEY>/requirement.json`

单需求元数据。每个 jiraKey 一份。

```ts
interface StoredRequirement {
  jiraKey: string // 'INSTANT-5321'
  jiraUrl: string // 'https://xxx.atlassian.net/browse/INSTANT-5321'
  title: string // Jira summary;init 时拉,失败回退到 jiraKey
  summary: string // 长描述(可选)
  complexity: 'low' | 'medium' | 'high'
  manualEstimateMinutes: number // 人工预估(分钟)
  subtasks: StoredSubtask[] // 子任务清单(v2 后已下线,数组保留为空)
  affectedPaths: string[]
  owner: string // 创建者(看板 "owner 列" 字段)
  projectSlug: string // 来自 cwd 仓库的 package.json name
  status: 'in_progress' | 'finished' | 'abandoned'
  linkedBugCount: number // Jira 关联 Bug 数(refresh-bugs 后写)
  linkedBugJql: string // 落盘的实际 JQL(含 bounded 兜底)
  bugsRefreshedAt: string | null
  startedAt: string // init 时间
  createdAt: string
  updatedAt: string

  // v2 已下线但保留兼容字段:
  clarifyReportPath: string
  clarifyReviewerScore: number | null
  clarifyConflicts: unknown[]

  // 内部使用:
  branch: string // init 时的分支名
  repoRoot: string // git root
  initBaseCommit: string // HEAD sha,iteration 算 diff 用

  // 需求级提效公式覆盖(rc.26+):
  // - 数值 ∈ [0,1]:覆盖全局 wThink。init 时 daemon 自动把当下全局 wThink 快照写入,
  //   之后调全局不再影响本需求 boost。
  // - null:跟随全局(老需求兼容路径,首次在详情页编辑后会固化为具体数值)。
  // - tokenPenaltyEnabled / tokenSoftCapK 不进入需求级,始终读全局 formula.json。
  formulaWThinkOverride: number | null
}
```

---

## 5. `data/<JIRA-KEY>/iterations.jsonl`

每行 1 个 iteration(每轮对话 1 条)。append-only。

```ts
interface StoredIteration {
  seq: number // 自增,从 1 开始(seq=1 通常是 init iteration)
  kind: 'init' | 'first_coding' | 'coding' | 'milestone'
  branch: string
  source: 'cursor' | 'claude-code' | 'codex' | 'unknown' // codex: CodexWatcher 监听 ~/.codex/sessions
  cumulativeToken: number // 截至本 iteration 的累计
  tokenDelta?: number // 本 iteration 比上一条增加的 token
  thinkSeconds: number // 真实 turn 时长(v2.12.0 起从 user prompt 到 end_turn)
  elapsedMinutes: number // 截至本轮的累计耗时
  modelName: string
  reportedAt: string

  // 本轮 diff(自上一轮 iteration 起)
  diffFiles: number
  diffInsertions: number
  diffDeletions: number
  changedFiles: { path: string; status: string }[]

  // 累计 diff(自 initBaseCommit 起)
  cumulativeDiffFiles: number
  cumulativeDiffInsertions: number
  cumulativeDiffDeletions: number
  cumulativeChangedFiles: { path: string; status: string }[]

  // v2.x 已下线但保留字段(避免老看板渲染崩溃)
  firstCodingCompletion: number | null
  aiQualitySelfScore: number | null
  aiConfidence: number | null
  milestoneNote: string

  // 原始 hook payload 落盘文件名(审计)
  rawPayloadFile: string | null

  // v2.4.0 结构化对话总结(LLM 通过 attach_summary 写入)
  conversationSummary: {
    oneLine: string // ≤120 字
    type: 'coding' | 'communication'
    changeScope?: string // type='coding' 时必填,≤120 字
    discussion?: string // type='communication' 时必填,≤300 字
  } | null

  // v2.11.1 起记录 transcript-watcher flush 触发源(审计)
  triggerStopReason?: 'end_turn' | 'max_tokens' | 'pause_turn' | 'stop_sequence' | 'stop_hook_summary' | 'stale_timeout'
}
```

---

## 6. `data/bindings.json`

cwd ↔ jiraKey 路由表。Hook / Watcher 通过 cwd 找当前 active jiraKey 用。

```ts
interface BindingsFile {
  schemaVersion: number
  bindings: BindingEntry[]
  pending: PendingEntry[] // pending 区:token 已上报但需求未 init
}

interface BindingEntry {
  jiraKey: string
  branch: string // init 时的分支
  projectRoot: string // git root
  startedAt: string // init 时间
  lastReportedAt: string // 最后一次 hook 上报时间(active 排序用)
  lastHookFiredAt: string // 最后一次 hook 调用时间
  lastIterationSeq: number
  cumulativeToken: number // 该 binding 累计上报的 token
  lastReportedAtBySource?: Record<string, string> // v2.12.0 source 分桶
}

interface PendingEntry {
  branch: string
  projectRoot: string
  jiraKey: string // 从分支解析出的 issue key,但需求未 init
  pendingTokens: number // 已累积但未 attach 的 token(init 时 carry over)
  firstSeenAt: string
}
```

---

## 7. `data/lessons/INDEX.json` + `lsn-*.json`

经验沉淀(v2.16.0 起)。平铺存储,跨 jiraKey 全局唯一。

### INDEX.json(投影,供看板列表筛选)

```ts
interface LessonsIndexFile {
  version: number
  updatedAt: string
  lessons: LessonIndexEntry[]
}

interface LessonIndexEntry {
  id: string // 'lsn-INSTANT-5321-a1b2c3d4'
  jiraKey: string
  type: 'pitfall' | 'rule' | 'best-practice' | 'split-suggestion' | 'tooling'
  title: string // 短标题 ≤200
  tags: string[] // 投影 ≤16
  trust: 'high' | 'medium' | 'low'
  createdAt: string
  scope: 'general' | 'project' | '' // v2.17.0 二级分类;空串=老数据未分类
  projectSlug: string
  hitCount: number // v2.18.0 跨需求出现次数
}
```

### lsn-\*.json(详情单文件)

```ts
interface StoredLesson extends LessonIndexEntry {
  content: string // 主体 ≤4000
  rootCause?: string
  fix?: string
  reusableWhen?: string
  affectedFiles?: string[] // ≤32
  iterationSeqs?: number[] // ≤64
  jiraTitle?: string // 冗余存储,看板列表展示

  // v2.18.0 信号化
  signals: LessonSignals | null
  seenInJiraKeys: string[] // 跨需求出现的 jiraKey 列表
  trustReasons: string[] // 人类可读证据
}

interface LessonSignals {
  sourceBoost: number | null
  sourceLinkedBugCount: number | null
  sourceEffectiveTokens: number | null
  sourceThinkSeconds: number | null
  sourceAbnormalStopReasons: string[]
  sourceMaxChurnFile: {
    path: string
    touchCount: number
    insertions: number
    deletions: number
  } | null
}
```

---

## 7.5. `data/<JIRA-KEY>/retrospective.json`

> v1.0.0-rc.23 引入。单需求复盘报告,**单文件覆盖式**:每个 jiraKey 至多保留一份最新报告,LLM 通过
> retrospective-report skill + `ai_productivity_save_retrospective` MCP tool 重新触发会替换老内容。

落盘路径 `data/<JIRA-KEY>/retrospective.json`,与 `requirement.json` / `iterations.jsonl` 同目录。

```ts
interface StoredRetrospective {
  schemaVersion: 1
  jiraKey: string
  generatedAt: string // ISO8601
  generatedAtIterationSeq: number // 基于哪一轮 iteration 生成(末轮 seq)
  generatedAtIterationCount: number // 生成时 iterations 总数
  source: 'cursor' | 'claude-code' | 'manual'

  // 落盘时 daemon 端基于 RequirementMetrics + iterations 自动计算的硬数据快照
  // (LLM 即便传相关字段也会被忽略;前端展示时优先用此处的数值,避免后续 iteration
  // 增长后报告里的客观数据漂移)
  snapshot: {
    title: string
    status: 'in_progress' | 'finished' | 'abandoned'
    boost: number | null
    cumulativeToken: number
    totalThinkSeconds: number
    elapsedMinutes: number
    cumulativeDiffFiles: number
    cumulativeDiffInsertions: number
    cumulativeDiffDeletions: number
    linkedBugCount: number
    lessonsCount: number
    abnormalStopReasonsCount: number
  }

  // LLM 推理产物的结构化叙事(每条字段都是 markdown / plain text)
  narrative: {
    overview: string // 总览 ≤600 字
    phases: Array<{
      title: string // ≤80 字
      iterationSeqRange: [number, number] // 闭区间;超范围会被 store 静默过滤
      summary: string // ≤400 字
    }> // 最多 8 段
    highlights: string[] // 亮点(每条 ≤300 字,最多 8 条)
    issues: string[] // 暴露的问题
    improvements: string[] // 改进建议
    pitfallsObserved: string[] // 观察到的坑(可与 lessons.pitfall 联动)
    nextSteps: string[] // 下次预热建议
    splitSuggestions?: string[] // 对话拆分建议(可选)
  }

  // 复盘里引用的 lesson id 列表;不属于本 jiraKey 的 id 会被 store 静默过滤
  // 通过 referencedLessonIds 实现「复盘 ⇄ lessons」弱引用,**不重复落盘** lesson 内容
  referencedLessonIds: string[] // 最多 32 条

  // 报告锚点 iteration(高 think / 高 churn / 异常 stop);超范围 seq 会被静默过滤
  anchorIterationSeqs: number[] // 最多 16 个
}
```

**与 lessons 的协同**:复盘报告负责「看板叙事产物」(per-feature),lessons 负责「跨需求知识条目沉淀」。
LLM 在复盘 narrative 中通过 `referencedLessonIds` 关联本需求已沉淀的 lesson,**严禁在复盘里直接落新 lesson**(用户想沉淀经验仍走 lessons-extract skill)。

**Schema 升级策略**:`loadRetrospective` 见到 `schemaVersion > 当前实现支持` 时返回 `null` + 不删盘
(打 console.warn),保留用户数据让未来 v2 schema 升级。

---

## 8. `data/pending-summary.json`

attach_summary 的中间态。LLM 调用 attach_summary 后写,下一条 iteration 落盘时被 `consumePendingSummary` 消费并挂到对应 iteration。

```ts
interface PendingSummaryFile {
  byJiraKey: Record<
    string,
    {
      summary: ConversationSummary
      source?: 'cursor' | 'claude-code' | 'codex'
      writtenAt: string
    }
  >
}
```

设计动机:attach_summary 调用时 iterationSeq 尚未确定(本轮 hook 还没触发);把总结落 pending,iteration 落盘时主动 consume,保证"本轮总结挂在本轮 iteration"。

---

## 9. `hook-state/<JIRA-KEY>.recent-attach.json`

stop-check 防伪造校验时间窗 sentinel(`@ai-productivity-tracker/hook-core lib/sentinel.ts`)。

```ts
interface RecentAttachPayload {
  jiraKey: string
  calledAt: string // ISO8601;stop-check 判断 Date.now() - new Date(calledAt) < 90s
}
```

attach_summary handler 同进程同步写,stop-check 后读。失效自动清理(7d GC)。

---

## 10. `data/formula.json`

提效倍数(boost)公式参数。看板「业务配置」Tab 可编辑。

**v1.0.0-rc.22 起公式精简版**:把 boost 分母从「墙钟 × Bug惩罚 × Token惩罚」三因子收敛为「加权耗时 + 可选 Token 软上限」两因子,移除业务上不易解释的时薪 / token 单价配置;Bug 数从公式中剥离,仅作为关联信息展示。

```ts
interface FormulaSettings {
  /**
   * AI 工作时间权重 ∈ [0, 1],墙钟时间权重 = 1 - wThink。默认 0.7 偏向 AI 实参时间。
   * 并行多任务时墙钟会膨胀,把权重往 AI 工作时间推可以削减误差。
   */
  wThink: number
  /** 是否启用 token 软上限惩罚。关闭(默认)时 boost 公式只看时间。 */
  tokenPenaltyEnabled: boolean
  /** token 软上限(单位 k tokens),仅在 enabled 且 > 0 时生效。默认 200(=200k tokens)。 */
  tokenSoftCapK: number
}
```

**boost 公式**(实现见 `@ai-productivity-tracker/core metrics.ts`):

```
thinkMinutes      = totalThinkSeconds / 60
effectiveMinutes  = (1 - wThink) × latestElapsedMinutes + wThink × thinkMinutes

tokenPenalty      = (tokenPenaltyEnabled && tokenSoftCapK > 0)
                    ? 1 + max(0, latestCumulativeToken/1000 - tokenSoftCapK) / tokenSoftCapK
                    : 1

boost             = manualEstimateMinutes / (effectiveMinutes × tokenPenalty)
```

**老字段兼容**:`v1.0.0-rc.21` 及之前的 `kBug` / `kToken` / `tokenPriceUsdPer1k` / `hourlyCostUsd` 字段在 `readFormula` 中被静默丢弃,无需手工迁移;`writeFormula` 下次保存会覆盖成新 schema。

---

## 11. `data/jira.json`

Jira 凭证。Bug 数刷新 / sync-jira-title 用。

```ts
interface JiraStoredConfig {
  baseUrl: string // 'https://xxx.atlassian.net'(自动补 https://,去尾 /)
  apiEmail: string
  apiToken: string // 存明文(本机文件,与 runtime.json 同等敏感性)
  bugJqlTemplate: string // 'issuetype = Bug AND fixVersion = "{jiraKey}"' 等
}
```

---

## 12. `data/index.json`

全部 jiraKey 索引(看板列表用)。每次 saveRequirement / updateRequirement 时同步更新。

```ts
interface IndexFile {
  schemaVersion: number
  requirements: Record<string, IndexEntry>
}

interface IndexEntry {
  jiraKey: string
  title: string
  status: string
  owner: string
  projectSlug: string
  startedAt: string
  updatedAt: string
  iterationCount: number
  latestIterationAt: string | null
  // 不冗余字段(boost / linkedBugCount 等):看板渲染时按需 loadRequirement
}
```

---

## 13. 文件并发安全

| 文件                                                                                                 | 写入策略                                                  |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `runtime.json` / `config.json` / `bindings.json` / `requirement.json` / `formula.json` / `jira.json` | tmp + rename atomic                                       |
| `iterations.jsonl` / `subtask-events.jsonl`                                                          | append-only,O_APPEND 单次 write 原子                      |
| `lessons/lsn-*.json` / `INDEX.json`                                                                  | tmp + rename;writeLessons 内部维护批内 mergePool 避免重复 |
| `hook-state/*.recent-attach.json`                                                                    | tmp + rename;同 jiraKey 多次调用以最后一次为准            |

daemon 单实例锁通过 `runtime.json + isPidAlive` 保证(详见 [ARCHITECTURE.md §5](./ARCHITECTURE.md))。

---

## 14. 历史兼容

字段语义全部继承自 `instant-web-tools` 源仓库 `specs/modules/ai-productivity-tracker/spec.md` v2.18.0。
迁移到独立项目后**零 schema 变化**,从 `~/.truesight-local-agent/ai-productivity/` cp 到
`~/.ai-productivity-tracker/data/` 后直接可读。
