## 1. Core:会话维度查询支持 keys 过滤

- [x] 1.1 `session-usage-store.ts`:`QuerySessionsParams` 新增可选 `keys?: string[]`(每项 `${source}:${sessionId}`)
- [x] 1.2 `querySessions`:在排序/截断之前按 `keys` 集合过滤(命中即留,集合内不存在的 key 安全忽略);`keys` 空/缺省不过滤
- [x] 1.3 `session-usage-store.spec.ts`:补 keys 命中、混合来源、空/缺省向后兼容、不存在 key 忽略的用例

## 2. Server:端点解析 keys 参数

- [x] 2.1 `ai-productivity.ts` `handleSessionUsageQuery`:解析 `keys` query 参数(逗号分隔或重复参数),透传给 `querySessions`
- [x] 2.2 `server.ts`:确认 `/ai-productivity/session-usage` 透传新参数且仍在 panel-origin 放行集合
- [x] 2.3 `ai-productivity.spec.ts`:补端点带 keys 的查询用例与缺省向后兼容用例

## 3. UI:抽取可复用会话行组件

- [x] 3.1 新增 `packages/ui/src/components/SessionUsageRow.vue`,从 `AiUsageTab.vue:550-604` 抽出会话行渲染(标题、工具·model、项目·分支、时间窗、轮次、`UsageBar`),入参 `session: SessionUsageView` + `maxTotal`,jiraKey 下钻经事件透出
- [x] 3.2 抽出共享展示 helper(`sessionLabel` / `formatDuration` / 时间窗格式化)到组件或共用 util
- [x] 3.3 `AiUsageTab.vue` 改用该组件,确认会话明细展示与原行为等价

## 4. UI:api 层支持 keys

- [x] 4.1 `api.ts`:`FetchSessionUsageParams` 新增可选 `keys?: string[]`,`fetchSessionUsage` 序列化到 query

## 5. UI:测算记录详情面板

- [x] 5.1 `UsageBenchmarkTab.vue`:历史记录卡片主体可点击打开详情;「对比」复选框 `@click.stop` 防冒泡
- [x] 5.2 新增记录详情 `ElDrawer`(对齐 workspace 模式),头部展示记录标签/时间窗/时长/各来源与合计 token
- [x] 5.3 打开详情时,从记录 `totals[source].sessionIds` 汇总成 `${source}:${sessionId}` keys,调 `fetchSessionUsage({ keys, limit: 1000 })` 反查
- [x] 5.4 详情正文用 `SessionUsageRow` 按 total 倒序渲染可解析会话;计算 `maxTotal` 归一化用量条
- [x] 5.5 增加「会话累计口径」说明文案;统计不可解析 sessionId 数并提示 N 个无明细会话;全不可解析时空态
- [x] 5.6 关闭详情恢复列表原筛选/对比状态

## 6. 回归与校验

- [x] 6.1 UI 交互/快照回归(会话行抽取等价、卡片点击 vs 对比勾选互不干扰)
- [x] 6.2 跑 `pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`
- [x] 6.3 `openspec validate usage-benchmark-record-detail` 通过
