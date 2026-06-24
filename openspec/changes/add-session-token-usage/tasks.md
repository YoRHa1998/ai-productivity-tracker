## 1. core:会话维度 store

- [x] 1.1 在 `AiUsageEvent`(`packages/core/src/store/ai-usage-store.ts`)新增可选字段 `title?: string` 与 `jiraKey?: string`,补注释与归一化兜底,确认 daily 聚合不消费这两个字段
- [x] 1.2 新增 `packages/core/src/store/session-usage-store.ts`:定义 `SessionUsageRecord`(含 title)/ `SessionUsageFile`(version=1),实现 `readSessionUsage` / `writeSessionUsage`(tmp+rename),路径常量加入 `store/paths.ts`(`sessionUsagePath`);定义 `TITLE_MAX_LEN` / `RETENTION_DAYS` / `MAX_SESSIONS` 常量
- [x] 1.3 实现 `accumulateSessionUsage(event, root?)`:空 sessionId 短路;按 `${source}:${sessionId}` 累加 token 细分 / turns / toolCalls,刷新 firstAt/lastAt,非空 model / jiraKey 覆盖,`title` 仅首次写入不覆盖
- [x] 1.4 实现 `pruneSessions(file)`:删除 lastAt 早于 `RETENTION_DAYS`(默认 30)的会话 + 按 lastAt 倒序截断到 `MAX_SESSIONS`(默认 1000);在 `accumulateSessionUsage` 写盘前调用
- [x] 1.5 实现 `querySessions({ from?, to?, source?, limit?, sort? })`:过滤 + 排序(默认 total 倒序,可 lastAt)+ 截断(默认 50),返回视图数组
- [x] 1.6 在 `recordUsage` 的 `isAiUsageEnabled()` 守卫之内、写 `ai-usage.json` 之后 tee 一次 `accumulateSessionUsage(event, root)`

## 2. core:采集点富化 title + jiraKey

- [x] 2.1 `transcript-watcher.ts`:PendingTurn 首见 `type=user` 行时(`parseClaudeUserMessage`)捕获首条输入文本作 title 素材;flush 处用量事件填 `title`(截断 TITLE_MAX_LEN)+ 已解析 issueKey 时填 `jiraKey`
- [x] 2.2 `codex-watcher.ts`:取会话首个 `user_message` 文本作 title 素材;flush 处用量事件填 `title`(截断)+ `jiraKey`(非 Jira 分支留空)
- [x] 2.3 `server/routes/ai-productivity.ts` `buildCursorUsageEvent` / `handleAiProductivityHook`:best-effort 读 `transcript_path` 取首条 user 行作 `title`(读不到留空)+ 已解析 issueKey 时填 `jiraKey`
- [x] 2.4 抽公共 `truncateTitle(text, max)`(去首尾空白 / 折行压一行 / 截断)到 core,三处复用

## 3. core:单元测试

- [x] 3.1 `session-usage-store.spec.ts`:累加(含跨日同会话)、空 sessionId 跳过、source 前缀消歧、token total 口径、title 首次写入不被覆盖
- [x] 3.2 prune 测试:过期裁剪 + 超条数按最近保留
- [x] 3.3 query 测试:from/to/source 过滤 + 排序 + limit 截断
- [x] 3.4 `recordUsage` 集成:enabled 时写会话维度、disabled 时不写、带 title/jiraKey 落库;幂等(重复事件由上游去重)
- [x] 3.5 `truncateTitle` 单测:超长截断、折行压一行、空白裁剪、空输入兜底

## 4. server:查询端点

- [x] 4.1 `routes/ai-productivity.ts` 新增 `handleSessionUsageQuery`:解析 query(from/to/source/limit/sort),调 `querySessions`,返回 `{ sessions }`
- [x] 4.2 `http/server.ts` 注册 `GET /ai-productivity/session-usage` 并加入 `isAiProductivityPanelPath` 放行集合
- [x] 4.3 server 测试:默认 token 倒序、source+时间过滤、同源放行、参数缺省兜底

## 5. ui:会话明细区

- [x] 5.1 `api.ts` 新增 `SessionUsageView` 类型与 `fetchSessionUsage(params)` 客户端方法
- [x] 5.2 新增 `components/UsageBar.vue`:props `{ value, max, thresholds? }`;条长归一化(value/max)+ 绿/橙/红三档(danger 0.66 / warn 0.33)+ 紧凑数值叠加 + aria-label;在 `styles/tokens.css` 新增 `--aipt-usage-low/mid/high`(亮暗各一套)
- [x] 5.3 `tabs/AiUsageTab.vue` 新增「会话」列表 glass 卡片:工具筛选 + 时间范围 + 排序切换(用量高→低/低→高,默认高→低,走服务端 sort/limit);每行嵌 `UsageBar`(max=本页会话最大 total)
- [x] 5.4 会话标识:展示 `title`;`jiraKey` 非空时标题旁加可点击徽标跳需求详情;title 空则回退短会话 ID + 工具 + 时间窗;实现空态引导
- [x] 5.5 增强 `tabs/UsageBenchmarkTab.vue`:记录列表与对比区每条嵌 `UsageBar`(value=grandTotal,max=列表内最大 grandTotal)+ 新增按用量排序控件(前端本地排序);不改其 store / 端点 / 数据契约
- [x] 5.6 `UsageBar` 组件单测 / 快照:value/max 归一化宽度、三档阈值取色、max<=0 兜底、单条满格
- [x] 5.7 复用 styles tokens / glass / echarts 主题,确认两页与既有页面风格一致

## 6. 回归与发版

- [x] 6.1 `pnpm --filter @ai-productivity-tracker/core test` / `--filter server test` 通过
- [x] 6.2 `pnpm typecheck && pnpm lint && pnpm format:check` 全绿
- [x] 6.3 `pnpm --filter @ai-productivity-tracker/cli build` 本地验证看板会话明细区端到端可用
- [x] 6.4 `openspec validate add-session-token-usage --strict` 通过
