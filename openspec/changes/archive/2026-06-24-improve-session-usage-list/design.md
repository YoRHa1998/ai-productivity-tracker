## Context

`add-session-token-usage` 已落地并上线(详见其 `proposal.md` / `design.md`):

- 会话维度数据落 `~/.ai-productivity-tracker/data/session-usage.json`,由 `recordUsage` 漏斗内 `accumulateSessionUsage(event)` 按 `${source}:${sessionId}` 累加(`packages/core/src/store/session-usage-store.ts`)。
- 标题素材取「会话首条用户输入」截断:Claude(`transcript-watcher`)/ Codex(`codex-watcher`)在轮边界捕获,Cursor(`buildCursorUsageEvent`)best-effort 读 `transcript_path` 首条 user 行。三处共用 `truncateTitle(text, max)`(折行压一行 + 截断 80)。
- 看板会话列表在 `tabs/AiUsageTab.vue`,每行嵌共享组件 `components/UsageBar.vue`(纯逻辑在 `usage-bar-logic.ts`):条长 `value/max`、配色按 `value/max` 比值落 `--aipt-usage-low/mid/high` 三档(`warn 0.33` / `danger 0.66`)。`max` 由父列表传「当前列表最大 total」。同一 `UsageBar` 还被 `tabs/UsageBenchmarkTab.vue` 复用。

真实使用暴露的问题(对应本变更 4 项):

1. **标题带包裹标签**:Cursor 把用户输入连同 `<timestamp>` / `<user_query>` / `<cursor_commands>` 等包裹标签一起写进 transcript,`readTranscriptTitle` 取到的首条 user 行就是 `<timestamp>...</timestamp> <user_query> 你好`,展示出来全是标签。
2. **配色相对最大值**:单条会话或数值相近时,`value/max ≈ 1`,整列泛红,无法表达绝对量级。
3. **条长相对最大值**:看不出「每个会话各占总消耗多大比例」。
4. **缺项目 / 分支**:记录里没有 project / branch,无法支撑后续分类与排序。

约束:`UsageBar` 为两页共享,`UsageBenchmarkTab` 行为必须零回归;`session-usage.json` 已有数据(含脏标题)需兼容;纯旁路新增,不改 daily 聚合与对外端点契约。

## Goals / Non-Goals

**Goals:**

- 会话标题只展示用户真实输入内容,剥离 IDE 注入的包裹标签;兼容已落盘脏标题(展示层兜底,免迁移)。
- 会话列表用量条配色改**绝对阈值**:`total ≥ 300K` 红、`150K–300K` 橙、`< 150K` 绿。
- 会话列表用量条条长改**占列表总和比例**:单条 100%,多条按各自 total 占总和比例。
- 会话记录持久化 `projectName` / `branch`,经查询视图透传,会话行轻量展示,为后续分类排序预留。
- `UsageBenchmarkTab` 共享组件默认行为不变;纯新增可选字段,无 BREAKING。

**Non-Goals:**

- 不做按项目 / 分支的分组聚合视图、筛选下拉与多列排序(本变更只「记录 + 透传 + 轻量展示」,为后续预留)。
- 不做标题语义脱敏 / AI 改写(仍是「截断片段」口径,只多一步去标签)。
- 不改 daily 聚合、`ai-usage.json` schema、MCP tool 与既有端点对外契约。
- 不为历史会话回填 project / branch(旧记录该两字段留空,仅新事件富化)。

## Decisions

### D1:标题去标签清洗 `sanitizeTitle`,采集 + 展示双侧兜底

新增 core 纯函数 `sanitizeTitle(text): string`,在 `truncateTitle` **之前**先剥标签,口径:

1. 若文本含 `<user_query>...</user_query>`,优先提取**最后一个** `<user_query>` 的内部正文(命令行 + 真实输入并存时,真实输入在 `<user_query>` 内)。
2. 否则移除已知**噪声标签块**(连内容):`<timestamp>…</timestamp>`、`<cursor_commands>…</cursor_commands>`、`<system_reminder>…</system_reminder>`、`<attached_files>…</attached_files>`、`<additional_data>…` 等(大小写不敏感、容忍未闭合)。
3. 再剥离任何**残留的成对 / 单个尖括号标签标记**(`<xxx>` / `</xxx>`),保留标签之间的可读文本。
4. 交给既有 `truncateTitle` 折行压一行 + 截断。

接入两处,保证新旧数据都干净:

- **采集侧(新数据)**:三条链路在 `truncateTitle(...)` 处改为 `truncateTitle(sanitizeTitle(...))`(或在 `truncateTitle` 内先调 `sanitizeTitle`,二选一,见下)。
- **展示侧(历史脏数据)**:`recordToView` 对落盘的 `rec.title` 再跑一次 `sanitizeTitle`(幂等),清洗已写入的旧脏标题——因 `title` 是「仅首次写入不覆盖」,光靠采集侧修不了存量。

