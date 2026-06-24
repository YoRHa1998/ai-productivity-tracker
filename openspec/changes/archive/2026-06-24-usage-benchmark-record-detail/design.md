## Context

「用量测算」(`UsageBenchmarkTab.vue` + `usage-benchmark-store.ts`)是秒表式的窗口化 token 计量:开始记录后,窗口内流经 `recordUsage` 的归一化用量事件被旁路累加进当前测算会话,结束时定格为一条历史记录。每条已结束记录 `UsageBenchmarkSession` 的 `totals[source]` 同时保存了窗口内去重的 `sessionIds: string[]`(`usage-benchmark-store.ts:37`,在 `accumulateBenchmark` `:281-283` 写入)与时间窗 `startedAt`/`endedAt`。

「AI 用量」的「会话用量明细」由会话维度 store(`session-usage-store.ts`,落盘 `session-usage.json`,key 为 `${source}:${sessionId}`)支撑,`querySessions` 提供 from/to/source/project/sort/dir/limit 查询,前端 `AiUsageTab.vue` 渲染会话行(标题、工具·model、项目·分支、时间窗、轮次、`UsageBar`)。

两侧共享同一个 `AiUsageEvent.sessionId`,因此一条测算记录的 sessionId 集合可直接映射成会话维度 key 反查 —— 这是本次集成的连接点。

## Goals / Non-Goals

**Goals:**

- 点击已结束的测算记录打开详情面板,复用「会话用量明细」的会话行,展示窗口内各会话实际消耗。
- 用记录已落盘的 `sessionIds`(Path A,精确)而非时间窗近似(Path B)来确定会话集合。
- 把会话行抽成可复用组件,「AI 用量」与详情面板共用,避免渲染逻辑分叉。
- 对不可解析 sessionId 与口径差异做明确兜底与说明,绝不报错。

**Non-Goals:**

- 不存储/计算「每会话的窗口内 token」。测算记录只保留 sessionId 列表,不保留 per-session 窗口分摊,本期不引入该数据。
- 不改动测算的采集/累加/起停/对比/删除既有行为。
- 不改 `session-usage` 的保留上限治理与采集口径。

## Decisions

### D1:用 Path A(记录落盘的 sessionIds)反查,而非时间窗

记录已落盘 `totals[source].sessionIds`,直接拼成 `${source}:${sessionId}` 反查会话维度 store,精确且与采集口径无关。

- 备选(Path B)`from=startedAt&to=endedAt` 按时间窗查会话:会把窗口外恰好活跃的无关会话也带进来(`firstAt/lastAt` 与窗口相交即命中),噪声更大。故选 Path A。

### D2:为 `session-usage` 端点新增可选 `keys` 过滤,而非前端拉全量再过滤

`querySessions` 默认按 total 倒序 + limit 截断,若前端拉「全量」再按 sessionId 集合过滤,既受 limit 影响又浪费传输。改为在 `QuerySessionsParams` 新增 `keys?: string[]`,在排序/截断之前施加集合过滤;route(`handleSessionUsageQuery`)解析 `keys` query 参数(逗号分隔或重复参数)。参数可选,缺省完全向后兼容。

### D3:详情会话用量采用「会话累计」口径并显式标注

会话维度 `total` 是会话生命周期(firstAt→lastAt)累计,而测算记录的 per-source 合计是窗口内值。per-session 窗口值未存储,本期不补。故详情直接展示会话累计口径并加一行说明,避免用户误读两个数字的差异。

- 备选:补存 per-session 窗口 token —— 需改测算累加 store 的数据结构与落盘 schema,成本与风险偏高,本期排除(见 Open Questions)。

### D4:抽取共享会话行组件

把 `AiUsageTab.vue:550-604` 的会话行(及 `sessionLabel`/`formatDuration`/时间窗格式化等纯展示 helper)抽到 `packages/ui/src/components/SessionUsageRow.vue`(或 `SessionUsageList.vue`),入参为 `SessionUsageView` + 归一化所需的 `maxTotal`。`AiUsageTab` 与详情面板都消费它,jiraKey 下钻通过事件回调透出,保持两处行为一致。

### D5:详情面板用 `ElDrawer`,对齐 workspace 既有模式

复用 `AiProductivityTrackerWorkspaceTab.vue` 的 Drawer 详情交互(`drawerOpen` ref + `ElDrawer`)。记录卡片主体可点击打开;「对比」复选框点击 `@click.stop` 防冒泡,避免与下钻冲突。

## Risks / Trade-offs

- [采集开关口径差错] 测算累加在全局开关之外,会话维度只在开关开启时写盘 → 记录可能持有无对应会话明细的 sessionId。→ 详情按可解析子集展示 + 计数提示 N 个无明细会话 + 全不可解析时空态。
- [保留上限裁剪] `session-usage` 30 天 / 1000 条裁剪后,旧记录的 sessionId 反查不到。→ 与上同一套兜底覆盖,不报错。
- [口径误读] 会话累计 ≠ 窗口合计。→ D3 显式文案标注。
- [组件抽取回归] 抽取会话行可能影响 AI 用量页既有展示。→ 保持入参/渲染等价,补 UI spec/快照回归,改后跑 `pnpm test && pnpm lint && pnpm typecheck`。

## Open Questions

- 是否在后续版本为测算补存「per-session 窗口内 token」以提供窗口口径的精确归因?(本期 Non-Goal,先用会话累计口径 + 说明文案。)
- 详情面板是否需要把「无明细会话」的裸 sessionId 也列出(仅 ID,无 token)?当前决定仅计数提示,如用户需要可后续增强。
