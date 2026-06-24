## Context

现状(详见 `AGENTS.md` / `openspec/changes/add-ai-usage-overview/`):

- 三条采集链路(Claude `TranscriptWatcher` flushTurn、Codex `CodexWatcher` flushTurn、Cursor daemon `handleAiProductivityHook`)各自把原生数据归一化成 `AiUsageEvent`,再调用**唯一汇聚点** `recordUsage(event)`(`packages/core/src/store/ai-usage-store.ts:263`)。
- `AiUsageEvent` 已携带 `{ source, sessionId, turnId?, model?, provider?, tokens:{input,output,cacheRead,cacheCreation,total}, toolCalls?, at }`,**仅结构化元数据,无对话正文**。
- `recordUsage` 现在做两件事:(1) `accumulateBenchmark(event)` —— 用量测算旁路,在 `enabled` 守卫之外;(2) `enabled` 时按 `AI 工具 × 自然日`累加进 `ai-usage.json` 的 `daily[source][date]` bucket。**会话维度目前只在 bucket 里留了一个去重的 `sessionIds[]` 列表**(只能数「当天几个会话」),没有逐会话 token 累加。
- 需求绑定(`jiraKey`)落在各业务仓库 `.aip/bindings.json`(`BindingEntry`),与全局 `ai-usage.json` 物理分离;`recordUsage` 调用点之一(watcher / cursor hook)在记录用量时**本就解析过 issueKey**(用量旁路插在 issueKey 闸门之前)。
- 落盘根 `~/.ai-productivity-tracker/data/`,路径常量在 `store/paths.ts`,全局单文件直接落 data 根;写盘用 tmp+rename 原子写;`enabled` 有进程内缓存零盘 I/O 短路。
- 看板:Vue3 + vue-router(hash);echarts 按需注册;API 客户端 `api.ts`;glass/token 设计体系;已有同构页面 `tabs/AiUsageTab.vue` 可直接扩展。

**核心机会**:`recordUsage` 是所有用量事件唯一漏斗,`AiUsageEvent` 已含 `sessionId` + token 细分。新增会话维度 = 在漏斗内多累加一份「按 sessionId 聚合」,零新增解析、零额外文件 watch。

## Goals / Non-Goals

**Goals:**

- 以**单个会话**为维度持久化 token 用量:每个会话累加 token 细分 / 对话轮次 / 工具调用次数,记录 source、model(best-effort)、首末活跃时间(时间窗)。
- 看板能按 token **倒序**展示「最烧 token 的会话 Top N」,让用户定位「哪个会话 / 哪次任务」。
- **用人类可读的会话标题标识会话**:以 best-effort 抓取的首条用户输入(截断)作为标题,效果接近各 IDE/CLI 列表里的会话标题,覆盖非 Jira / 跨工具会话;`jiraKey` 为可选附加标签(命中时附带可下钻)。
- 复用 `recordUsage` 漏斗、`AiUsageEvent`、既有采集闸门;**纯旁路新增,不改既有按日聚合语义、不改 `ai-usage.json` 既有字段写入、不动 hook-core 客户端**。
- 会话维度数据有**保留上限治理**,避免单文件无限膨胀。

**Non-Goals:**

- 不做 token 成本(USD)计费。
- v1 不做单会话内的逐轮时间序列明细(只到会话级累加 + 时间窗);不做按会话导出报告。
- 不入库对话正文 / 工具参数 / 模型输入输出大字段;不引入跨设备同步。
- 不改 5 个 MCP tool 与既有 HTTP 端点对外契约。
- 会话维度受「整体用量」全局开关管辖(它是整体用量的细化视图),**不**像「用量测算」那样在全局关闭时仍采集。

## Decisions

### D1:独立 store `session-usage.json`,而非塞进 `ai-usage.json`

新增 `packages/core/src/store/session-usage-store.ts`,落盘 `~/.ai-productivity-tracker/data/session-usage.json`,schema(version=1):

```jsonc
{
  "version": 1,
  "sessions": {
    // key = `${source}:${sessionId}`(sessionId 跨工具可能撞,加 source 前缀消歧)
    "cursor:conv-abc123": {
      "source": "cursor",
      "sessionId": "conv-abc123",
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheCreation": 0,
      "total": 0, // 有效用量 = input+output+cacheCreation(剔除 cacheRead),与 AiUsageTokens 同口径
      "turns": 0,
      "toolCalls": 0,
      "model": "claude-...", // best-effort,最近一次非空 model
      "title": "Token consumption by session", // best-effort,首条用户输入截断(D3),作会话标识
      "jiraKey": "INSTANT-1234", // best-effort,可选附加标签;采集点解析到则填,可下钻需求详情
      "firstAt": "2026-06-24T01:00:00.000Z",
      "lastAt": "2026-06-24T02:30:00.000Z"
    }
  }
}
```