**实现取舍**:把 `sanitizeTitle` 作为独立导出函数,`truncateTitle` 内部**首步调用** `sanitizeTitle`。这样三条采集点与 store / 视图全部经 `truncateTitle` 自动获得去标签能力,接入面最小、口径统一。代价:`truncateTitle` 语义从「压行截断」扩展为「去标签 + 压行截断」,更新其注释与单测。

**替代方案(否决)**:① 只在采集侧清洗 —— 修不了存量脏标题(write-once)。② 只在 UI 模板里清洗 —— 逻辑散落前端、无法单测、其它消费方(未来导出)拿到的仍是脏数据。③ 在 store 落盘时清洗 + 写迁移脚本 —— 需要一次性迁移且破坏「title 首次写入不覆盖」不变式,过重。展示层幂等清洗最稳。

### D2:`UsageBar` 解耦「条长分母」与「配色依据」,新增绝对配色模式

需求 2(绝对配色)与需求 3(条长按总和占比)要求**配色依据与条长分母不再是同一个量**:条长分母 = 列表总和,配色依据 = 会话绝对 total。故 `UsageBar` 配色不能再复用 `value/max` 比值。

`UsageBar` props 扩展(向后兼容):

```ts
{
  value: number
  max: number                         // 条长归一化分母(既有语义不变:width = clamp(value/max,0,1)*100)
  colorMode?: 'ratio' | 'absolute'    // 新增,默认 'ratio'(既有行为)
  thresholds?: UsageThresholds        // ratio 模式比值阈值(既有,默认 warn .33 / danger .66)
  absoluteThresholds?: UsageThresholds // absolute 模式绝对 token 阈值(默认 warn 150_000 / danger 300_000)
}
```

- **条长**:始终 `width% = usageWidthPct(value, max)`,语义不变。差异只在父组件传什么 `max`:
  - 会话列表(本变更):传 `max = Σ(列表各会话 total)` → `width = value/Σ` = **占总和比例**(单条 → max=value → 100%;5:3:2 → 50/30/20)。
  - `UsageBenchmarkTab`(不改):仍传 `max = 列表内最大 grandTotal` → 相对最大值,既有行为。
- **配色**:按 `colorMode` 分流(新增 `usageColorVarByMode`):
  - `ratio`(默认):`usageColorVar(usageRatio(value, max), thresholds)` —— 既有逻辑,benchmark 不动。
  - `absolute`(会话列表):新增 `usageColorVarAbsolute(value, absoluteThresholds)`:`value ≥ danger(300K)` → `--aipt-usage-high`;`≥ warn(150K)` → `--aipt-usage-mid`;否则 `--aipt-usage-low`。**绝对阈值与条长分母无关**,即使某会话条很短也能因绝对量大而显红。
- 新增绝对阈值常量 `DEFAULT_ABSOLUTE_USAGE_THRESHOLDS = { warn: 150_000, danger: 300_000 }`(用户口径:150K/300K),挂在 `usage-bar-logic.ts`,可被 props 覆盖。
- 颜色仍只引用既有设计 token `--aipt-usage-low/mid/high`,不新增色值。

**为何不另写组件**:两页都要「条 + 数值 + 三档色」,差异仅「分母语义 + 配色依据」,用 `colorMode` 开关比维护两个组件更省、口径更统一。

**替代方案(否决)**:① 给会话列表单独写 `SessionUsageBar` —— 重复样式与无障碍逻辑,易漂移。② 配色仍走 `value/max` 但 `max` 改传固定 300K —— 会让条长也变成「相对 300K」,与需求 3「占总和比例」冲突,无法兼得。解耦两者是唯一同时满足 2 + 3 的设计。

### D3:会话列表条长分母改「列表总和」

`AiUsageTab.vue` 把 `sessionMaxTotal`(当前 = `reduce max`)的**用途收窄**为仅给 benchmark 那类相对语义;会话列表新增 `sessionSumTotal = Σ totalTokens`,作为 `UsageBar :max`。

- 单条:`sum = value` → 100%。
- N 条:每条 `value/sum`,天然满足 5:3:2 → 50/30/20。
- `sum<=0`(空列表 / 全 0)时 `usageWidthPct` 既有兜底返回 `0.0%`,安全。
- **可读性兜底**:会话数较多时尾部条会很短,`UsageBar` track 已有 `min-width`,fill 视觉可能近乎不可见——接受(用户明确要「按比例」);可选给 fill 一个极小像素地板(如 2px)保证非零项可见,作为纯视觉增强,不改宽度计算口径。

