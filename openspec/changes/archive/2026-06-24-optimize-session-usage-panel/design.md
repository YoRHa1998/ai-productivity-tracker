## Context

「会话用量(最烧 token 的会话)」板块由三层组成:

- **采集**:`buildCursorUsageEvent`(Cursor hook,`server/routes/ai-productivity.ts`)、`transcript-watcher.ts`(Claude)、`codex-watcher.ts`(Codex)各自归一化出 `AiUsageEvent` 调 `recordUsage`,内部 tee 进 `accumulateSessionUsage` 落 `session-usage.json`。
- **存储 / 查询**:`packages/core/src/store/session-usage-store.ts` 持久化 `SessionUsageRecord`,`querySessions` 提供过滤 / 排序 / 截断视图。
- **展示**:`packages/ui/src/tabs/AiUsageTab.vue` 经 `fetchSessionUsage`(`api.ts`)拉取并渲染。

现状约束:

- 标题取材:Cursor 走 `readTranscriptTitle`,返回 transcript **首条**「原文非空」的 user 行文本(未在扫描时清洗),再交 `truncateTitle`→`sanitizeTitle` 清洗。Claude / Codex 在 watcher 侧由 `routeUserMessage` 缓存 `pendingUserTitle`(已 `truncateTitle`)。问题:① 首条素材清洗后可能为空 → 标题落空;② 图片场景 Cursor 写入字面 `[Image]` 占位 → 标题落成 `[Image]`。
- `projectName` / `branch` 字段链路在近期 `improve-session-usage-list` change 已加好(store / view / 三链路 / UI 条件渲染齐备),本次以复核与坐实为主,不重复造轮子。
- 排序后端已支持 `sort=total|lastAt` + `dir=asc|desc`;`project` 过滤后端尚无。
- 前端筛选 / 排序当前是三组 `ElRadioGroup`,需改 `ElSelect`。

## Goals / Non-Goals

**Goals:**

- 标题取材跳过空 / 纯占位素材,稳定取首条真实用户输入;采集 + 展示双侧幂等。
- 坐实 `projectName` / `branch` 采集→透传→展示闭环(含三链路一致)。
- 筛选 / 排序下拉化:排序依据 + 方向两个下拉、AI 平台 / 所属项目 / 时间范围三个下拉;新增服务端 `project` 过滤。

**Non-Goals:**

- 不改 token 口径、用量条配色 / 占比逻辑(`UsageBar`、绝对阈值配色保持不变)。
- 不动 5 个 MCP tool 与 `UsageBenchmarkTab` 行为。
- 不引入分页 / 无限滚动(仍 top-N 截断,limit 维持 50)。
- 不做数据迁移(历史脏标题 / 无项目分支记录靠展示侧幂等清洗 + 安全留空兜底)。

## Decisions

### D1:占位文本识别集中到 store 工具,采集侧扫描复用

新增「纯占位判定」放入 `session-usage-store.ts`,与 `sanitizeTitle` / `truncateTitle` 同模块,保证采集与展示口径一致。判定语义:对一段文本先 `sanitizeTitle`,若结果为空,或结果去除首尾空白后整体匹配已知占位集合(`[Image]`、`[图片]`,大小写 / 全半角括号容错,可多块如 `[Image][Image]`)且无其它可读字符,则视为「无意义素材」。

- **Cursor 侧**:`readTranscriptTitle` 改为扫描时对每条 user 行文本调用清洗 + 占位判定,跳过无意义素材,返回首条有意义文本;扫描上限仍受 `TRANSCRIPT_TITLE_MAX_BYTES` 约束(取不到则空)。
- **Claude/Codex 侧**:`routeUserMessage` 缓存 `pendingUserTitle` 时,若新素材无意义则不写入 / 不覆盖(已有有意义素材优先),使后续首条真实输入能补位。
- **展示侧**:`recordToView` 已对 `rec.title` 跑 `truncateTitle`;补一道「若清洗后为纯占位则视为空 → undefined」,让历史落盘的 `[Image]` 脏标题在展示时走兜底短 ID。

