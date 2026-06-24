## Why

看板「会话用量(最烧 token 的会话)」板块当前有三处影响可用性的问题:

1. **标题截取不可靠**:部分会话标题显示为无意义的 `[Image]` 占位符,或因首条用户输入被清洗成空而退化为 `Cursor · c12e9060` 这类短 ID 兜底,用户无法据标题辨认会话。
2. **项目 / 分支信息缺位**:虽然 `session-usage-list-display` 已规定记录 `projectName` / `branch`,但实际板块上几乎看不到,用户无法按代码仓库 / 分支维度辨识会话归属。
3. **筛选 / 排序交互单薄**:当前用 RadioButton 平铺(全部 / Cursor / Claude / Codex、近 7 / 30 天、用量高→低 / 低→高),既占空间又无法按「记录时间」排序或按「所属项目」筛选。

借优化会话用量板块,一次性把标题质量、归属信息、筛选排序交互补齐,让该板块真正可用于「定位最烧 token 的会话并下钻」。

## What Changes

- **修复会话标题取材**:首条用户输入素材在去标签清洗后为空、或为纯占位文本(如 `[Image]`)时,采集侧 MUST 跳过该素材继续向后扫描,取首条「清洗后非空且非纯占位」的真实用户输入作为标题;仍取不到时才留空(展示侧兜底短 ID)。该清洗 / 跳过在采集写入侧与展示读取侧双侧生效且幂等。
- **复核并坐实项目 / 分支展示闭环**:确认 Cursor / Claude / Codex 三链路在能解析到时确实把 `projectName` / `branch` 写入会话记录并经查询视图透传;看板会话行在元信息区稳定展示非空的项目名与分支(空则不渲染)。
- **重做筛选 / 排序交互(下拉化)**:把会话列表头部的筛选与排序由 RadioButton 改为下拉(ElSelect)交互:
  - **排序**:下拉「排序依据」=【用量高低】/【记录时间】,叠加「方向」=【升序】/【降序】(后端 `sort=total|lastAt` + `dir=asc|desc` 已支持,前端打通)。
  - **筛选**:下拉「AI 平台」=【全部 / Cursor / Claude / Codex】、下拉「所属项目」=【全部 / <动态项目列表>】、下拉「时间范围」=【近 7 天 / 近 30 天】。
- **新增「所属项目」服务端过滤**:`querySessions` 与 `/ai-productivity/session-usage` 端点新增可选 `project` 过滤参数(按 `projectName` 精确匹配),使按项目筛选不被 top-N 截断影响;前端据当前时间范围内会话集合动态生成项目下拉选项。

## Capabilities

### New Capabilities

<!-- 无新增能力,均为对既有 session-usage-list-display 能力的需求级修改 -->

### Modified Capabilities

- `session-usage-list-display`: 收紧「会话标题去标签展示」需求——补充「素材清洗后为空 / 纯占位文本时跳过并向后取首条真实输入」规则;在「会话所属项目与分支记录」需求下明确展示闭环;新增「会话列表筛选与排序」需求(下拉式排序依据 + 方向、AI 平台 / 所属项目 / 时间范围筛选,含服务端 `project` 过滤)。

## Impact

- **`packages/server/src/routes/ai-productivity.ts`**:`readTranscriptTitle` 扫描逻辑(跳过空 / 占位素材);`/ai-productivity/session-usage` 端点解析新增 `project` query 参数。
- **`packages/core/src/store/session-usage-store.ts`**:`truncateTitle` / `sanitizeTitle` 占位文本识别;`QuerySessionsParams` 增 `project` 过滤;`querySessions` 按 `projectName` 过滤。
- **`packages/core/src/transcript-watcher.ts` / `codex-watcher.ts`**:复核 title 取材跳过逻辑复用同一清洗工具,确保三链路一致。
- **`packages/ui/src/tabs/AiUsageTab.vue`**:筛选 / 排序由 RadioButton 改 ElSelect 下拉;新增「所属项目」下拉(选项动态派生);打通「记录时间」排序。
- **`packages/ui/src/api.ts`**:`FetchSessionUsageParams` 增 `project` 字段并透传。
- 对外契约:`session-usage` 端点纯新增可选 query 参数,向后兼容;不改 5 个 MCP tool 与其它端点;旧会话记录无 `projectName` / `branch` 安全留空;无 BREAKING。
