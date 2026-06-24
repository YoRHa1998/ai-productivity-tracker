## Why

「会话维度用量」(`add-session-token-usage`)已上线,但真实使用暴露 4 个体验问题:(1) 会话标题直接展示了 IDE 注入的包裹标签(`<timestamp>` / `<user_query>` 等),用户看到的是一堆标签而非真实输入内容;(2) 用量条配色按「相对当前列表最大值」分档,单条或数值相近时会整列泛红,无法一眼判断「这个会话到底烧了多少」绝对量级;(3) 用量条长度也按相对最大值归一化,表达不出「每个会话各占总消耗多大比例」;(4) 会话记录未携带所属项目与分支,无法支撑后续按项目 / 分支分类与排序。

## What Changes

- **会话标题去噪**:在标题采集 / 展示口径上剥离 IDE 注入的包裹标签(`<timestamp>` / `<user_query>` / `<cursor_commands>` / `<system_reminder>` 等),优先提取 `<user_query>` 正文,只展示用户真实输入;对已落盘的「脏标题」在展示层做兜底清洗(无需数据迁移)。
- **用量条配色改绝对阈值(会话列表)**:会话 `total` ≥ **300K** 显示红、**150K–300K** 显示橙、< **150K** 显示绿;阈值为模块常量、可被 props 覆盖。共享 `UsageBar` 新增配色模式(`ratio` 既有 / `absolute` 新增),会话列表用 `absolute`。
- **用量条长度改「占列表总和比例」(会话列表)**:`width% = value / Σ(当前列表各会话 total)`;只有 1 条时占满 100%,3 条按 5:3:2 → 50% / 30% / 20%,以此类推。`UsageBar` 条长归一化分母由父列表传入,会话列表传「列表总和」。
- **记录会话所属项目 + 分支**:`AiUsageEvent` 新增可选 `projectName?` / `branch?`,三条采集链路 best-effort 填入;`session-usage` store 持久化并经查询端点 / 视图透传;会话行轻量展示项目 / 分支,为后续按项目 / 分支分类与排序预留数据基础。
- **不改「用量测算」页既有展示行为**:共享 `UsageBar` 默认模式(相对归一化 + `ratio` 配色)保持不变,`UsageBenchmarkTab` 行为零回归。

## Capabilities

### New Capabilities

- `session-usage-list-display`: 会话维度用量「列表展示」的优化能力,覆盖会话标题去标签清洗(展示真实输入内容)、用量条绝对阈值三档配色(300K/150K)、用量条按列表总和占比的条长归一化,以及会话所属项目 / 分支的采集、持久化与透传(为后续分类排序预留)。

### Modified Capabilities

<!-- openspec/specs/ 当前为空(既有 add-session-token-usage 等 change 尚未 archive),无可被 MODIFIED 引用的主线 spec。本变更以新能力 session-usage-list-display 承载,精化 add-session-token-usage 中「会话标题展示」与「用量指示条」两处展示口径(标题:原始首条输入→去标签内容;会话列表条长:相对最大值→占总和比例;会话列表配色:相对比值→绝对阈值),并保持「用量测算」页共享组件默认行为不变。 -->

## Impact

- **`packages/core`**:
  - 新增标题去标签清洗(`sanitizeTitle` 或并入 `truncateTitle` 口径):优先提取 `<user_query>` 正文,剥离已知包裹标签块与残留尖括号标记;采集点写入与展示层(`recordToView`)双侧兜底,清洗历史脏标题。
  - `AiUsageEvent` 新增可选 `projectName?` / `branch?`(daily 日聚合不消费,向后兼容)。
  - `session-usage-store`:`SessionUsageRecord` / `SessionUsageView` 增 `projectName?` / `branch?`,`accumulateSessionUsage` best-effort 富化(非空覆盖)。
- **采集点**:`transcript-watcher` / `codex-watcher` 已持有 `gitRoot` / `branch` / `issueKey`,填 `branch` + `projectName`(`readProjectNameFromPackageJson(gitRoot)`);`buildCursorUsageEvent` 由 `body.branch` 填 `branch`,best-effort 填 `projectName`。
- **`packages/server`**:`querySessions` 视图透传 `projectName` / `branch`(端点契约纯新增字段,放行集合不变)。
- **`packages/ui`**:
  - `UsageBar.vue` + `usage-bar-logic.ts`:新增 `colorMode`(`ratio` 默认 / `absolute`)与绝对阈值配色函数;条长分母语义不变(仍 `value / max`,由父列表决定传最大值或总和)。
  - `AiUsageTab.vue` 会话列表:`max` 改传「列表总和」、配色用 `absolute`(300K/150K)、标题渲染走清洗口径、meta 行展示项目 / 分支。
- **数据兼容**:纯新增可选字段;旧会话记录无 `projectName` / `branch` 安全留空;`ai-usage.json` 与 daily 聚合零改动;`UsageBenchmarkTab` 行为不变;不改 5 个 MCP tool 与既有端点对外契约;无 BREAKING。
- **依赖**:建立在已落地的 `add-session-token-usage`(`recordUsage` 漏斗 / `session-usage-store` / `UsageBar`)之上。
