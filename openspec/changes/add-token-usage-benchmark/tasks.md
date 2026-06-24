## 1. Core:测算会话 store

- [x] 1.1 在 `packages/core/src/store/paths.ts` 新增 `USAGE_BENCHMARK_FILE_NAME = 'usage-benchmark.json'` 与 `usageBenchmarkPath(root?)`
- [x] 1.2 在 `usage-benchmark-store.ts` 定义类型:`UsageBenchmarkTotals`(复用 `AiUsageTokens` 细分 + turns + sessionIds[])、`UsageBenchmarkActive`(id/label?/sources[]/startedAt/totals)、`UsageBenchmarkSession`(+ endedAt/durationMs/grandTotal)、`UsageBenchmarkFile`(version/active/sessions[])
- [x] 1.3 实现 `readBenchmark(root?)`(缺文件返空、字段降级)、写盘 tmp+rename 原子写
- [x] 1.4 实现 `startBenchmark({label?, sources}, root?)`:校验 sources 非空且合法、已有 active 则抛错、生成 id、初始化 totals、写盘 + 刷新进程内 active 缓存
- [x] 1.5 实现 `accumulateBenchmark(event, root?)`:先查进程内 active 缓存(无 active 零盘 I/O 返回);`event.source ∈ active.sources` 时累加 token 细分 + turns+1 + sessionId 去重,写盘
- [x] 1.6 实现 `stopBenchmark(root?)`:无 active 抛错;定格 totals、算 durationMs + grandTotal、push 进 sessions(倒序)、清空 active、写盘 + 刷新缓存,返回该记录
- [x] 1.7 实现 `cancelBenchmark(root?)`(清空 active,不入 sessions)、`deleteBenchmark(id, root?)`(幂等移除)、`hasActiveBenchmark(root?)`(进程内缓存,首读恢复)、`__resetBenchmarkCacheForTest()`
- [x] 1.8 在 `ai-usage-store.ts` 新增并导出 `isUsageCaptureActive()` = `isAiUsageEnabled() || hasActiveBenchmark()`(usage-benchmark-store 对 ai-usage-store 仅 `import type`,无运行时循环依赖)
- [x] 1.9 在 `recordUsage` 内部:既有 daily 聚合保持 `isAiUsageEnabled()` 守卫不变,新增一次 `accumulateBenchmark(event)` tee(置于 enabled 守卫之外)
- [x] 1.10 在 `packages/core/src/store/index.ts` 导出 store 公共 API 与类型
- [x] 1.11 `usage-benchmark-store.spec.ts`:多选启动、空 sources 拒绝、重复启动拒绝、按 source 过滤累加、token 细分/turns/sessionId 去重、stop 落盘 + grandTotal、cancel 不入库、delete 幂等、无 active 时 accumulate 零写、active 跨「重置进程缓存」从盘恢复、与 recordUsage 集成(全局关仅测算/全局开两者都写)

## 2. Core:采集闸门放宽(三处)

- [x] 2.1 `transcript-watcher.ts` 把 `isAiUsageEnabled()` 替换为 `isUsageCaptureActive()`
- [x] 2.2 `codex-watcher.ts` 把 `isAiUsageEnabled()` 替换为 `isUsageCaptureActive()`
- [x] 2.3 `routes/ai-productivity.ts`(Cursor 旁路)把 `isAiUsageEnabled()` 替换为 `isUsageCaptureActive()`
- [x] 2.4 回归断言:无测算且全局监控关时不写;仅开测算、全局关时事件流到达 `recordUsage` 且只写 benchmark 不写 ai-usage(spec 集成用例覆盖)

## 3. Server:HTTP 端点

- [x] 3.1 在 `routes/ai-productivity.ts` 新增处理器:`handleGetUsageBenchmark`、`handleStartUsageBenchmark(body)`、`handleStopUsageBenchmark`、`handleCancelUsageBenchmark`、`handleDeleteUsageBenchmark(body)`;参数非法 / 状态冲突返回 4xx + 错误信息
- [x] 3.2 在 `http/server.ts` `routeAiProductivity` 注册:`GET /ai-productivity/usage-benchmark`、`POST .../start`、`POST .../stop`、`POST .../cancel`、`POST .../delete`
- [x] 3.3 panel-origin 放行:`isAiProductivityPanelPath` 为黑名单机制,`/ai-productivity/usage-benchmark*` 默认放行,无需新增(已确认)
- [x] 3.4 `routes/ai-productivity.spec.ts`:启动/结束/取消/查询/删除流程、空 sources 与重复启动报错、无 active 结束报错、删除幂等

## 4. UI:API 客户端与类型

- [x] 4.1 在 `packages/ui/src/api.ts` 新增类型(`UsageBenchmarkTotals`、`UsageBenchmarkActive`、`UsageBenchmarkSession`、`UsageBenchmarkState`)与方法 `fetchUsageBenchmark()` / `startUsageBenchmark({label?, sources})` / `stopUsageBenchmark()` / `cancelUsageBenchmark()` / `deleteUsageBenchmark(id)`

## 5. UI:菜单与页面

- [x] 5.1 在 `router.ts` `primaryNav` 新增「用量测算」菜单项(`i-lucide-timer`)并注册路由 `usage-benchmark`
- [x] 5.2 新增 `tabs/UsageBenchmarkTab.vue` 控制区:idle 态工具多选(`el-checkbox-group`)+ 标签输入 +「开始记录」(未选工具禁用);running 态实时计时(本地 setInterval)+ 轮询滚动 totals +「结束记录」「取消」
- [x] 5.3 历史记录列表:glass 卡片展示 label / 时间窗 / 时长 / 各工具 token 合计 / grandTotal;多选 + 删除(二次确认)
- [x] 5.4 对比区:选中 ≥2 条 → 并排表格(总 token / 对话次数 / 时长)+ echarts 柱状图(各工具 token 合计);复用 useChartTheme
- [x] 5.5 加载/错误/空态(引导「开始一次记录」);视觉与「AI 用量」「需求看板」一致

## 6. 回归与验证

- [x] 6.1 `pnpm --filter core test`、`pnpm --filter server test` 通过(core + server 共 675 例全绿)
- [x] 6.2 `pnpm typecheck && pnpm lint && pnpm format:check` 全绿
- [x] 6.3 `pnpm --filter @ai-productivity-tracker/cli build` 产物可启动(已构建 v1.3.0-rc.2,SPA 含「用量测算」页);起 daemon 后 curl 冒烟 start/get/stop/delete/dup-start(400)/empty-sources(400) 全通过。浏览器内「用 AI 对话 → 看滚动用量 → 对比图表」属真机 dogfood,待用户验证
- [ ] 6.4 独立性校验:全局「AI 用量」监控关闭时,仅靠测算会话仍能采集到 token;`ai-usage.json` 在此期间不被写入(已由 spec 集成用例覆盖,待真机确认)
- [ ] 6.5 重启校验:测算进行中重启 daemon,active 会话与累加值不丢(已由 store spec 覆盖,待真机确认)