### D4:`projectName` / `branch` 采集与持久化(纯新增可选字段)

- **`AiUsageEvent`** 增可选 `projectName?: string` / `branch?: string`(注释标注 daily 聚合不消费,向后兼容)。
- **采集点富化**(均 best-effort,失败留空,不阻断累加):
  - `transcript-watcher`:buffer 已有 `gitRoot` / `branch`,填 `branch = buf.branch`、`projectName = readProjectNameFromPackageJson(buf.gitRoot)`。
  - `codex-watcher`:同上,buffer 已有 `gitRoot` / `branch`。
  - `buildCursorUsageEvent`:`branch = body.branch`;`projectName` best-effort(若 hook body / 上下文可得 project root 则 `readProjectNameFromPackageJson`,拿不到留空)。
- **`SessionUsageRecord` / `SessionUsageView`** 增 `projectName?` / `branch?`;`accumulateSessionUsage` 对非空值**覆盖更新**(取最近一次,与 `model` 同策略;branch 切换属异常但不拦截,以最近为准)。`normalizeRecord` / `recordToView` 透传,`optStr` 兜底。
- **查询端点**:`querySessions` → view 透传新字段,端点契约纯增字段,放行集合与排序参数不变。
- **看板**:会话行 meta 区(已有 source / model / 时间窗 / 轮次)追加 `projectName`、`branch` 两枚轻量标签(空则不渲染)。**v1 不加按项目 / 分支的筛选或排序控件**,仅展示 + 落库,为后续扩展铺路。

### D5:`UsageBenchmarkTab` 零回归保证

`UsageBenchmarkTab` 调用 `<UsageBar :value :max>` 不传 `colorMode` / `absoluteThresholds`,落入默认 `ratio` 模式 + 默认比值阈值 + `max=列表最大值`,与当前行为逐字节一致。本变更不改其任何调用点,纳入 UI 回归核对。

## Risks / Trade-offs

- [`sanitizeTitle` 误删真实含尖括号的用户输入(如贴了 HTML / 泛型 `Array<T>`)] → 优先走「提取 `<user_query>` 正文」分支(命中即只取其内,不再全局剥标签);仅在无 `<user_query>` 时才做通用剥标签,且只剥「闭合或已知噪声标签」,降低误伤;单测覆盖含 `<` 的正常文本。
- [展示层每次 `recordToView` 跑 `sanitizeTitle` 的开销] → 列表默认 ≤50 条、纯字符串正则,开销可忽略;清洗幂等,不污染落盘数据。
- [条长按总和占比导致多会话时尾条几乎不可见] → 接受(符合需求);可选 fill 像素地板做视觉兜底,不改口径。
- [`colorMode` 默认值选错会回归 benchmark] → 默认 `ratio` = 既有行为,且 benchmark 调用点不传该 prop;单测断言默认模式取色与改前一致。
- [`branch` 中途切换 / 同会话跨分支] → 以最近一次非空为准(覆盖语义),属边界场景不拦截;`firstAt/lastAt` 仍表达真实时间窗。
- [`projectName` 取 `package.json name` 与「需求 projectSlug」口径需一致] → 复用既有 `readProjectNameFromPackageJson`,与 init 流程同源,避免口径分裂。
- [Cursor 链路 `projectName` 可能拿不到] → 接受 best-effort 留空;Claude/Codex 命中率高(buffer 直接持有 gitRoot)。

## Migration Plan

- 纯新增:`sanitizeTitle` 函数 + `truncateTitle` 内调用、`UsageBar` 新 props 与绝对配色逻辑、`AiUsageEvent` / `SessionUsageRecord` / `SessionUsageView` 可选字段、采集点富化、`AiUsageTab` 会话列表分母 / 配色 / 标题 / meta 调整。
- 历史脏标题靠 `recordToView` 展示层清洗,无需数据迁移;`session-usage.json` 旧记录无 `projectName` / `branch` 安全留空。
- 回滚:撤回上述前端 / core 改动即可;落盘新增字段残留无害。
- 发版:沿用 `pnpm release prerelease --publish` 叠 rc;回归 `pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`。

## Open Questions

- 会话行是否需要在 v1 就把 `projectName` 做成可点击筛选(跳到该项目的会话子集)?当前判定为后续迭代,本变更只展示。
- 绝对阈值 150K/300K 是否需要做成用户可配置(看板设置项)?v1 定为模块常量 + props 覆盖,暂不暴露 UI 配置。
- 多会话时是否启用 fill 像素地板(2px)做可见性兜底?留待实现期按真实视觉效果定夺。