- **为何独立文件**:`ai-usage.json` 设计上是「数量级很小的按日聚合」(查询 O(1)、整文件读写);会话数随时间**无界增长**,塞进去会让 `ai-usage.json` 体积失控、且把保留裁剪逻辑耦合进日聚合。独立文件让会话累加 / 富化 / 裁剪自洽,且回滚时删文件无害。
- token 细分口径与 `AiUsageTokens` 完全一致;key 加 `source:` 前缀消歧。
- 函数式 API:`readSessionUsage()` / `accumulateSessionUsage(event)` / `pruneSessions(file)` / `querySessions({from?, to?, source?, limit?, sort?})`,沿用 tmp+rename。
- **受全局开关管辖**:`accumulateSessionUsage` 在 `recordUsage` 的 `isAiUsageEnabled()` 守卫**之内**调用(与 daily 聚合同生命周期),不进入 benchmark 那种「全局关也采」的旁路。

### D2:在 `recordUsage` 的 enabled 分支内 tee 会话累加

```text
recordUsage(event):
  accumulateBenchmark(event)            # 既有:测算旁路,enabled 之外
  if not isAiUsageEnabled(): return     # 既有守卫
  <现有 daily[source][date] 累加 + 写 ai-usage.json>   # 语义不变
  accumulateSessionUsage(event)         # 新增:按 sessionId 累加 + 写 session-usage.json
```

- `accumulateSessionUsage`:无 `sessionId` 直接返回(不可归属的事件不入会话维度);命中则按 key 累加 token 细分 + `turns+1` + `toolCalls +=` + 刷新 `lastAt` / 首见设 `firstAt` + 非空 `model` 覆盖 + 非空 `jiraKey` 覆盖 + `title` **仅首次写入后不覆盖**(首条用户输入即标题,后续轮不应改写)。
- **幂等继承上游**:与 daily 聚合共用同一调用点,watcher offset state / cursor hook dedupeKey 已防重,会话累加直接受益,无需自建去重。
- **替代方案(否决)**:在查询时实时扫各需求 iteration 反推会话用量 —— 数据分散在各仓库 `.aip`,且非 Jira / 非仓库会话根本没有 iteration,覆盖不全且昂贵。漏斗单点累加是唯一覆盖全场景的接入。

### D0:会话标题取「首条用户输入」,不取各工具私有标题(可行性裁决)

调研三条数据源后裁定:**各 IDE/CLI 列表里展示的会话标题(如 Cursor「Token consumption by session」、Claude「打招呼」)在我们 tail 的原始数据流里拿不到**:

- **Cursor**:hook payload 实测字段(`HookInput`)仅 `conversation_id` / `generation_id` / `text`(回复正文)/ `transcript_path` / `model` / tokens 等,**无 title**。侧边栏标题由 Cursor 存进内部 `state.vscdb`,不经 hook 暴露。
- **Claude Code**:transcript jsonl 的 `type:summary` 标题行仅在「会话压缩/恢复」时才写,短会话不产生(本机全量扫描 0 命中),不可靠。
- **Codex**:rollout jsonl 无标题字段,`session_meta` 仅 session_id/cwd/model;`reasoning.summary` 是空数组,非会话标题。

逆向各工具私有 DB / 索引可拿到原生标题,但**脆弱且随工具版本漂移**,违背「不依赖第三方工具内部实现」原则,否决。

**采纳替代**:用**首条用户输入**作会话标题——三家可靠可得,且这正是各工具生成原生标题所用的素材,语义最接近。

### D3:会话标题 best-effort 采集,沿事件携带 `title`(+ 可选 `jiraKey`)

给 `AiUsageEvent` 增可选字段 `title?: string` 与 `jiraKey?: string`,各采集点在**会话首条用户输入**处 best-effort 填入:

- **Claude**(`transcript-watcher`):已有 `parseClaudeUserMessage` 解析 `type:user` 行,在 PendingTurn 首见 user 行时捕获其文本,截断后作 `title`。
- **Codex**(`codex-watcher`):已识别 `user_message` 轮边界,取会话首个 `user_message` 文本截断作 `title`。
- **Cursor**(daemon hook 路径):afterAgentResponse 不直接带 prompt,best-effort 读 `transcript_path` 取首条 user 行文本;读不到则 `title` 留空。
- `jiraKey`:采集点本就解析过 issueKey(用量旁路插在 issueKey 闸门之前),命中则顺手填入作可选附加标签;main / 非仓库会话留空。
- **截断**:`title` 在采集点截断到 `TITLE_MAX_LEN`(默认 **80** 字符,去首尾空白 / 折行压一行),只取片段不存全文。
- 会话展示标识优先级:`title` 非空 → 展示 `title`(jiraKey 非空时附一枚可点击需求徽标);否则 `jiraKey` → 展示 jiraKey;再否则 → 短会话 ID + 工具 + 时间窗。
- **为何在采集点带、而非查询时反查**:首条用户输入随事件流式到达,查询侧没有 `sessionId → title/jiraKey` 的全局索引;采集点是唯一同时握有 token 与首条输入的位置。
- `title` 在 store 侧**只首次写入、后续不覆盖**(D2),保证标题恒为「会话第一句」。

