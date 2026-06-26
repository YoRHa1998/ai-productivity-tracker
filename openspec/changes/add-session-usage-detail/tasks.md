## 1. Core:逐轮明细持久化与标题放宽

- [x] 1.1 在 `session-usage-store.ts` 定义 `SessionTurnDetail` 接口(at / total / input / output / cacheRead / cacheCreation / toolCalls / model? / title?),并为 `SessionUsageRecord` 增可选 `turnDetails?: SessionTurnDetail[]`
- [x] 1.2 新增常量 `MAX_TURN_DETAILS`(默认 500),并把 `TITLE_MAX_LEN` 由 80 放宽为安全上限(默认 4000),确认 `truncateTitle` 仅在超安全上限时 slice 兜底
- [x] 1.3 在 `accumulateSessionUsage` 的 `rec.turns += 1` 同处 push 一项 `turnDetails`(token 细分 / model / 去标签压一行的本轮 title 素材 / at),超 `MAX_TURN_DETAILS` 时按时间保留最近项(turns 计数不受裁剪影响)
- [x] 1.4 在 `normalizeRecord` 对 `turnDetails` 做加性安全解析(缺失 → undefined、非法项过滤),保证旧 `session-usage.json` 向后兼容
- [x] 1.5 新增查询函数 `querySessionDetail(key, root?)`:按 key 取记录,逐轮升序输出含每轮 `durationMs`(相邻 at 差值、末轮留空)与 `ratio`(turn.total / 会话 total)的视图,key 不存在 / 无明细返回空明细数组

## 2. Server:详情端点

- [x] 2.1 在 `routes/ai-productivity.ts` 新增 `handleSessionUsageDetail`,解析 `key` query,调 `querySessionDetail`,返回 `{ session: 头部, turns: [...] }`,key 缺省 / 无明细返回 `200` 空明细
- [x] 2.2 注册 `GET /ai-productivity/session-usage/detail` 路由,并把它加入 panel-origin 同源放行集合

## 3. UI:外层列表统一配色

- [x] 3.1 在 `SessionUsageRow.vue` 把 `UsageBar` 的 `color-mode` 由 `absolute` 改为统一单色(新增 `unified` 模式或传中性 token),保持长度归一化(占列表总和比例)不变
- [x] 3.2 在 `usage-bar-logic.ts` 增统一单色取值(中性设计 token,如 `--aipt-usage-bar`),不影响既有 `usageColorVarAbsolute` / `usageColorVar`

## 4. UI:会话详情弹窗

- [x] 4.1 在 `api.ts` 增 `fetchSessionUsageDetail(key)` 及返回类型(会话头部 + 逐轮明细含 durationMs / ratio)
- [x] 4.2 新增 `SessionUsageDetailDialog.vue`(`ElDialog`):头部复用会话标识,主体 `v-for` 逐轮行(名称 / 时长 / model / 本轮 token + 每轮进度条),进度条长度按 ratio、颜色复用 `usageColorVarAbsolute` 绝对三档
- [x] 4.3 在弹窗加每轮时长口径说明文案(相邻轮间隔近似、含空闲、末轮显示「—」)与无明细空态提示
- [x] 4.4 在 `SessionUsageRow.vue` / `AiUsageTab.vue` 接入:整行 `@click` 打开弹窗并传 key,Jira 下钻徽标 `@click.stop` 防冒泡;列表行标题保持单行省略展示完整 title

## 5. 测试与回归

- [x] 5.1 core 单测:逐轮明细累加 / `MAX_TURN_DETAILS` 裁剪 / turns 计数不受裁剪 / 标题完整记录与安全上限兜底 / `querySessionDetail` 时长与 ratio 推导(含末轮留空、空明细)
- [x] 5.2 server 单测:详情端点正常返回 / key 不存在返回空 / panel-origin 放行
- [x] 5.3 ui 测试与快照:外层统一单色回归、详情弹窗逐轮渲染与配色、空态、徽标防冒泡
- [x] 5.4 全量回归:`pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`
