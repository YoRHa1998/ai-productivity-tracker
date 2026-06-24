## Why

「AI 整体用量」(`add-ai-usage-overview`)只按 **AI 工具 × 自然日**聚合 token,能回答「今天烧了多少 token」,却回答不了「**哪个会话 / 哪次任务**烧得最多」。当天往往有十几个会话混在一个数字里,用户无法定位「是哪一次长对话 / 哪个反复试错的任务把 token 拉高了」,也就无从针对性优化。

好消息是数据**已经够用**:三条采集链路归一化出的 `AiUsageEvent` 本就携带 `sessionId` + 完整 token 细分,`recordUsage` 是唯一漏斗;只是当前日聚合 bucket 仅保留了一个去重的 `sessionIds[]` 列表(只知道「有几个会话」),**没有按会话累加 token**。补一个「会话维度」聚合即可,无需新增任何解析或文件 watch。

## What Changes

- **新增「会话维度」用量聚合**:在 `recordUsage` 唯一漏斗内,除既有「AI 工具 × 日」聚合外,旁路再按 `sessionId` 累加 token 细分 / 对话轮次 / 工具调用次数,并记录会话的 source、model(best-effort)、首末活跃时间(时间窗)。
- **用「会话标题」标识每个会话**:以 best-effort 抓取的**首条用户输入(截断成短标题)**作为会话标签,效果接近各 IDE/CLI 列表里展示的会话标题,覆盖全场景(含非 Jira、跨工具会话)。`jiraKey` 降级为可选附加标签(命中需求上下文时附带,可点击下钻),不再作为主标识。无标题且无 jiraKey 时回退「短会话 ID + 工具 + 时间窗」。
- **会话用量查询端点**:看板通过同源 API 拉取会话列表(支持按时间范围 / 工具过滤、按 token 倒序),归入 panel-origin 放行。
- **看板「AI 用量」页面新增会话明细区**:在既有按日卡片 / 趋势图下方,新增「会话」列表——展示每个会话的标题/工具/model/时间窗/对话轮次/token 细分与合计,让用户一眼看到「哪个会话、哪次任务」最烧 token。
- **统一「用量指示条 + 排序」展示模式(两页共用)**:新增可复用的用量条组件——条长按 token 量归一化(相对当前列表最大值),颜色按高低分**绿 / 橙 / 红**三档;列表支持按用量**高→低 / 低→高**排序。该模式同时落到**【AI 用量】会话列表**与**【用量测算】记录(及对比)列表**,让用户直观对比每个会话/记录的消耗轻重。
- **保留上限治理**:会话维度数据会随时间无限增长,新增保留策略(按天数 / 条数滚动裁剪),避免单文件膨胀。
- 复用既有采集闸门(`isUsageCaptureActive`)、`AiUsageEvent` 与设计 token / glass 体系,**纯旁路新增,不改既有按日聚合语义与对外契约**。

## Capabilities

### New Capabilities

- `session-token-usage`: 以**单个会话**为维度的 token 用量采集、聚合、标题富化、查询与展示能力,包括 `recordUsage` 内的会话级旁路累加、以首条用户输入为素材的 best-effort 会话标题采集(jiraKey 为可选附加标签)、保留上限治理、会话用量查询 HTTP 端点,以及看板「AI 用量」页面的会话列表;并提供可复用的「用量指示条(条长归一化 + 绿/橙/红分级)+ 按用量排序」展示模式,同时应用于「AI 用量」会话列表与「用量测算」记录列表。

### Modified Capabilities

<!-- openspec/specs/ 当前为空,无既有 spec 能力的需求变更。本变更复用 add-ai-usage-overview 的 recordUsage 漏斗与 AiUsageEvent,纯旁路新增会话维度聚合,不改其「AI 工具 × 日」聚合语义、不改 ai-usage.json 既有字段写入行为。 -->

## Impact

- **`packages/core`**:新增会话维度 store(独立文件 `session-usage.json`,只存结构化元数据 + 截断后的会话标题,tmp+rename 原子写)与按 `sessionId` 的累加 / 标题富化 / 保留裁剪逻辑;在 `recordUsage` 内部 tee 一次会话级累加;扩展各 watcher 在首条用户输入处捕获标题素材(Claude `parseClaudeUserMessage` 已有、Codex `user_message` 边界已识别)。
- **`packages/server`**:`routes/ai-productivity.ts` 新增会话用量查询处理器;Cursor hook 路径 best-effort 经 `transcript_path` 取首条用户输入作标题;`http/server.ts` 注册路由并加入 `isAiProductivityPanelPath` 放行集合。
- **`packages/ui`**:新增可复用用量条组件 `components/UsageBar.vue`(条长归一化 + 绿/橙/红分级);`tabs/AiUsageTab.vue` 新增会话列表(用量条 + 排序 + 会话标题,jiraKey 可点下钻);**增强既有 `tabs/UsageBenchmarkTab.vue` 记录/对比列表复用同一用量条 + 排序**;`api.ts` 新增类型与客户端方法。
- **数据兼容**:纯新增维度;会话维度惰性创建;`ai-usage.json` 既有字段写入语义不变;不改 5 个 MCP tool 与既有 HTTP 端点契约;不动高危的 hook-core 客户端;无 BREAKING。
- **隐私**:会话标题来自首条用户输入截断片段(非完整正文),相较既有「仅结构化元数据」原则是一处**有意放宽**——见 design 隐私决策(截断长度上限 + 只存片段,受整体用量开关管辖)。
- **依赖**:建立在 `add-ai-usage-overview` 的 `recordUsage` / `AiUsageEvent` 基础设施之上(已落地)。
