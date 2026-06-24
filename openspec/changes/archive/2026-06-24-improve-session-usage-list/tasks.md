## 1. core:标题去标签清洗(D1)

- [x] 1.1 在 `packages/core/src/store/session-usage-store.ts` 新增导出 `sanitizeTitle(text): string`:优先提取最后一个 `<user_query>...</user_query>` 内部正文;否则移除已知噪声标签块(`<timestamp>` / `<cursor_commands>` / `<system_reminder>` / `<attached_files>` / `<additional_data>` 等,大小写不敏感、容忍未闭合)并剥离残留尖括号标签
- [x] 1.2 `truncateTitle` 内首步调用 `sanitizeTitle`,更新函数注释(语义扩展为「去标签 + 压行截断」)
- [x] 1.3 `recordToView` 对落盘 `rec.title` 再跑一次 `sanitizeTitle`(幂等,清洗历史脏标题,不改写落盘数据)
- [x] 1.4 `sanitizeTitle` 单测:提取 user_query 正文、剥噪声标签块、剥残留标签、已取 user_query 时保留含尖括号正文、空 / 非字符串兜底、幂等性

## 2. core:projectName / branch 采集与持久化(D4)

- [x] 2.1 `AiUsageEvent`(`store/ai-usage-store.ts`)新增可选 `projectName?: string` / `branch?: string`,补注释(daily 聚合不消费)
- [x] 2.2 `SessionUsageRecord` / `SessionUsageView` 增 `projectName?` / `branch?`;`normalizeRecord` / `recordToView` 透传 + `optStr` 兜底
- [x] 2.3 `accumulateSessionUsage` 对非空 `projectName` / `branch` 覆盖更新(取最近,与 model 同策略)
- [x] 2.4 `transcript-watcher.ts` flush 处填 `branch = buf.branch`、`projectName = readProjectNameFromPackageJson(buf.gitRoot)`(best-effort)
- [x] 2.5 `codex-watcher.ts` flush 处同样填 `branch` / `projectName`(buffer 已有 gitRoot / branch)
- [x] 2.6 `buildCursorUsageEvent`(`server/routes/ai-productivity.ts`)填 `branch = body.branch`,best-effort 填 `projectName`(可得 project root 时)
- [x] 2.7 store 单测:projectName / branch 累加覆盖、缺失留空、历史记录(无该字段)读取兼容、querySessions 视图透传

## 3. ui:UsageBar 解耦配色与条长(D2)

- [x] 3.1 `components/usage-bar-logic.ts` 新增 `DEFAULT_ABSOLUTE_USAGE_THRESHOLDS = { warn: 150_000, danger: 300_000 }` 与 `usageColorVarAbsolute(value, thresholds)`(≥danger 红 / ≥warn 橙 / 否则绿)
- [x] 3.2 `UsageBar.vue` 新增 props `colorMode?: 'ratio' | 'absolute'`(默认 `ratio`)、`absoluteThresholds?`;配色按模式分流(ratio 走既有 `usageColorVar(usageRatio(...))`,absolute 走 `usageColorVarAbsolute(value)`),条长 `value/max` 语义不变
- [x] 3.3 `usage-bar-logic.spec.ts` 增绝对配色单测(300K 红 / 150K 橙 / <150K 绿 / 边界值),并断言默认 `ratio` 模式取色与改前一致(benchmark 零回归)

## 4. ui:会话列表接入新展示(D2 / D3 / D4)

- [x] 4.1 `api.ts` `SessionUsageView` 类型增 `projectName?` / `branch?`
- [x] 4.2 `AiUsageTab.vue` 新增 `sessionSumTotal = Σ totalTokens`,会话行 `UsageBar` 改传 `:max="sessionSumTotal"` + `color-mode="absolute"`(条长按总和占比、配色按绝对阈值)
- [x] 4.3 会话标题渲染走清洗后内容(后端已清洗,前端确认 `sessionLabel` 不再展示标签);meta 行追加非空 `projectName` / `branch` 轻量标签
- [ ] 4.4 (可选)条长 fill 像素地板(如 2px)做多会话尾条可见性兜底,不改宽度计算口径 —— 不实现:fill min-width 会影响 benchmark 共享组件的零值条,违背 4.5 零回归
- [x] 4.5 核对 `UsageBenchmarkTab.vue` 调用点未传 `colorMode` / `absoluteThresholds`,行为零回归

## 5. 回归与发版

- [x] 5.1 `pnpm --filter @ai-productivity-tracker/core test` / `--filter @ai-productivity-tracker/server test` / ui 组件单测 通过(全量 981 例绿)
- [x] 5.2 `pnpm typecheck && pnpm lint && pnpm format:check` 全绿
- [x] 5.3 `pnpm --filter @ai-productivity-tracker/cli build` 本地验证看板会话列表:标题去标签、绝对配色、总和占比条长、项目 / 分支展示端到端可用
- [x] 5.4 `openspec validate improve-session-usage-list --strict` 通过
