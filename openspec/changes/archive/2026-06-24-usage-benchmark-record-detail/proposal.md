## Why

「用量测算」记录目前只在历史列表里展示各工具的 token 合计,用户无法看清一条记录窗口内究竟是哪几个会话在烧 token、各自烧了多少。而「AI 用量」的「会话用量明细」已经把单会话维度做得很完善。把后者复用进测算记录详情,能让用户在一次 A/B 测算后直接下钻到会话级别归因,定位是哪个会话/对话导致用量偏高。

## What Changes

- 「用量测算」历史记录卡片新增可点击下钻:点击一条已结束的记录,打开记录详情面板(`ElDrawer`,沿用 workspace tab 既有模式)。
- 记录详情面板复用「会话用量明细」的会话行渲染,展示该记录窗口内涉及的各会话的实际消耗(标题 / 工具·model / 项目·分支 / 时间窗 / 轮次 / token 用量条)。
- 详情面板的会话集合由记录已落盘的「各来源去重 sessionId 列表」(`totals[source].sessionIds`)精确解析,通过会话维度 store 反查得到每个会话的明细。
- 会话维度查询端点 `GET /ai-productivity/session-usage` 与 `querySessions` 新增可选「按会话 key 集合」过滤参数(`${source}:${sessionId}`),供详情面板精确按记录内的 sessionId 反查,不依赖时间窗近似。
- 详情面板明确标注会话用量为「会话累计」口径(可能与测算窗口内的合计不一致),并对无法解析(采集开关曾关闭 / 已被保留上限裁剪)的 sessionId 做空态/计数提示,不报错。
- 抽取「会话用量明细」的会话行为可复用组件,供「AI 用量」页面与本详情面板共用。

## Capabilities

### New Capabilities

- `usage-benchmark-record-detail`: 点击已结束的测算记录打开记录详情,按记录落盘的 sessionId 集合反查并展示窗口内各会话的实际消耗,处理会话用量口径说明与不可解析 sessionId 的兜底。

### Modified Capabilities

- `session-token-usage`: 扩展「会话用量查询端点」与 `querySessions`,新增可选的「按会话 key 集合(`source:sessionId`)」精确过滤参数,使按指定会话集合反查不受 top-N 截断影响。

## Impact

- UI:`packages/ui/src/tabs/UsageBenchmarkTab.vue`(记录卡片可点击 + 详情 Drawer)、`packages/ui/src/tabs/AiUsageTab.vue`(抽取会话行组件后改用)、新增共享会话行组件(如 `packages/ui/src/components/SessionUsageRow.vue`)、`packages/ui/src/api.ts`(`fetchSessionUsage` 入参新增 keys)。
- Server:`packages/server/src/routes/ai-productivity.ts`(`handleSessionUsageQuery` 解析 keys 参数)、`packages/server/src/http/server.ts`(透传新查询参数)。
- Core:`packages/core/src/store/session-usage-store.ts`(`QuerySessionsParams` 新增 keys、`querySessions` 过滤)。
- 测试:对应 store / route / UI 的 spec 增量。无数据迁移,无对外协议破坏(新增参数均为可选,向后兼容)。
