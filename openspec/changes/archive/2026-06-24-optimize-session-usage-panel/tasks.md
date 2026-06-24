## 1. core:标题占位识别与跳过(D1)

- [x] 1.1 `session-usage-store.ts` 新增导出 `isPlaceholderTitle(text): boolean`(先 `sanitizeTitle`,空 或 仅匹配占位集合 `[Image]` / `[图片]` 宽松前缀且无其它可读字符 → true),含注释说明占位集合可扩展
- [x] 1.2 `accumulateSessionUsage` 首次写 title 时:`truncateTitle` 后若 `isPlaceholderTitle` 命中则不写(留待后续真实输入补位)
- [x] 1.3 `recordToView` 展示侧:`rec.title` 清洗后若 `isPlaceholderTitle` 命中则 `title=undefined`(历史脏标题走兜底,不改写落盘)
- [x] 1.4 store 单测:空素材跳过、`[Image]` 占位跳过、纯占位安全留空、含真实文本不误删、幂等

## 2. 采集侧:三链路取首条真实输入(D1)

- [x] 2.1 `ai-productivity.ts` `readTranscriptTitle`:扫描每条 user 行文本时,对清洗 + 占位判定不通过的素材跳过,返回首条「清洗后非空且非占位」原文(取不到则空);保持 `TRANSCRIPT_TITLE_MAX_BYTES` 上限
- [x] 2.2 `transcript-watcher.ts` `routeUserMessage`:写 `pendingUserTitle` 前用 `isPlaceholderTitle` 过滤,占位 / 空不覆盖已有有意义素材
- [x] 2.3 `codex-watcher.ts` 同口径复核 title 取材跳过逻辑(若有 pendingUserTitle 等价路径)
- [x] 2.4 采集侧单测 / 现有用例回归:首条占位被跳过、取到后续真实输入

## 3. core + server:所属项目服务端过滤(D2)

- [x] 3.1 `QuerySessionsParams` 增 `project?: string`;`querySessions` 在过滤链路追加 `rec.projectName === project` 精确匹配(空 / 缺省不过滤)
- [x] 3.2 `/ai-productivity/session-usage` 端点解析 `project` query 参数并透传 `querySessions`
- [x] 3.3 store / 端点单测:project 精确过滤、缺省向后兼容、与 source / 时间窗叠加

## 4. 复核 projectName / branch 展示闭环(D1 既有)

- [x] 4.1 复核 `buildCursorUsageEvent` / `transcript-watcher` / `codex-watcher` 三处确实在能解析时填 `projectName` / `branch`(已实现则确认,缺则补)
- [x] 4.2 确认 `recordToView` 透传 `projectName` / `branch`,`AiUsageTab.vue` 会话行非空时渲染标签、空时不渲染

## 5. 前端:筛选 / 排序下拉化(D3)

- [x] 5.1 `api.ts` `FetchSessionUsageParams` 增 `project?: string` 并在 `fetchSessionUsage` 透传
- [x] 5.2 `AiUsageTab.vue` 新增响应式 `sessionSortKey('total'|'lastAt')`、保留 `sessionSortDir`、新增 `sessionProject('all'|string)`
- [x] 5.3 头部筛选区把三组 `ElRadioGroup` 改为 `ElSelect`:排序依据(用量高低 / 记录时间)、方向(升序 / 降序)、AI 平台、所属项目、时间范围(近 7 / 30 天)
- [x] 5.4 派生「所属项目」下拉选项:按当前时间范围 + AI 平台、不带 project 的会话集合 distinct `projectName`(无项目名会话不产生选项)
- [x] 5.5 `loadSessions` 透传 `sort=sessionSortKey` / `dir=sessionSortDir` / `project`;`watch` 覆盖全部筛选 / 排序响应式即时重查
- [x] 5.6 样式:`ElSelect` 沿用 size=small + 设计 token,filters 区布局不溢出、移动端换行正常

## 6. 回归与本地验证

- [x] 6.1 `pnpm --filter @ai-productivity-tracker/core test`、`pnpm --filter @ai-productivity-tracker/server test` 通过
- [x] 6.2 `pnpm test && pnpm lint && pnpm format:check && pnpm typecheck` 全绿
- [x] 6.3 `pnpm --filter @ai-productivity-tracker/cli build` 产物可起 daemon;本地刷新看板核验标题 / 项目分支 / 下拉筛选排序符合预期(提示:运行中旧 daemon 需重启生效)
