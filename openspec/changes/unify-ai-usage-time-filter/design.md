## Context

「AI 用量」页面三模块全部内联在单文件组件 `packages/ui/src/tabs/AiUsageTab.vue` 中,无 Pinia、无共享 store,状态全是组件本地 `ref`。三处时间口径各自独立:

- **汇总卡片**:读 `data.today`(后端 `ai-usage` 响应里固定的「今天」单日视图),无任何时间控件。
- **趋势图**:模块顶部常量 `const DAYS = 14`,`load()` 调 `fetchAiUsage(DAYS)`,用响应里的 `series`(长度 = days 的按日序列)绘图。
- **会话明细**:本地 `sessionRangeDays = ref<1 | 7 | 30>(1)`,经 `sessionFromIso()` 折算 `from` 传给 `fetchSessionUsage`,并有一个自带的「时间范围」`ElSelect`。

后端两个端点 `GET /ai-productivity/ai-usage?days=N`(返回 `{ enabled, today, series }`)与 `GET /ai-productivity/session-usage?from=...` 行为不需要变。约束:不引入新依赖、不动后端、不动数据 schema、视觉复用既有 glass / design token。

## Goals / Non-Goals

**Goals:**

- 页面顶部新增唯一的时间筛选(当天 / 近 7 天 / 近 30 天),一处切换驱动全页三模块同口径刷新。
- 汇总卡片从「固定当天」改为「按所选范围聚合」,单位文案随范围动态。
- 趋势图天数随所选范围(替代硬编码 `DAYS=14`)。
- 会话明细移除自带「时间范围」下拉,改消费统一筛选。
- 选中值 localStorage 持久化。

**Non-Goals:**

- 不改后端端点 / 查询参数语义(`days`、`from` 照旧)。
- 不引入 Pinia 或新状态库(单文件本地 ref 足够)。
- 不改数据采集 / schema。
- 不新增除「当天 / 近 7 天 / 近 30 天」以外的档位(如自定义区间)。

## Decisions

### 决策 1:用单个 `rangeDays` ref 作为全页唯一时间源

新增 `const rangeDays = ref<1 | 7 | 30>(readPersistedRange())`,替代 `DAYS` 常量与 `sessionRangeDays`。所有模块从它派生:

- `load()` 调 `fetchAiUsage(rangeDays.value)`。
- `sessionFromIso()` 改读 `rangeDays.value`(逻辑等价,仅换数据源)。
- `watch(rangeDays, ...)` 统一触发:`load()`(卡片 + 趋势)+ `loadProjectOptions()` + `loadSessions()`,并复位会话分页 `currentPage = 1`。

**理由**:三模块同文件,一个 ref 即天然「共享状态」,无需 store。`1 | 7 | 30` 直接复用既有会话模块的类型口径,`sessionFromIso()` 几乎零改动。

**Alternatives considered**:抽 Pinia store / composable —— 当前仅单文件三模块,过度设计;若后续拆子组件再演进。

### 决策 2:卡片改为「对 series 求和」,而非读 `today`

后端 `series` 已是所选范围内的按日序列(长度 = `rangeDays`)。卡片改为对 `series` 各 source 的 `tokenOf(view)` 与 `turns` 求和得到范围合计。`rangeDays=1` 时 series 仅 1 点(即今天),结果与原 `today` 等价 —— 口径自然统一,无需特判。

**理由**:复用同一次 `fetchAiUsage` 响应,**零额外请求、零后端改动**;`today` 字段可不再被卡片使用(保留响应兼容)。

**Alternatives considered**:后端新增「范围聚合」端点 —— 违背「不动后端」约束且多一次往返,放弃。

### 决策 3:卡片单位文案 + 趋势副标题随 `rangeDays` 动态

新增 `rangeLabel` computed(`1→'当天' / 7→'近 7 天' / 30→'近 30 天'`)。`cardTokenUnit` 拼为 `\`${rangeLabel} token\``(合并缓存读取时追加「(含缓存读取)」)。`chartSubtitle` 把原来写死的 `近 ${DAYS} 天` 换成 `近 ${rangeLabel}`/`${rangeLabel}` 措辞。

### 决策 4:统一筛选 UI 放页面 header,用 `ElRadioGroup`/`ElRadioButton`

时间筛选是高频、档位少(3 档)、需一眼可见的全局控件,用分段按钮(`ElRadioButton`)比下拉更直观,且与趋势图已有的 `metric` 分段控件风格一致。放在 `.aip-usage__page-header` 的 `heading-actions` 区(刷新按钮一侧)或紧随 header 的独立筛选行。会话模块内的那枚 `ElSelect`(时间范围)整条删除。

### 决策 5:localStorage 持久化,键 `aipt:ai-usage:range-days`

复用页面已有的 `mergeCacheRead` 持久化范式(try/catch 读写、不可用静默降级)。读不到 / 非法值回退默认 `7`。

**默认档定为「近 7 天」**:介于原卡片(当天)与原趋势(14 天)之间的折中,且为三档的中间档,体验上最稳妥。

## Risks / Trade-offs

- [「当天」档趋势图只有 1 个数据点,折线退化为单点] → 可接受;`AuroraLineCard` 单点正常渲染,必要时文案已用副标题点明「当天」。
- [卡片由 `today` 改为 series 求和,若 series 与 today 聚合口径存在历史细微差异] → series 与 today 同源同 `bucketToView`,`rangeDays=1` 时同为今天桶,数值一致;已被现有 store 单测覆盖。
- [`rangeDays` 变更触发 `load()` + `loadProjectOptions()` + `loadSessions()` 三连请求] → 与现有「平台/范围变更」已有的双请求量级相当,且都是同源本地 daemon,开销可忽略;沿用既有防越界复位分页逻辑。
- [移除会话自带下拉属交互层 BREAKING] → 仅本页内交互收敛,无数据/接口破坏;用户心智上更一致。

## Migration Plan

纯前端单文件改动,随看板 SPA 构建(`pnpm --filter @ai-productivity-tracker/ui build` → 产物落 `packages/cli/dist/web/`)发布,daemon 静态托管刷新即生效。无数据迁移。回滚 = 还原 `AiUsageTab.vue` 单文件。

## Open Questions

- 默认档「近 7 天」是否符合预期(也可选「当天」对齐原卡片直觉)?—— 已按折中决策默认近 7 天,可在评审时按用户偏好调整。
