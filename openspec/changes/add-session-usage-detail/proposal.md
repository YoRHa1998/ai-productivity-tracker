## Why

「会话用量明细」目前每行只给出会话标题、轮次数和**整会话**的 token 合计,无法回答「这个会话里到底是哪一轮最烧 token」。用户看到一条 881k token 的会话,却没有抓手定位贡献最大的那一轮。同时外层列表用「绝对阈值三档配色」既表达「长度占比」又表达「绝对量轻重」,两套语义叠在一条短条上反而难读;标题被截到 80 字符也丢失了排查所需的上下文。

## What Changes

- **新增会话详情弹窗**:点击「会话用量明细」中的任一会话行,打开详情弹窗,逐轮展示该会话每一轮对话的明细——名称(该轮用户输入)、时长、本轮 token 消耗、模型,并为每轮渲染一根「占本会话总量比例」的用量进度条。
- **持久化每轮明细**:会话维度记录(`SessionUsageRecord`)新增逐轮明细数组,在 `accumulateSessionUsage` 累加时追加每轮的 token / model / 时间戳 / 标题等;查询侧新增按会话 key 拉取「每轮明细」的能力(详情端点)。
- **放宽标题/内容记录长度**:会话标题不再截断到 80 字符,改为记录完整内容(仍去标签、压一行);每轮对话的内容(名称素材)同样完整记录与展示。**BREAKING**(数据口径):标题字段长度上限移除,落盘体积相应增大,需配套安全护栏(单条上限 + 治理裁剪)。
- **外层用量条统一配色**:「会话用量明细」外层列表的用量条改为**统一单色**,仅用长度表达占当前列表总和的占比;原「绝对阈值三档(绿/橙/红)」语义**下沉**到详情弹窗里每轮对话的进度条上(按每轮 token 绝对量分档配色)。

## Capabilities

### New Capabilities

- `session-usage-detail`: 会话详情弹窗能力——会话维度记录的逐轮明细持久化、按会话 key 拉取每轮明细的查询端点、看板详情弹窗的逐轮展示(名称/时长/token/模型 + 每轮占比进度条 + 每轮绝对量分档配色)。

### Modified Capabilities

- `session-token-usage`: 修改「会话标题 best-effort 采集」要求——标题与每轮内容素材由「截断到 80 字符上限」放宽为「记录完整内容」(保留去标签、压一行、安全上限护栏)。
- `session-usage-list-display`: 修改「会话用量条绝对阈值配色」要求——外层会话列表用量条改为统一单色、仅以长度表达占比,绝对量三档配色移交详情弹窗的逐轮进度条;并相应放宽「会话标题去标签展示」中的长度截断。

## Impact

- **core**:`packages/core/src/store/session-usage-store.ts`——`SessionUsageRecord` 增逐轮明细数组、`accumulateSessionUsage` 追加每轮项、`truncateTitle` 截断上限放宽、新增按 key 取逐轮明细的查询函数;`SessionUsageRecord` 落盘 schema(`session-usage.json`)向后兼容演进。
- **server**:`packages/server/src/routes/ai-productivity.ts`——新增 `GET /ai-productivity/session-usage/detail` 端点(panel-origin 放行)。
- **ui**:`packages/ui/src/tabs/AiUsageTab.vue`(行可点击打开弹窗)、`packages/ui/src/components/SessionUsageRow.vue`(用量条改统一单色)、新增会话详情弹窗组件 + 逐轮行组件、复用 `UsageBar` / `usage-bar-logic.ts` 的绝对配色到每轮条、`packages/ui/src/api.ts` 增详情拉取函数。
- **数据/治理**:`session-usage.json` 体积随逐轮明细与完整标题增大,需要每轮明细条数 / 单条长度上限与既有 30 天 / 1000 会话治理协同。
- **测试**:core store(逐轮累加 / 截断放宽 / 查询)、server 端点、ui 组件与快照回归;改后跑 `pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`。
