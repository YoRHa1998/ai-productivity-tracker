## Why

「AI 整体用量」(`add-ai-usage-overview`)以 **AI 工具 × 自然日**为维度做无差别聚合,适合回答「今天烧了多少 token」,但**无法做受控对比实验**:用户想验证「某个 skill / prompt / 规则优化到底省了多少 token」时,需要的是一段**人为圈定的时间窗**内的精确用量——优化前测一段、调整后再测一段、并排比对。自然日聚合既混入无关会话,也无法按需起停。

新增一个与「整体用量」「需求维度」都正交的「用量测算」模块:像**秒表**一样手动「开始记录 → 正常使用 AI → 结束记录」,圈定一段窗口内选定 AI 工具的 token 用量,落盘成可命名、可查看、可对比的测算记录,供 A/B 验证提效效果。

## What Changes

- **新增侧边栏菜单「用量测算」**:独立页面,顶部是秒表式控制区,下方是历史测算记录列表与对比视图。
- **开始记录可多选 AI 工具**:勾选 Cursor / Claude Code / Codex(可多选,例如同时记录 cursor + codex),可填写一句话标签(如「优化前」),点击「开始记录」启动一个**测算会话**(active session)。
- **秒表式起停**:记录进行中实时显示已用时长与各工具的滚动 token / 对话次数;点「结束记录」定格这段窗口,落盘成一条历史记录;支持「取消」丢弃当前进行中的会话。
- **采集旁路复用 `recordUsage` 汇聚点**:测算会话开启时,把流经 `recordUsage` 的归一化用量事件按「选定工具集」累加进当前 active 会话,**独立于「整体用量」全局监控开关**——即便全局监控关闭,只要有进行中的测算会话也照常采集(整体用量 `ai-usage.json` 的写入语义保持不变)。
- **记录本地存储 + 查看 + 对比**:测算记录落盘到本机单文件,看板可列表查看每条记录的标签 / 时间窗 / 时长 / 各工具 token 细分与合计;可选中多条做并排对比(表格 + 柱状图),可删除记录。
- **新增 HTTP 端点**:看板通过同源 API 启动 / 结束 / 取消 / 查询 / 删除测算会话,归入 panel-origin 放行。
- 界面沿用现有设计 token / glass 卡片体系,与「AI 用量」「需求看板」「复盘经验」风格一致。

## Capabilities

### New Capabilities

- `usage-benchmark`: 秒表式「用量测算会话」能力——多选 AI 工具的窗口化 token 采集(开始/结束/取消)、独立于整体用量开关的 `recordUsage` 旁路累加、测算记录的本地存储与查询/删除、看板「用量测算」页面(秒表控制 + 历史列表 + 对比视图),以及承载这些操作的 HTTP 端点。

### Modified Capabilities

<!-- openspec/specs/ 当前为空,无既有 spec 能力的需求变更。本变更复用 `recordUsage` 汇聚点但不改其「整体用量」聚合语义(纯旁路新增);仅把三处采集调用点的「是否调用 recordUsage」闸门由「整体用量开关开启」放宽为「整体用量开关开启 或 有进行中的测算会话」,行为向后兼容。 -->

## Impact

- **`packages/core`**:新增测算会话 store(`usage-benchmark.json`:active 会话 + 已完成记录列表,只存结构化元数据,tmp+rename 原子写);新增 `startBenchmark` / `accumulateBenchmark` / `stopBenchmark` / `cancelBenchmark` / `readBenchmark` / `deleteBenchmark` 与进程内 active 缓存;在 `recordUsage` 内部 tee 一次 `accumulateBenchmark(event)`(按 active.sources 过滤);把 `transcript-watcher.ts` / `codex-watcher.ts` 的 `isAiUsageEnabled()` 采集闸门替换为 `isUsageCaptureActive()`(= 整体用量开启 或 有 active 测算会话)。
- **`packages/server`**:`routes/ai-productivity.ts` 把 Cursor 旁路的 `isAiUsageEnabled()` 闸门替换为 `isUsageCaptureActive()`;新增 `usage-benchmark` 的启动/结束/取消/查询/删除处理器;在 `http/server.ts` 注册路由并加入 `isAiProductivityPanelPath` 放行集合。
- **`packages/ui`**:`router.ts` 新增「用量测算」菜单项与路由;新增 `tabs/UsageBenchmarkTab.vue`(秒表控制 + 进行中实时态 + 历史记录列表 + 对比柱状图);`api.ts` 新增类型与客户端方法。
- **数据兼容**:纯新增文件/端点;`usage-benchmark.json` 惰性创建;`ai-usage.json` 写入语义不变;不改 5 个 MCP tool 与既有 HTTP 端点契约;不动高危的 hook-core 客户端;无 BREAKING。
- **依赖**:建立在 `add-ai-usage-overview` 的 `recordUsage` / `AiUsageEvent` 基础设施之上(已落地)。