### D4:保留上限治理(prune on write)

会话无界增长,需裁剪。每次 `accumulateSessionUsage` 写盘前跑一次 `pruneSessions`:

- 按 `lastAt` 早于 `retentionDays`(默认 **30 天**)的会话整条删除;
- 再按 `lastAt` 倒序截断到 `maxSessions`(默认 **1000** 条)上限。
- 阈值定义为模块常量(v1 不暴露配置项),后续如需可挂到 `ai-usage.json` config。
- 量级评估:典型每天数十会话,30 天 / 1000 条上限下文件 KB~低 MB 级,整文件读写可接受。

### D5:HTTP 查询端点(panel-origin 放行)

沿用既有 `/ai-productivity/*` 风格,集中在 `routes/ai-productivity.ts` + `http/server.ts`:

- `GET /ai-productivity/session-usage` query:`from?`(ISO/日期)、`to?`、`source?`(cursor|claude-code|codex)、`limit?`(默认 50)、`sort?`(默认 `total` 倒序,可 `lastAt`)。返回 `{ sessions: SessionUsageView[] }`,服务端已排序 / 截断(前端不二次大排序)。
- 加入 `isAiProductivityPanelPath` 放行集合(同源免 token)。
- 用查询参数而非路径参数,与既有「字面 pathname 匹配」风格一致。

### D6:看板「AI 用量」页面新增「会话 Top N」明细区

- 扩展 `tabs/AiUsageTab.vue`,在既有按日卡片 / 趋势图下方加一块 glass 卡片:
  - 顶部过滤:工具筛选(全部 / cursor / claude-code / codex)、时间范围(近 7 / 30 天)、排序(token / 最近活跃)。
  - 表格列:会话标题(`title`,jiraKey 非空时附可点击需求徽标 → 需求详情;title 空则回退短会话 ID + 时间窗)、工具、model、时间窗(`firstAt`–`lastAt`)、对话轮次、token 细分(input/output/cache)与合计;按合计倒序高亮 Top。
  - 空态引导「开启 AI 整体用量采集后,这里会按会话展示 token 明细」。
- `api.ts` 增类型 `SessionUsageView` 与 `fetchSessionUsage(params)`。
- 复用 `styles/tokens.css` / `glass.css` / echarts 主题。

### D6b:可复用「用量指示条 + 排序」展示模式(两页共用)

「列表 + 用量条(条长 + 绿/橙/红)+ 按用量排序」是「AI 用量」会话列表与「用量测算」记录列表共同诉求,抽成可复用组件,避免两处各写一遍、口径漂移。

- **新增 `packages/ui/src/components/UsageBar.vue`**:props `{ value: number; max: number; thresholds?: { warn: number; danger: number } }`,渲染一根水平条:
  - **条长归一化**:`width% = clamp(value / max, 0, 1) * 100`,`max` 由父列表传入(= 当前列表内最大用量),保证「最烧的那条满格、其余按比例」。`max<=0` 时全部 0 宽。
  - **颜色分档(相对当前列表最大值)**:`ratio = value / max`;`ratio ≥ danger`(默认 **0.66**)→ 红;`ratio ≥ warn`(默认 **0.33**)→ 橙;否则绿。阈值取自设计 token(见下),可被 props 覆盖。
  - 条上叠加紧凑数值(复用 `formatCompactTokens`)与无障碍 `aria-label`。
- **颜色取设计 token**:在 `styles/tokens.css` 新增 `--aipt-usage-low`(绿)/ `--aipt-usage-mid`(橙)/ `--aipt-usage-high`(红)三档,亮暗主题各给一套,UsageBar 只引用变量不写死色值。
- **为何相对归一化(而非绝对阈值)**:会话 token 跨度极大(几百到上百万),固定绝对阈值要么几乎全红要么全绿;相对当前列表最大值能自适应地把「这批里谁重谁轻」表达清楚。绝对阈值留作 props 覆盖的后路。
- **排序**:列表层维护 `sortDir`(`desc`/`asc`),默认按 token 合计 **desc**(最烧在前)。「AI 用量」会话列表的排序优先走服务端(D5 的 `sort`/`limit`,大数据量正确);「用量测算」记录数量很小,前端本地排序即可。两处都用同一套 UsageBar + 同一组排序控件样式。
- **接入点**:
  - `AiUsageTab.vue` 会话列表:每行嵌 `UsageBar`(value=会话 total,max=本页会话最大 total)。
  - `UsageBenchmarkTab.vue` 记录列表 / 对比区:每条嵌 `UsageBar`(value=记录 grandTotal,max=列表内最大 grandTotal)+ 加按用量排序控件(既有按 endedAt 倒序之外)。