**Alternative(否决)**:仅在前端 `sessionLabel` 过滤占位。否决理由:无法修正采集侧落盘、且与"双侧幂等"既有约定不符,治标不治本。

### D2:`project` 服务端过滤(精确匹配)而非纯前端过滤

`QuerySessionsParams` 增 `project?: string`;`querySessions` 在 source / 时间窗过滤链路里追加 `rec.projectName === project` 精确匹配;端点解析 `project` query 参数透传。

- **为何服务端**:列表 top-N(limit 50)截断在排序后发生,若纯前端过滤会先被高用量他项目会话挤占名额,导致选中项目的会话显示不全。服务端先过滤再排序截断,结果正确。
- **项目下拉选项来源**:前端按「当前时间范围、不带 project、AI 平台过滤」的会话集合 distinct `projectName` 派生选项(可复用一次较大 limit 的查询结果,或在切换平台 / 时间范围时重算)。避免新增「distinct projects」专用端点(数据量小,不值当)。

**Alternative(否决)**:新增 `/session-usage/projects` 端点返回 distinct 列表。否决理由:增加契约面,收益有限;派生方案足够。

### D3:前端交互——两排序下拉 + 三筛选下拉

`AiUsageTab.vue` 头部 `aip-usage__sessions-filters` 区:

- `sessionSortKey: 'total' | 'lastAt'`(下拉「排序依据」:用量高低 / 记录时间)。
- `sessionSortDir: 'asc' | 'desc'`(下拉「方向」:升序 / 降序)。
- `sessionSource`(下拉「AI 平台」)、`sessionProject`(下拉「所属项目」,默认 `all`)、`sessionRangeDays`(下拉「时间范围」)。
- `watch` 任一变更触发 `loadSessions`;`loadSessions` 透传 `sort` / `dir` / `source` / `project`。
- 用 `ElSelect` + `ElOption`,沿用 element-plus,size=small,保持玻璃拟态样式 token。

「用量高低 / 记录时间」是"排序依据",方向独立;与用户原话「排序改成下拉【用量高低】【记录时间】｜【升序】【降序】」一致(竖线表示两组维度)。

## Risks / Trade-offs

- [占位集合不全,新占位文本(如视频 / 文件占位)仍漏判] → 占位集合常量化、集中可扩展;先覆盖已观测到的 `[Image]`,后续按需补充,漏判仅退化为"标题显示占位",不影响用量数据。
- [跳过空素材后仍可能取到很长的上下文 blob(无 user_query 包裹时)] → 维持既有 `sanitizeTitle` 噪声块剥离 + `TITLE_MAX_LEN` 截断;本次只新增"跳过空 / 占位",不放宽噪声剥离边界。
- [项目下拉选项派生需额外一次查询] → 复用列表查询(提高一次 limit 或共用结果)即可,频率低(仅平台 / 时间范围切换时重算),开销可忽略。
- [运行中 daemon 为旧版本(rc.8),改动需重新 build + 重启 daemon 才生效] → 属部署动作,实现完成后在 tasks 中提示本地 `pnpm --filter cli build` 验证;不在 spec 范围内强制。
- [project 精确匹配大小写敏感] → projectName 由 `package.json name` / 目录名稳定派生,前端选项亦取自同源字符串,精确匹配安全;不引入模糊匹配避免误命中。

## Migration Plan

- 纯新增可选 query 参数 + 前端交互替换,无数据结构破坏、无数据迁移。
- 回滚:还原 `AiUsageTab.vue` 与 `querySessions` / 端点 / `readTranscriptTitle` 改动即可,落盘数据不受影响。
- 历史 `[Image]` / 脏标题记录:无需迁移,展示侧幂等清洗后自动走兜底。

## Open Questions

- 「所属项目」下拉在仅单一项目时是否仍展示(可保留「全部 + 该项目」或隐藏)?倾向:有 ≥1 个项目名即展示,交互一致性优先。
- 占位集合是否需要纳入英文 `[image]` 之外的 IDE 变体(如带文件名 `[Image: foo.png]`)?倾向:用「以 `[image` 前缀且方括号包裹」宽松前缀判定覆盖变体,实现时定。
