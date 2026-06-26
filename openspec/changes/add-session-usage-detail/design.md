## Context

「会话用量明细」由会话维度 store(`packages/core/src/store/session-usage-store.ts`,落盘 `session-usage.json`,key=`${source}:${sessionId}`)支撑:`accumulateSessionUsage` 在 `recordUsage` 内、整体用量开关开启时被 tee 一次,**每条 `AiUsageEvent` 累加一次**(`rec.turns += 1`、token 求和)。当前 `SessionUsageRecord` 只保留会话级标量(`total/turns/toolCalls` + 最近一次 `model` + 首条 `title` + 时间窗 `firstAt/lastAt`),**完全没有逐轮明细**——每轮的 token、模型、标题、时刻都被合并掉了。

看板侧 `AiUsageTab.vue` 拉 `GET /ai-productivity/session-usage` 渲染 `SessionUsageRow.vue`,每行用量条调 `UsageBar` 且 `color-mode="absolute"`(`usage-bar-logic.ts` 按 token 绝对值 150K/300K 三档取 `--aipt-usage-low/mid/high`)。标题在 `truncateTitle`(`TITLE_MAX_LEN=80`)采集 / 入库 / 出库三处截断。

约束:

- `AiUsageEvent`(`ai-usage-store.ts:50`)每轮携带 `source/sessionId/turnId?/model?/tokens/toolCalls?/title?/at`,但**无时长 / 思考时间字段**——每轮只有时间戳 `at`。
- 行为契约对 `session-usage` 的采集口径冻结:不改 `recordUsage` 旁路时机与全局开关守卫。
- `session-usage.json` 单文件,既有 30 天 / 1000 会话治理(`pruneSessions`)。

另有一套「需求维度」`iteration-store`(逐轮含 `modelName/cumulativeToken/thinkSeconds/conversationSummary`),但仅覆盖含 Jira key 的分支、按需求目录组织、sessionId 口径不对齐,**不作为本期数据源**。

## Goals / Non-Goals

**Goals:**

- 点击会话行打开详情弹窗,逐轮展示:名称(该轮用户输入)、时长、本轮 token、模型,并为每轮渲染一根「占本会话总量比例」的进度条。
- 在 `SessionUsageRecord` 内追加逐轮明细数组,`accumulateSessionUsage` 每轮追加一项;新增按会话 key 拉取逐轮明细的查询端点。
- 标题与每轮内容素材记录完整内容(放宽 80 字符截断,保留去标签 / 压一行 / 安全上限护栏)。
- 外层会话列表用量条统一单色、仅以长度表达占比;绝对量三档配色下沉到详情弹窗逐轮进度条。
- 历史(上线前)无逐轮明细的会话安全兜底,绝不报错。

**Non-Goals:**

- 不改 `recordUsage` 旁路时机 / 全局开关守卫 / 三链路采集口径。
- 不打通 `iteration-store`,不依赖 Jira 需求维度数据补全逐轮明细。
- 不引入 per-turn 精确思考时间 / wall-clock 计时器(本期每轮时长由相邻轮时间戳差值近似)。
- 不改既有「会话用量条按列表总和占比」的长度归一化语义(仅改颜色)。

## Decisions

### D1:逐轮明细内联进 `SessionUsageRecord`(新增 `turnDetails[]`),每事件追加一项

`SessionUsageRecord` 新增可选数组 `turnDetails?: SessionTurnDetail[]`,`accumulateSessionUsage` 在 `rec.turns += 1` 的同处 `push` 一项:

```
interface SessionTurnDetail {
  at: string            // 该轮事件时间戳(ISO)
  total: number         // 本轮有效用量合计(input+output+cacheCreation)
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  toolCalls: number
  model?: string        // 本轮模型(best-effort)
  title?: string        // 本轮名称素材 = 该轮用户输入(去标签/压一行/完整内容)
}
```

- **为何内联而非 join 另一通道**:`session-usage` 覆盖全部会话(含 main / 非仓库),`iteration-store` 只覆盖 Jira 分支且 sessionId 不对齐;内联在同一会话记录里口径自洽、查询 O(1)。
- **为何「每事件 = 每轮」**:与既有 `rec.turns += 1` 完全同步,无需重新定义轮次边界。
- **备选**:单独 `session-turns.json` 文件 —— 多一处原子写 / 治理 / 读放大,排除。

### D2:每轮时长由相邻轮时间戳差值在「出库视图层」推导,不落盘

`AiUsageEvent` 无时长字段。详情查询时按 `turnDetails` 的 `at` 升序,令 `turn[i].durationMs = at[i+1] - at[i]`;**最后一轮**无后继 → 时长留空(展示 `—`)。

- 推导放在查询 / 视图层(详情端点),不污染落盘 schema,口径可后续无损调整。
- **明确近似性**:该时长是「相邻两轮事件的间隔」,含用户思考 / 空闲时间,**非纯模型耗时**;详情弹窗加一行口径说明,避免误读。
- **备选**:落盘显式 per-turn duration —— 需采集点补时长字段(三链路改造),成本高,本期排除(见 Open Questions)。

### D3:文件膨胀护栏 —— 逐轮条数上限 + 单条名称素材长度上限

逐轮明细 + 完整标题会放大 `session-usage.json`。两道护栏:

- **每会话 `turnDetails` 条数上限**(默认 `MAX_TURN_DETAILS`,如 500):超出按时间保留最近的(与会话级 `turns` 计数解耦——`turns` 仍累加真实总轮数,明细数组只留最近 N 项,详情弹窗对「明细被裁剪」给出说明)。
- **单条名称素材 / 标题长度安全上限**(`TITLE_MAX_LEN` 由 80 放宽到一个大上限,如 `4000`,仍 `slice` 兜底防御异常超长输入):正常对话完整保留,极端长输入被安全截断而非撑爆文件。
- 既有 30 天 / 1000 会话 `pruneSessions` 不变,与本护栏叠加生效。

### D4:新增详情端点 `GET /ai-productivity/session-usage/detail`,列表查询保持精简

新增 `GET /ai-productivity/session-usage/detail?key=${source}:${sessionId}`,返回该会话头部(标题 / 项目 / 分支 / model / 合计 / 时间窗)+ 逐轮明细数组(含 D2 推导时长 + 每轮占比)。

- **为何独立端点**:`querySessions` 列表一次返回 ≤1000 条,若每条内联 `turnDetails` 会数量级放大传输;详情按需单会话拉取。
- 端点归入 panel-origin 放行集合(同源免 token),与既有 `session-usage` 端点一致。
- key 不存在 / 无逐轮明细 → 返回空明细数组(`200`,非 404),前端走空态。

### D5:外层列表统一单色,绝对三档配色下沉到详情逐轮条

- **外层** `SessionUsageRow` 的 `UsageBar` 改为统一单色(取一个中性品牌色 token,如 `--aipt-usage-bar`),长度仍按既有「占当前列表总和比例」归一化(`session-usage-list-display` 的「按列表总和占比」要求不变)。
- **详情弹窗内**每轮进度条:长度 = `turn.total / session.total`,颜色复用 `usageColorVarAbsolute`(150K/300K 三档绿/橙/红),把「哪一轮绝对量重」直观呈现。
- 复用既有 `UsageBar` + `usage-bar-logic.ts`,不新造配色逻辑;「用量测算」页的相对比值配色完全不受影响。

### D6:标题 / 内容完整记录 —— 放宽 `truncateTitle` 默认上限

`truncateTitle` 保留去标签(`sanitizeTitle`)+ 压一行(`\s+→空格`)+ 占位判定,仅把默认截断上限由 80 放宽到 D3 的大安全上限。采集点(`transcript-watcher` / `codex-watcher`)与 store 入库 / 出库三处共用同一函数,口径一致地从「80 截断」变为「完整内容」。每轮 `title` 素材取该轮用户输入,同口径完整记录。

### D7:详情弹窗用 `ElDialog`,行点击打开;复用共享会话行

详情弹窗用 Element Plus `ElDialog`(用户表述为「弹窗」)。`SessionUsageRow` 整行可点击 `@click` 打开弹窗并传入会话 key;弹窗加载详情端点数据,头部复用会话行展示要素,主体 `v-for` 逐轮明细行(名称 / 时长 / model / token + 每轮配色进度条)。已有跳转 Jira 的 `@click.stop` 徽标防冒泡。

## Risks / Trade-offs

- [文件膨胀] 逐轮明细 + 完整标题放大 `session-usage.json` → D3 双护栏(明细条数上限 + 单条长度上限)+ 既有治理裁剪。
- [时长近似误读] 相邻轮间隔含空闲时间、末轮无时长 → D2 详情弹窗口径说明文案 + 末轮显示 `—`。
- [历史无明细] 上线前会话无 `turnDetails` → 详情端点返回空数组,弹窗空态提示「该会话无逐轮明细(本能力上线前记录)」,列表 / 会话级数据不受影响。
- [事件≠轮假设] 假设一条 `AiUsageEvent` = 一轮;若某链路一次 emit 多事件,明细粒度会比直觉细 → 与既有 `turns` 计数口径完全一致,不引入新偏差,文档标注。
- [外层配色回归] 移除外层绝对三档配色可能影响既有快照 → 改后更新 UI spec / 快照,跑 `pnpm test && pnpm lint && pnpm typecheck`。
- [标题变长展示] 列表行标题完整后需保持单行省略(`ellipsis`)不破版 → 列表行仍 CSS 截断展示,完整内容在详情弹窗呈现。

## Migration Plan

- **Schema 加性演进**:`turnDetails` 为可选字段,`normalizeRecord` 对缺失安全兜底为空 / `undefined`;旧 `session-usage.json` 无需迁移脚本。
- **上线后**:新事件开始写入 `turnDetails`;历史会话明细为空走空态,随新会话自然积累。
- **回滚**:回退代码即可;已写入的 `turnDetails` 字段对旧版 `normalizeRecord` 是未知字段被忽略,不破坏旧版读取(向后 / 向前兼容)。

## Open Questions

- 是否在后续版本让三链路采集点显式携带 per-turn 思考 / wall-clock 时长,替代 D2 的时间戳差值近似?(本期 Non-Goal。)
- `MAX_TURN_DETAILS` 与单条长度上限的具体阈值取值,是否需要做成可配置常量?(初版用默认常量,按 dogfood 体积观察再调。)
- 详情弹窗是否需要对每轮再下钻(展开完整对话内容)?当前仅展示一行名称素材 + 指标,完整内容已记录,后续可增强。