- **替代方案(否决)**:直接用 `el-progress` —— 其分段着色 API 与「相对 max 归一化 + 三档阈值 + 设计 token 配色」契合度差、且难统一两页样式;自建轻组件更可控、零额外依赖。

### D7:隐私——结构化元数据 + 截断会话标题(有意放宽)

会话记录累加 `AiUsageEvent` 的结构化字段(source / sessionId / token 细分 / turns / toolCalls / model)与采集点解析出的 `jiraKey`。**相较既有「绝不入库对话正文」原则,本变更有意放宽一处**:落盘首条用户输入的**截断片段**(≤ `TITLE_MAX_LEN`)作 `title`,用于人类可读地标识会话。

- 边界:只存**首条**输入的截断片段,不存后续轮、不存 assistant 输出、不存工具参数 / 模型输入输出大字段。
- 管辖:`title` 随会话维度受「整体用量」全局开关管辖,开关关闭时不采不存。
- 取舍理由:用户明确要求用「会话总结标题」而非 Jira key 标识会话;首条输入是唯一可靠且语义贴近原生标题的素材,截断 + 仅片段是隐私与可用性的平衡点。
- 后续可叠加(超出 v1):标题脱敏 / 标题采集独立开关,见 Open Questions。

## Risks / Trade-offs

- [`session-usage.json` 无界增长] → D4 prune on write(retentionDays + maxSessions 双闸);`core` 测试覆盖「超阈值裁剪 + 保留最近」。
- [`recordUsage` 热路径多一次整文件读写] → 与既有 `ai-usage.json` 写盘同频(每事件一次),量级相当;若实测有压力,后续可加进程内 dirty 缓存批量 flush(v1 不做)。
- [会话跨午夜 / 跨工具] → 会话维度本就按 `sessionId` 跨日累加,`firstAt`/`lastAt` 表达真实时间窗,不受自然日切分影响;`source:` 前缀避免跨工具撞 ID。
- [Cursor 经 `transcript_path` 取首条输入可能失败致 `title` 空] → 接受:回退 jiraKey / 短 ID + 时间窗仍可定位;不阻断 token 累加。Claude/Codex 标题命中率高(直接解析已有结构)。
- [`title` 落盘对话片段的隐私暴露] → 截断 ≤ `TITLE_MAX_LEN`、仅首条、仅本机不上云、受全局开关管辖;D7 记录此有意放宽与后续脱敏/独立开关方向。
- [`AiUsageEvent` 增字段 `title?` / `jiraKey?`] → 均为可选字段,旧调用点不填即向后兼容;`ai-usage.json` daily 聚合不消费这两个字段,行为不变。
- [并发写] → 单 daemon 进程内串行触发 + tmp+rename + 单实例锁,无跨进程并发。
- [增强已落地的 `UsageBenchmarkTab.vue`(属 `add-token-usage-benchmark`)] → 仅前端展示层增强(嵌 UsageBar + 排序控件),不改其 store / 端点 / 数据契约;视觉风险低,纳入本变更的 UI 回归。
- [相对归一化:列表内只有 1 条或数值相近时全红] → 接受:单条时它本就是最大值,满格红表达「当前最大」语义自洽;需要绝对语义时由 props 传固定阈值。

## Migration Plan

- 纯新增:新 store 文件、新端点、`AiUsageEvent` 可选字段(`title?` / `jiraKey?`)、各 watcher 首条输入捕获、`AiUsageTab` 新区块、共享 `UsageBar.vue` 组件 + 用量条配色 token;`session-usage.json` 惰性创建。`UsageBenchmarkTab` 为纯展示层增强。
- `ai-usage.json` schema 与写入语义零改动;daily bucket 既有 `sessionIds[]` 保留不动(数会话用),会话维度是新增的细化视图。
- 回滚:删新增端点 / UI 区块 / store + 撤回 `recordUsage` 内的 `accumulateSessionUsage` 调用;`session-usage.json` 残留无害。
- 发版:沿用 `pnpm release prerelease --publish` 叠 rc。

## Open Questions

- **会话标题是否需独立采集开关 / 脱敏**:v1 复用整体用量开关 + 截断;若用户对落盘对话片段敏感,后续可加「标题采集」独立开关或正则脱敏。
- 后续可叠加项(超出 v1):标题改用 AI 生成的一句话总结(命中需求上下文时复用 `conversationSummary`)、单会话内逐轮时间序列下钻、按会话维度的成本估算、retention 阈值暴露成 config。
