## 1. Core:归一化用量事件与丰富 store

- [ ] 1.1 在 `packages/core/src/store/paths.ts` 新增 `AI_USAGE_FILE_NAME` 与 `aiUsagePath(root?)`
- [ ] 1.2 定义归一化 `AiUsageEvent` 类型(OTel GenAI 子集:source / sessionId / turnId? / model? / provider? / tokens{input,output,cacheRead,cacheCreation,total} / toolCalls? / at)
- [ ] 1.3 新增 `packages/core/src/store/ai-usage-store.ts`:schema(version/config/daily,按 AI×日聚合 token 细分 + turns + models/providers 细分;sessions **不持久化集合**,落事件后由查询侧按当日 sessionId 重算去重)、`readAiUsage()`、`recordUsage(event)`(本机时区分日累加、tmp+rename 原子写,仅存结构化元数据不存正文)、`setAiUsageEnabled(bool)`,并维护进程内 `enabled` 缓存
- [ ] 1.4 在 `packages/core/src/index.ts` 导出公共 API 与类型
- [ ] 1.5 `ai-usage-store.spec.ts`:默认关闭、token 细分累加、turns 计数、sessions 按当日事件重算去重、缺维度降级、跨天分桶、重复事件幂等、开关持久化

## 2. 前置依赖(独立变更 / 单独 rc,先于本变更落地)

> watcher state 文件追踪 `offset+mtime` → `offset+size+ino` 升级,已定**拆为独立前置 rc**(见 design.md「前置依赖」)。下列任务不在本变更范围内,仅作依赖登记;本变更实现前需确认该前置 rc 已合并发布。

- [ ] 2.1 (前置 rc)`watcher-state.ts` / codex state schema 文件追踪升级为 `offset+size+ino`,缺字段按旧逻辑兜底兼容
- [ ] 2.2 (前置 rc)两个 watcher `processFile` 用 ino 识别 inode 变化/轮转,补 `watcher-state.spec.ts` / `codex-watcher.spec.ts` 回归
- [ ] 2.3 (本变更前置检查)确认前置 rc 已发布并升级,再开始第 3 节

## 3. Core:采集旁路接入 watcher(Claude / Codex)

- [ ] 3.1 在 `TranscriptWatcher` flushTurn 处、`ensurePendingTurn`/issueKey 闸门**之前**,把 `ParsedTokens` 细分 + model 归一化为 `AiUsageEvent` 并 `recordUsage('claude-code', ...)`,`enabled===false` 短路
- [ ] 3.2 在 `CodexWatcher` flush 处(复用 `currentTotalEffective - flushedTotal` 增量 + 细分)、issueKey 闸门前 `recordUsage('codex', ...)`,`enabled===false` 短路
- [ ] 3.3 测试:非 Jira 分支会话仍计入整体用量、关闭开关不写、需求维度采集行为不受影响、token 细分正确

## 4. Hook/Server:Cursor v1 改 hook-core 覆盖非仓库会话

- [ ] 4.1 在 `hook-core/src/hook.ts`「无 project root 即静默退出」前,新增向 daemon 上报最小化用量信号的旁路(只带 source/tokens 细分/model/sessionId,**不带正文/需求上下文**);上报需容错静默(daemon 不可达/解析失败一律吞掉,不影响 hook 退出码与既有需求链路)
- [ ] 4.2 在 daemon `routes/ai-productivity.ts` 的 `handleAiProductivityHook` 入口、issueKey 解析之前,用 `parseHookTokens` + 透传 cache 字段归一化为 `AiUsageEvent` 并 `recordUsage('cursor', ...)`,`enabled===false` 短路
- [ ] 4.3 测试:Cursor 在非 Jira 分支(git 仓库内)与非 git 目录会话均计入 cursor 整体用量;dedupeKey 去重不重复累加
- [ ] 4.4 hook-core 改动回归:`pnpm --filter @ai-productivity-tracker/hook-core test` + 模拟 IDE 起 hook 的 e2e(CHANGELOG 经验 5/6/7 三层防御)

## 5. Server:HTTP 端点

- [ ] 5.1 新增 `handleAiProductivityGetAiUsage(res,{days})`(返回 enabled + today + series,携带全部已采集维度,默认 days=14)与 `handleAiProductivityPatchAiUsageConfig(res,body)`(切换开关 + 刷新进程内缓存)
- [ ] 5.2 在 `http/server.ts` 注册 `GET /ai-productivity/ai-usage`、`PATCH /ai-productivity/ai-usage/config`,并加入 `isAiProductivityPanelPath` 放行集合
- [ ] 5.3 `routes/ai-productivity.spec.ts`:查询结构正确、days 参数、切换开关即时生效、关闭时仍可查历史

## 6. UI:API 客户端与类型

- [ ] 6.1 在 `packages/ui/src/api.ts` 新增完整类型(`AiUsageSource`、含 token 细分/turns/sessions/models/providers 的 daily 项、`AiUsageResponse`)与 `fetchAiUsage(days?)`、`patchAiUsageConfig({enabled})`

## 7. UI:菜单与页面(v1 简单展示)

- [ ] 7.1 在 `router.ts` `primaryNav` 新增「AI 用量」菜单项(`i-lucide-activity`)并注册路由 `ai-usage`
- [ ] 7.2 新增 `tabs/AiUsageTab.vue`:顶部各 AI glass 卡片(**仅当天 totalTokens + turns**)+ 监控开关(el-switch);底部 `VChart` 趋势图(**默认 token 维度**,可切换对话次数),复用 tokens.css / glass.css / useChartTheme
- [ ] 7.3 开关交互:切换调用 `patchAiUsageConfig`,成功后刷新;加载/错误/空态(引导开启监控)处理
- [ ] 7.4 视觉走查:与「需求看板」「复盘经验」页面风格一致

## 8. 回归与验证

- [ ] 8.1 `pnpm --filter core test`、`pnpm --filter hook-core test`、`pnpm --filter server test` 通过
- [ ] 8.2 `pnpm typecheck && pnpm lint && pnpm format:check` 全绿
- [ ] 8.3 `pnpm --filter @ai-productivity-tracker/cli build` 产物可启动;`aipt daemon` 起后浏览器开「AI 用量」页面,开启监控后在 `main` 分支用各 AI 对话能看到当天用量与趋势更新
- [ ] 8.4 幂等校验:重启 daemon 后整体用量不重复计数;inode 轮转场景不漏不重