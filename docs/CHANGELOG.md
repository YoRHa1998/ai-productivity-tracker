# Changelog

本文件记录 `@ai-productivity-tracker/cli` 独立项目的所有版本变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/);格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 源项目 `instant-web-tools` 内 AI 提效面板模块的历史变更(v2.0 ~ v2.18.x)归档在
> `specs/modules/ai-productivity-tracker/change_log.md`,本仓库 v1.x 从那里继承全部行为契约。

---

## [Unreleased]

### Added

**Codex CLI 完整集成(对话数据抓取 + 来源/模型标签 + 软数据通道)**

新增对 OpenAI Codex CLI 的支持,从此跨 Cursor / Claude Code / Codex 三类客户端统一采集 AI 编码会话数据。

- **硬数据抓取(CodexWatcher)**:新增 `packages/core/src/codex-message.ts`(逐行解析 `session_meta` / `turn_context` / `event_msg(token_count|task_started|user_message|task_complete)`)+ `packages/core/src/codex-watcher.ts`,监听 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(日期三层嵌套,recursive watch + 30s 周期扫),按 `turn_id` 聚合、`task_complete` flush 出 `source: 'codex'` 的 iteration。token 口径用 `total_token_usage` 累计差(`input − cached_input + output`),与 Claude effectiveTokens 对齐且天然防重复计数;per-session 累计基线持久化到独立 `~/.ai-productivity-tracker/data/codex-state.json`,跨 daemon 重启不双算。daemon `startDaemon` 起停 CodexWatcher,受同一 `AIPT_DISABLE_TRANSCRIPT_WATCHER` 开关。
- **source='codex' 全链路**:`IterationSource` / `pending-summary` VALID_SOURCES / server `attach_summary` 校验 / `mapHookSource('codex-hook')` / mcp `z.enum` / `LessonExtractedBy` / `RetrospectiveSource` / UI `api.ts` 三处 union 全部加 `codex`。`normalizeIterationSource` lazy 兼容,老数据不受影响。
- **看板对话详情**:来源 chip 从「cursor vs 兜底 claude」二元改为三态映射(`cursor` / `claude-code` / `codex`),新增 `.aip-chip--source-codex` 配色;模型标签复用既有灰底 chip 直接显示 `gpt-5.5` 等 Codex 模型名。`LessonsTab` SOURCE_LABEL 加 `codex: 'Codex'`。
- **软数据通道(aipt install 新增 codex target)**:
  - MCP 注册:`~/.codex/config.toml`(TOML),新增 `codex-mcp-config.ts` 外科式文本 upsert,只替换 `[mcp_servers."ai-productivity-tracker"]` 一个表块、其余字节原样保留,写前备份 `.bak`;零 env(`aipt mcp` 自读 runtime.json)。
  - Hook 注入:`~/.codex/hooks.json`(Claude 同构 schema)的 `UserPromptSubmit` reminder + `Stop` stop-check,marker 式覆盖、严格保留 codeisland / loongsuite 等其它工具条目。
  - Skill 模板:`~/.codex/skills/{ai-productivity-track,lessons-extract,retrospective-report}/SKILL.md`(source=codex)。
  - `aipt install --ide=codex`(及 `all`)与看板「一键注入」均覆盖 codex;stop-check `detectDialect()` 把 Codex Stop(无 cursor_version、带 cwd/session_id)归为 claude-code 方言输出 `{decision:'block'}`,`resolveTrackingContext` 用 payload `cwd` 兜底解析 jiraKey。
- **测试**:新增 `codex-message.spec.ts` / `codex-watcher.spec.ts`(单轮 / 多轮累计 token / cached 排除 / 非 Jira 分支 / 非 git / 未 init / stale flush / 跨 processFile) + `codex-mcp-config.spec.ts`(TOML upsert 保留其它表)+ stop-check Codex 方言用例。全量 869 测试通过,lint / format / typecheck 全绿。

> 用户侧一次性摩擦:Codex hooks 首次需 `/hooks` review & trust,MCP 需 trust。

**v1.0.0-rc.26 需求级 wThink 时间权重配置(snapshot-on-init 语义)**

老版本 `formula.json` 是**全局单值**:无论 5 条并行需求还是 1 条串行需求,boost 公式分母里 AI 工作时间 / 墙钟时间的权重比例只能取同一个 wThink。但实际开发情况各不相同 —— 有的需求长期单线程(墙钟 ≈ 真实成本),有的需求穿插在多任务里(墙钟严重膨胀,必须靠 AI 工作时间矫正)。一刀切的全局 wThink 让用户在「调高 = 多任务需求准 / 串行需求虚高」与「调低 = 串行需求准 / 多任务需求被低估」之间二选一。

本版本把 wThink 升级为**需求级独立配置**,语义采用 **snapshot-on-init**:

- 新建需求时,daemon 自动把当下全局 `formula.json.wThink` **整体快照写入** `requirement.json.formulaWThinkOverride`(新字段,number ∈ [0,1])
- 之后调全局 wThink **不再回写** 已存在的需求,只影响后续新建需求
- 详情抽屉新增独立卡片「提效公式(本需求)」,只放 wThink 滑块,直接调 `PATCH /ai-productivity/requirements/:jiraKey { formulaWThinkOverride }` 保存
- 保存后 daemon 重新计算该需求的 boost / effectiveMinutes,UI 抽屉指标卡片实时联动刷新
- `tokenPenaltyEnabled` / `tokenSoftCapK` 不进入需求级,仍在设置页全局配置(单需求场景对 token 软上限的精调需求较弱)

**老数据兼容**:rc.26 之前创建的 requirement.json 缺 `formulaWThinkOverride` 字段 → daemon load 时默认 null → `buildSummaryView` 回退到全局 wThink 计算 boost,展示一致;用户首次在详情页编辑后即固化为具体数值,与新需求行为对齐。

**改动清单**:

- **core**:
  - `packages/core/src/store/requirement-store.ts`:`StoredRequirement` 新增 `formulaWThinkOverride: number | null`(默认 null);老 requirement.json round-trip 兼容
  - `packages/core/src/metrics.ts`:`buildSummaryView` 接收 `globalFormula`,内部合并出 `effectiveFormula = { ...globalFormula, wThink: override ?? globalFormula.wThink }` 传给 `computeMetrics`;`RequirementSummaryView` 新增 `formulaWThinkOverride` + `effectiveFormula` 字段,供前端直接渲染当前生效值
- **server**:
  - `packages/server/src/routes/ai-productivity.ts`:`handleAiProductivityInit` 在 `saveRequirement` 入参里把 `formulaWThinkOverride: readFormula().wThink` 一起写入(snapshot)
  - `PatchRequirementBody` 加 `formulaWThinkOverride?: number | null`,handler 内 clamp 到 [0,1] + 显式 null 走清除路径
- **ui**:
  - `packages/ui/src/api.ts`:`RequirementSummary` 类型扩展(`formulaWThinkOverride` + `effectiveFormula`);`patchRequirement` 形参扩展 `formulaWThinkOverride: number | null`
  - `packages/ui/src/tabs/AiProductivityTrackerWorkspaceTab.vue`:在「指标」与「关联 Bug」之间插入独立卡片「提效公式(本需求)」,只暴露 wThink 滑块 + 「AI 工作 X% · 墙钟 Y%」实时回显 + 「保存权重」按钮(脏检查决定 disabled);保存后 `getRequirementDetail` + `loadList` 并行刷新让抽屉指标与列表 boost 立刻联动;「加权耗时」tile 的 hover tooltip 补当前生效 wThink
- **测试**:
  - `requirement-store.spec.ts` +2 用例(字段 round-trip + 老数据兜底为 null)
  - `metrics.spec.ts` +3 用例(override 改变 boost / null 回退全局 / 越界 clamp)
  - `ai-productivity.spec.ts` Panel handlers +2 用例(init snapshot 全局当下 wThink / PATCH 写入+null 清除+clamp)
- **文档**:
  - `docs/DATA-MODEL.md` requirement.json schema 补 `formulaWThinkOverride` 字段说明
  - 本 CHANGELOG 条目

**回归**:`pnpm test`(823/823) / `pnpm typecheck` / `pnpm lint` / `pnpm format:check` 全绿。

### Fixed

**v1.0.0-rc.26 ElButton type+link 组合被 override 强加 chip 风格(复盘经验列表「删除」按钮视觉修复 · 同 rc 一起发)**

复盘经验 Tab 列表「操作」列的「删除」按钮(`<ElButton type="danger" link>`)显示成淡红色背景 + 红色描边 + 圆角胶囊,跟周围的玻璃极光 chip 撞设计语言,看起来像一个独立小标签。

根因:`element-overrides.css` 里 `.el-button--danger` / `--success` / `--warning` / `--primary` 选择器没有排除 `.is-link` / `.is-text`,导致所有带 type 的文字 / 链接按钮都被强行叠加实心 type 样式(背景 + 描边),把本应"零视觉重量"的 link 按钮渲染成了 chip。

修复:把这几个 type override 改成 `:not(.is-link):not(.is-text)`,让背景 / 描边只作用于实心和 plain 按钮。link / text 按钮保持透明背景 + 透明描边,只继承文字色;同时为它们补上 `.is-link.el-button--danger` / `--success` / `--warning` 的红/绿/橙文字色 + 极淡 hover 背景,跟整体玻璃 chip 风格保持一致,且 light 主题下也能读得清。

唯一关联改动:`packages/ui/src/styles/element-overrides.css`。无 schema / API / 依赖变化;`pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format:check` 全绿。

**v1.0.0-rc.25 图表文字在浅色主题下看不清(对比度修复)**

复盘报告的雷达图维度名(「AI 思考密度」「提效倍率」「关键文件集中度」等)、iteration 阶段时间线 Y 轴刻度数字、累积曲线坐标轴 label,在浅色主题下几乎贴近白底融化,雷达图维度名甚至完全读不出。

根因:所有 echarts 图表 option 里把 `rgba(220,224,235,...)` / `rgba(255,255,255,0.45)` 这类**只适配深色背景**的灰白色硬编码到 `axisLabel` / `nameTextStyle` / `axisLine` / `splitLine` 上。看板支持 `data-theme=light` 切换(`tokens.css` 里 `--aipt-text-*` 走对应色阶),但 echarts 不消费 CSS 变量,硬编码字色无法跟随主题翻转。

修复:抽出 `useChartTheme` composable 集中管理图表配色,按 `useTheme().resolvedTheme` 返回三档文字(`text` 主刻度 / `subtle` 次要 / `faint` 网格) + tooltip + 切片描边 token,所有图表 option 引用 token 而不是写死颜色。深色保持原视觉,浅色字色刻意比 `--aipt-text-*` 略深一档,避免被玻璃面板的渐变背景"吃"掉。

改动清单:

- `packages/ui/src/composables/useChartTheme.ts` 新增,`DARK_TOKENS` / `LIGHT_TOKENS` 两套
- `RadarMetric.vue`:`axisName` 改用 `t.text` + `fontWeight: 600`,5 维标题在浅色下也保持清晰
- `IterationPhaseTimeline.vue`:`xAxis/yAxis.axisLabel`、`nameTextStyle`、`splitLine`、`axisLine`、tooltip 全部主题感知;未分类柱子颜色从硬编码 `rgba(255,255,255,0.18)` 改 `t.axisLine`(浅色自动变深,不再"消失")
- `RetrospectiveReportPanel.vue` 内联累积曲线:双 Y 轴 label / name、legend、splitLine 全部主题感知
- `DonutMetric.vue`:tooltip + 切片描边色(`rgba(7,10,20,0.6)` → `t.panelBg`,浅色变近白色)
- `AuroraLineCard.vue`(工作区 tab):同样接到 `useChartTheme`,XY 轴 label / legend / 轴指示器全部跟随主题

无 schema / API 变化,无 npm 依赖变化;`pnpm typecheck` / `pnpm test`(816/816) / `pnpm lint` / `pnpm format:check` 全绿,UI 产物体积持平。

### Added

**v1.0.0-rc.23 单需求复盘报告(retrospective)**

把前期已采集的 iterations / boost / churn / 关联 lessons / 异常 stop 等数据,在「需求结束时」集中产出一份结构化复盘叙事 + 多维图表,让搜集到的硬数据真正发挥价值。

**架构(零云端,沿用 lessons-extract 双 MCP tool 模式)**:LLM 推理 100% 在 IDE 内 agent(Cursor / Claude Code)进行,daemon 不调任何外部 LLM API。

```
用户在 IDE「需求复盘 当前需求 INSTANT-XXXX」
   ↓
LLM 命中 retrospective-report skill
   ↓ ai_productivity_extract_retro_bundle  → GET /requirements/:jiraKey/retrospective-bundle
   ↓ daemon 复用 buildLessonsBundle + 加 relatedLessons + existingRetrospective
LLM 推理 → narrative(overview / phases / highlights / issues / improvements / pitfalls / nextSteps / splitSuggestions)
   ↓ ai_productivity_save_retrospective  → POST /requirements/:jiraKey/retrospective
   ↓ snapshot / generatedAt / generatedAtIterationSeq 由 daemon 自动注入,LLM 即便传也会被忽略
看板「需求详情 → 复盘报告」tab 同源直读
```

**改动清单**:

- **core**:`packages/core/src/store/retrospective-store.ts`(load / write / remove / buildBundle + computeRetrospectiveSnapshot)+ `paths.ts` 新增 `retrospectivePath` helper
- **server**:`packages/server/src/routes/ai-productivity.ts` 新增 4 个 handler(GET / POST / DELETE retrospective + GET retrospective-bundle),`server.ts` 注册路由(panel-origin 放行 = 看板免 token,Bearer token 鉴权也兼容,与 lessons 同款语义)
- **mcp**:`packages/mcp/src/tools.ts` 新增 2 个 tool(`ai_productivity_extract_retro_bundle` / `ai_productivity_save_retrospective`),配套 `agent-client.ts` 通道方法 + zod 入参校验。从「5 个 tool」升到「7 个 tool」
- **skill 模板**:`packages/core/src/track-skill-templates.ts` 新增 `RETROSPECTIVE_CLAUDE_CONTENT` / `RETROSPECTIVE_CURSOR_CONTENT` 双方言模板 + `RETROSPECTIVE_SKILL_VERSION = '1.0.0'`,`packages/server/src/skill-sync.ts` 扩展 `inspectAiTrackSkillBundle` / `installAiTrackSkillBundle` 一并装入 `~/.claude/skills/retrospective-report/` + `~/.cursor/rules/retrospective-report.mdc`,`aipt install` 命令日志同步追加
- **ui**:
  - `packages/ui/src/api.ts` 新增 `getRetrospective` / `deleteRetrospective` + 类型 `StoredRetrospective` / `RetrospectiveNarrative` / `RetrospectiveSnapshot` / `RetrospectivePhase`
  - 新增依赖 `markdown-it@^14.2.0`(~40KB,`html: false` + 禁 image + linkify + 强制 a 加 target=\_blank,等价 sanitize),`packages/ui/src/lib/markdown.ts` 封装 `renderMarkdown` / `renderMarkdownInline`
  - 新增组件 `packages/ui/src/charts/RadarMetric.vue`(5 维雷达)+ `packages/ui/src/charts/IterationPhaseTimeline.vue`(阶段时间线条形图);`charts/echarts.ts` 同步注册 `RadarChart` / `BarChart` / `RadarComponent`
  - 新增 `packages/ui/src/tabs/RetrospectiveReportPanel.vue`:空态(复制触发口令)+ 有报告态(hero / 4 图表 / markdown 叙事 collapsible / 引用 lessons 卡片 / 锚点 iterations)
  - `packages/ui/src/tabs/AiProductivityTrackerWorkspaceTab.vue` 抽屉重构为 `<ElTabs>`,2 个 ElTabPane(「需求概览」+「复盘报告」),抽屉宽度 780→880;原 4 段卡片(boost hero / 指标 / 关联 Bug / iteration 时间线)原样搬入「需求概览」tab,业务 0 改动
  - `packages/ui/src/tabs/AiProductivityTrackerLessonsTab.vue` 接受 `?focus=<lessonId>` query 参数预选,让复盘 panel 引用经验跳转后自动打开对应 detail drawer
- **数据模型**:`docs/DATA-MODEL.md` 新增 §7.5 `data/<JIRA-KEY>/retrospective.json` schema(`schemaVersion=1`,单文件覆盖,带 `generatedAtIterationSeq` 快照锚点)
- **PRD**:§12 路线图拆分,新增 §12.1 单需求复盘报告 实施段 + V15-V20 验收用例

**与 lessons 的协同(职责单一)**:

- 复盘报告 = 看板叙事产物(per-feature,单文件覆盖)
- lessons-extract = 跨需求知识条目沉淀(平铺,跨需求自动合并去重)
- LLM 在复盘 narrative 中通过 `referencedLessonIds` 弱引用本需求已沉淀的 lesson;**严禁在复盘里直接落新 lesson**(用户想沉淀经验仍走 lessons-extract skill)

**测试覆盖**:

- core: `retrospective-store.spec.ts` 17 例(读写 / 覆盖 / 缺字段兜底 / schemaVersion 升级保护 / 字段长度静默截断 / 悬挂 lesson id / 越界 anchorSeq 过滤 / `buildRetrospectiveBundle` 三种场景)
- server: `ai-productivity.spec.ts` 新增 13 例 retrospective handler(panel-origin / token 鉴权,200 / 400 / 404 路径,覆盖式更新,空 narrative 拒收)
- mcp: `tools.spec.ts` 新增 4 例 + `agent-client.spec.ts` 新增 2 例(extract_retro_bundle / save_retrospective 透传 + 错误 isError + RETRO_BUNDLE_JSON 文本化)
- skill-sync: `skill-sync.spec.ts` 新增 2 例(install 写文件 + inspect 状态报告)
- ui: `lib/markdown.spec.ts` 11 例 sanitize / linkify / breaks 单测

**不做的事**(留给 v1.x):跨需求全局复盘报告 / 报告导出 MD/HTML / 多版本历史快照 / status=finished 自动触发。

### Changed (Breaking)

**v1.0.0-rc.22 提效公式精简 + 并行多任务场景修正**

旧公式 `boost = manualEstimateMinutes / (elapsedMinutes × bugPenalty × tokenPenalty)` 在**并行开发多个 Jira 需求**时严重偏低:`elapsedMinutes` 是任务从 init 到现在的墙钟耗时,只要任务还没结束,墙钟就会持续累加,即使用户把绝大多数时间花在其它分支;同时 `tokenPriceUsdPer1k` × `hourlyCostUsd` 这一对参数在不同模型 / 订阅下不可比,业务上很难解释。

本期把公式收敛为「加权耗时 + 可选 Token 软上限」两因子:

```
thinkMinutes      = totalThinkSeconds / 60   # 累加每轮 turn wall time,剔除空闲
effectiveMinutes  = (1 − wThink) × latestElapsedMinutes + wThink × thinkMinutes
tokenPenalty      = tokenPenaltyEnabled && tokenSoftCapK > 0
                    ? 1 + max(0, latestCumulativeToken/1000 − tokenSoftCapK) / tokenSoftCapK
                    : 1
boost             = manualEstimateMinutes / (effectiveMinutes × tokenPenalty)
```

`formula.json` schema 由 4 字段(`kBug` / `kToken` / `tokenPriceUsdPer1k` / `hourlyCostUsd`)替换为 3 字段(`wThink` / `tokenPenaltyEnabled` / `tokenSoftCapK`),默认值 `0.7 / false / 200`。`linkedBugCount` 不再进入公式,只在「关联 Bug」区块展示。`RequirementMetrics` 同步移除 `bugPenalty`,新增 `effectiveMinutes`(同时保留 `tokenPenalty` 但语义变更:仅可选 token 软上限,默认恒为 1)。

**迁移**:零操作。`readFormula` 静默丢弃老 4 字段;`writeFormula` 下次保存覆盖成新 schema。已落盘的 `iterations.jsonl` / `requirement.json` 无 schema 变化,所有历史 boost 在下次读取时按新公式自动重算。

**用户感知**:设置页公式卡片从 4 个 InputNumber 改成「1 滑块(AI 工作时间权重 ∈ [0,1])+ 1 开关(token 惩罚)+ 1 软上限输入」;需求详情指标格的「Bug 惩罚」替换为「加权耗时」,直接展示分母拆解,boost 推导一目了然。

### Added

**v1.0.0-rc.18 Cursor 链路 `thinkSeconds` 精准化:接入 `beforeSubmitPrompt` / `afterAgentThought` 两个 hook 事件**

旧版 Cursor `afterAgentResponse` 单点没有本轮起点信号,只能用「上一次 hook → 本次 hook」近似 thinkSeconds + 60s
cap(`ACTIVE_GAP_SECONDS_CURSOR`)。对 `claude-opus-4-7-thinking-xhigh` 等 thinking 模型,实测一次 turn 真实 wall
time 常态 60s ~ 5min,被 60s cap 大量截断 — INSTANT-5321 近 9 条 iteration 抽样 5 条严格 = 60s。看板表象就是
「AI 思考时间普遍在 1m 中以内,实际更久」。

本期接入 Cursor 3.5.x 已支持的两个 hook 事件,把这块口径补到 Claude Code 同等精度:

- **`beforeSubmitPrompt`**:用户提交 prompt 瞬间触发,带 `conversation_id` / `generation_id`,记录本轮真实起点。
- **`afterAgentThought`**:每个 thinking 块结束触发,带 `duration_ms`,累加得「纯模型思考时间」。

链路:

1. daemon 新增 `POST /ai-productivity/turn-start` / `/turn-thought` 端点,内存 Map `cursorTurnStarts` 按
   `${conversation_id}|${generation_id}` 暂存 `{ startedAt, thoughtDurationMs }`,FIFO 上限 200、30min TTL 过期清理。
2. `aipt hook` 入口按 `hook_event_name` 分流到 turn-start / turn-thought / iteration 三条 daemon 路径。
3. `afterAgentResponse` 路径消费对应 entry,把 `turnStartedAt` + `pureThinkSeconds` 透传给 `buildIterationExtras`
   → iteration 落盘时 `thinkSeconds` 走真实 wall time(沿用 300s cap),并新增 `pureThinkSeconds` 字段。
4. `install-cursor-hook` 同步把 `beforeSubmitPrompt` + `afterAgentThought` + `afterAgentResponse` 3 个事件并行
   注入 `~/.cursor/hooks.json`,marker `# ai-productivity-hook` 共用,旧 daemon / 老 hook 走 60s fallback 兼容。
5. 看板 timeline 「本轮 AI 思考」加 hover tooltip,wall time + 纯思考双行展示;纯思考字段缺失(Claude Code / 老
   数据)时仅显示 wall time。

向前兼容:`StoredIteration.pureThinkSeconds` / `IterationRow.pureThinkSeconds` 都是可选字段,老数据反序列化
保留 `undefined`,UI / boost 公式零影响。`inspectCursorHook` 返回 `perEvent` 子结构,任一事件缺失则
`hookInstalled=false`,看板/doctor 据此精准提示「缺哪条」。

用户升级路径:`npm i -g @ai-productivity-tracker/cli@latest` → `aipt install` → 重启 IDE。
新写入的 hooks.json 同时含 3 个事件,marker 覆盖式更新,不影响其它 IDE 工具条目。

测试覆盖:

- `hook-core/src/hook.spec.ts` 新增 `classifyHookEvent` 6 例用例
- `hook-core/src/install-cursor-hook.spec.ts` 既有 3 例改造 + 新增「仅装老 afterAgentResponse → hookInstalled=false」
- `server/src/routes/ai-productivity.spec.ts` 新增 `handleAiProductivityTurnStart` / `handleAiProductivityTurnThought`
  共 9 例 + `handleAiProductivityHook + cursorTurnStarts 联动` 2 例端到端(命中真实 180s wall + 4s 纯思考;无命中 60s fallback)
- `core/src/iteration-extras.spec.ts` 新增 pureThinkSeconds 透传单测
- `core/src/store/iteration-store.spec.ts` `mergeIterationPair` 补 pureThinkSeconds 合并 3 个边界

基线:710 例全绿(从 690 增量 20 例)。

### Fixed

**v2.14.1 `transcript-watcher` 60s `stale_timeout` 阈值过激,导致 Claude Code 经验提取 / 长 MCP 工具流程被切成多条 iteration**

实测现象(INSTANT-5321 一次「经验提取」对话):看板上同一次用户 prompt → end_turn 的对话(2026-05-26 07:55~08:01,
5min 41s)被切成 **#75 / #76 / #77 / #78 / #79 / #80 共 6 条 iteration**(#77 / #78 `triggerStopReason=stale_timeout`),
而 LLM 实际只主动调了一次 `attach_summary`,只有最后一条 #80 带 `conversationSummary`,前 5 条都是「无总结的孤立 coding 行」。
用户感知是「一次对话怎么上报了七八次」。

根因:`transcript-watcher.ts` 的 `STALE_TURN_FLUSH_MS = 60_000` 在两类正常间歇期被误触发:

1. **Claude Opus thinking + 多 MCP 工具调用单轮 turn 内长间歇**:实测 jsonl 行写入间隔 30~90s 是常态(LLM
   thinking → tool 执行 → 网络往返 → 用户确认 MCP 权限弹窗),60s 阈值频繁误判为"对话结束"。
2. **`msg.id` 主键去重路径不更新 buffer 时间戳**:Claude Code 把一次 API 响应拆成多行写 jsonl(thinking / text /
   tool_use 拆 2~3 行共享同 `message.id`),`routeMessage` 命中去重时 `return` 早退,**buffer.lastMessageTs 卡在最早的
   第一行**,后续散落 30~90s 的去重行无法续命,让 `flushStaleBuffers` 提前 30s+ 误判 stale。

修复(三处协同):

- **[`STALE_TURN_FLUSH_MS`](../packages/core/src/transcript-watcher.ts) 60s → 30min**:既覆盖正常长流程,
  又保留「Claude Code 真异常退出永远写不出 end_turn / stop_hook_summary」的兜底语义。最坏 30min + 30s 内一定 flush,
  避免内存中孤立 buffer 永久泄漏。
- **新增 `PendingTurn.lastSeenAt` 字段**,与 `lastMessageTs` 解耦:任何同 sessionId 的 jsonl 行(包括 `msg.id` 去重
  丢弃的重复行 + `fingerprint` 兜底去重丢弃的行 + 独立的 `user` 行)都通过新加的 `markSessionActive()` 刷新它。
- **`flushStaleBuffers` 改用 `lastSeenAt`** 判定闲置;`reportedAt` / `triggerMessageUuid` 仍走 `lastMessageTs`,
  thinkSeconds / rawPayload 语义不受影响。

测试覆盖:`transcript-watcher.spec.ts` 新增 `v2.14.1 stale_timeout 阈值放宽 + lastSeenAt 解耦` describe 块,
2 条用例:

1. 经验提取真实时序回归(5min 多 tool_use + 4 组 msg.id 拆分行 + 长间歇,以 end_turn 收尾 → 期望仅 1 行 iteration)
2. dedup 行刷新 lastSeenAt 验证(29min 散落 msg.id 重复行 → 不触发 stale flush)

旧测试 `buffer 闲置 > 60s 强制 flush` 同步更名为 `buffer 闲置 > 30min 强制 flush`,断言时间窗调整。

---

**`aipt install` 漏注入 Claude Code 的 MCP 配置(`~/.claude.json`),Claude Code 用户看板永远拿不到 MCP 数据**

实测现象:用户在 Claude Code 里跑 `aipt install` 后,Cursor 看板正常,但 Claude Code 端 MCP 始终不可用 ——
`claude mcp list` 找不到 `ai-productivity-tracker`,看板 Iteration 列表无 Claude 来源数据。

根因:[`packages/cli/src/commands/install.ts`](../packages/cli/src/commands/install.ts) 的 Step 1 写 MCP 配置
时硬编码只走 `runInstallMcp({})` → 默认写 `~/.cursor/mcp.json`,**完全没处理 `--ide=claude` / `--ide=all` 分支**。
Claude Code 的 MCP 配置实际存在 `~/.claude.json` 顶层 `mcpServers` 字段(不是 `~/.claude/` 目录里),
entry 还必须带 `type: "stdio"`(缺失时 claude-code CLI 跳过该条目)—— 这些细节之前完全没覆盖。

修复:

1. **[`packages/cli/src/commands/install-mcp.ts`](../packages/cli/src/commands/install-mcp.ts) 引入双 target**:
   - 新增 `InstallMcpTarget = 'cursor' | 'claude'` 与默认路径 `defaultMcpJsonForTarget()`
   - Cursor entry 不带 `type`(向后兼容,Cursor 不识别此字段);Claude entry 自动带 `type: 'stdio'`
   - Claude 文件用 `mode=0600` 写盘(`~/.claude.json` 默认私有,可能含 Jira API token 等敏感 env)
   - 仍保留对历史老 key `ai-productivity` 的清理(两个 IDE 都做)
   - 新增聚合入口 `runInstallMcpAll({ ide })`:`'all'`(默认)同时写两侧,任一失败不阻断另一个

2. **[`install.ts`](../packages/cli/src/commands/install.ts) Step 1 调用聚合入口**,根据 `--ide` 决定写一侧或两侧
3. **CLI argv-router**:`aipt install-mcp` 新增 `--ide=cursor|claude|all` 参数(默认 `all`),保持与 `aipt install` 行为一致
4. **[`doctor.ts`](../packages/cli/src/commands/doctor.ts) 新增第 6 项**「Claude mcp.json」体检 ——
   检测 `~/.claude.json` 是否含 `ai-productivity-tracker` server 与 `type: 'stdio'`,以及老 key 残留
5. **文档同步**:README.md、`AiProductivityTrackerMcpConfigTab.vue`、`AiProductivityTrackerGuideTab.vue`、`help.ts`
   全部更新说明,明确「`aipt install` 同时写 `~/.cursor/mcp.json` + `~/.claude.json`」

**测试覆盖**:`install-mcp.spec.ts` 从 8 例扩到 15 例,新增 Claude 文件不存在 / 已含老 key / 已含新 key /
保留顶层其它字段 / `runInstallMcpAll` 双侧同时写 / `--ide=claude` 单侧写 等场景。

**升级指引**:用户机器跑 `npm i -g @ai-productivity-tracker/cli@latest` 后重新 `aipt install`,
配套重启 Claude Code 一次(`/quit` 或 `Cmd + Q`)。

### Changed

**v1.0.0-rc.19 stop hook `FOLLOWUP_REASON` 文案优化:去掉"防伪造校验"措辞,改为更友好的"AI 提效追踪 · 待上报"提示**

实测背景:[stop-check.ts](../packages/hook-core/src/stop-check.ts) 在 sentinel 缺失 / 超窗时会向 LLM 注入
`FOLLOWUP_REASON` 文案当作 followup_message,文案是 LLM 与 IDE 用户都会看到的"对外面"。
v2.10.0 起这条文案以「`[ai-productivity 防伪造校验] 本轮未通过 MCP 工具调用 ai_productivity_attach_summary。`」
开头 — "防伪造校验"是面向开发者的内部术语,把内部时序防御机制(sentinel 90s 窗)直白暴露给最终用户;
个别用户在 IDE 里看到这条会误以为「AI 在伪造数据」「自己被监控」,引发不必要的疑虑。

本期把 `FOLLOWUP_REASON` 重写为 LLM 友好 + 用户友好的语气:

```
[AI 提效追踪 · 待上报] 检测到本轮尚未通过 ai_productivity_attach_summary 上报对话总结。
请立即补充调用(参数:oneLine + type + changeScope/discussion),
调用成功即视为本轮完成 —— 不必在答复中提示上报状态或重复总结内容。
```

行为零变化:

- 文案是导出常量 `FOLLOWUP_REASON`,Cursor 方言写到 `followup_message`,Claude Code 方言写到 `decision:block.reason`,两端字段格式与触发逻辑完全不动
- 测试 spec 直接引用 `FOLLOWUP_REASON` 常量值断言,不依赖具体字符串字面量,本次改动天然回归无破坏
- sentinel 时间窗 / loop_count 防御 / abort 过滤 / agent 可达性检查所有前置全部保留

文档侧"防伪造校验"作为内部技术名词在 `docs/CHANGELOG.md` / `docs/PRD.md` / `docs/HOOK-PROTOCOL.md` 等
开发者文档里继续保留(描述 sentinel 90s 窗 / hook-state 目录设计意图),不影响最终用户视角。

---

**v2.14.0 双管齐下提升 Cursor `ai_productivity_attach_summary` 主动调用率(消除"漏调 + stop-hook 补刀"双 iteration)**

实测现象(INSTANT-5321 iterations.jsonl 最近 5 轮):`#18 主动 → #19 漏调 → #20 补刀 → #21 漏调 → #22 补刀`,
Cursor 端 LLM 几乎从不主动调 attach_summary,每个用户提问稳定被拆成"主答 + 补刀"两条 iteration,
看板上 `conversationSummary=null` 的"漏调轮"占比近 50%,完全靠 [stop-check.ts](../packages/hook-core/src/stop-check.ts)
注入 `followup_message` 兜底,代价是每轮多 ~6K token + ~42s 延迟。

根因 3 条:

1. **架构**:Cursor 没有 `UserPromptSubmit` 等价 hook,长会话过半 alwaysApply rule 在大上下文里"沉底"。
   Claude Code 用 `UserPromptSubmit` Hook 每轮注入 reminder 是有效经验,Cursor 端必须找等价注入位。
2. **文案**:v2.13.0 rule 开头 200+ 字连串否定句("严禁... 严禁... 当本规则不存在"),
   3 条前置(分支正则 / daemon 可达 / 已 init)LLM 在 prompt 里无法自我验证,模型保守倾向于"不调"。
3. **反馈**:stop hook 兜底变相纵容漏调 — 漏调对 LLM 零成本,反而催生"等被打回再静默补一次"的偷懒路径。

修复(A + B 双管齐下,保留 stop hook 作为安全网):

**A. Cursor sessionStart Hook 注入 reminder**

Cursor 官方 [hooks 文档](https://cursor.com/docs/hooks.md) 的 `sessionStart` 支持
`additional_context` 字段把字符串拼到 conversation 的 initial system context,是 Cursor 端
最接近 Claude `UserPromptSubmit` 的注入位。新增常量
[`CURSOR_SESSION_REMINDER_COMMAND`](../packages/core/src/track-skill-templates.ts) 与
marker `# ai-productivity-session-reminder`,`aipt install` 把命令写到 `~/.cursor/hooks.json`
的 `hooks.sessionStart` 数组:

```bash
bash -c 'b=$(git -C "${CURSOR_PROJECT_DIR:-$PWD}" symbolic-ref --short -q HEAD 2>/dev/null || true);
  if [[ "$b" =~ [A-Z][A-Z0-9]+-[0-9]+ ]]; then
    k="${BASH_REMATCH[0]}";
    printf "%s" "{\"additional_context\":\"[ai-productivity] 本会话工作在 Jira 分支 $k,...\"}";
  else
    printf "%s" "{}";
  fi || printf "%s" "{}"' # ai-productivity-session-reminder
```

- Jira 分支输出 `{"additional_context":"..."}`,Cursor 把字符串拼到 initial system context
- 非 Jira 分支 / detached HEAD / 非 git 仓库 / git 不存在 → 输出 `{}`,**等价不注入,零污染**
- 与 Claude 端 `CLAUDE_TRACK_HOOK_REMINDER_COMMAND` 设计完全对称,bash 3.2(macOS 系统默认)即可跑
- `CURSOR_PROJECT_DIR` 是 Cursor 给所有 hook 子进程统一注入的 workspace 根目录(文档 §Environment Variables 保证),不依赖 sessionStart payload(本身无 workspace_roots 字段)

**B. 重写 Cursor / Claude 双方言 rule 文案(v2.13.0 → v2.14.0)**

[`CURSOR_TRACK_RULE_CONTENT`](../packages/core/src/track-skill-templates.ts) 与
`CLAUDE_TRACK_SKILL_CONTENT` 双方言同步重写,核心结构调整:

- 首段改为 **`## 触发(每轮必须)`** 正向引导,明确"看到 reminder = 前置已满足,无需再自我验证 3 条前置"
- 否定句压到末尾 **`## 边界:看不到 reminder 时`**,只保留"没看到提示就不要调"这一条简单判定
- **删除 `## 防伪造硬约束` 整段**(原来明确告诉 LLM "漏调会被 stop hook 打回来补一次",反而催生
  "等被打回再补"的偷懒路径)
- `## 完成态(零提示)` / `## 禁止` 列表保留(防伪造 / 不复述 diff / 不写数值 等硬约束不变)

**C. stop hook 兜底机制完全保留(安全网)**

[stop-check.ts](../packages/hook-core/src/stop-check.ts) 不动,sentinel 90s 窗口 + `inject_followup` 行为不变。
预期 rc.12 上线后 `inject_followup` 频率从 ~50% 降到 <5%,真"漏调"时仍由它兜底,不丢数据。

**测试覆盖**:新增 `track-skill-templates.spec.ts`(20 例文案 invariant 校验)+
`skill-sync.spec.ts` 5 例 sessionStart hook 安装/覆盖/inspect 覆盖,612 → 644 例全绿。

**注意**:用户机器需要 `npm i -g @ai-productivity-tracker/cli@1.0.0-rc.12` 然后跑
`aipt install` 让新 hook 写入 `~/.cursor/hooks.json` + 新 rule 覆盖 `~/.cursor/rules/ai-productivity-track.mdc`,
然后**重启 Cursor 让 sessionStart hook 在新会话生效**(现有会话不会重新跑 sessionStart)。

### Fixed

**Cursor `stop` hook 在用户手动中断时仍误触 followup_message,LLM 被强制重答**

实测现象:用户在 Cursor 里按 ESC / Cancel 中断当前对话后,几秒内 Cursor
会自动 submit 一条 `[ai-productivity 防伪造校验] ...` 文案,LLM 被强制重新答复,
完全违背用户中断意图,体验极差。

根因:Cursor 官方 [Hooks 文档](https://cursor.com/docs/hooks.md) 明确 stop hook
payload 含 `status: "completed" | "aborted" | "error"` 字段;但我们的
`runStopCheck()` 完全没读 `status`,任何状态下都跑 sentinel 校验,
sentinel 缺失就 `inject_followup`,Cursor 把 followup_message 当作下一轮 user prompt
自动 submit。

对照:Claude Code Stop hook 文档明确 "do not fire on user interrupts",中断时根本不调
Stop hook,所以同 IDE 装的 evolution 等 skill 天然不被中断打扰 —— **Cursor 行为不同,
必须在 stop-check 内主动过滤**。

修复:[`packages/hook-core/src/stop-check.ts`](../packages/hook-core/src/stop-check.ts) 内 `detectDialect()` 之后
立即调 `isAbortedStop(parsed, dialect)`,Cursor `status ∈ {aborted, error}` →
立即返回新 outcome `skipped_aborted`(`output: null`),不再跑 git / sentinel / agent ping
任何后续逻辑,零开销零打扰。

向后兼容:`status` 字段缺失(老 Cursor / 测试 fixture)按 `'completed'` 处理,
**不**判定为 abort,原有 sentinel 校验逻辑全保留,不会让"中断"和"老版本"混淆。

新增 4 例单元测试覆盖 aborted / error / 优先级 / 老 payload 兼容,612 → 616 例全绿。

---

## [1.0.0-rc.7] - 2026-05-25

> 首个**端到端可用**的 RC 版本(MCP 真能连上 Cursor / Claude Code)。
>
> 之前 rc.1 ~ rc.6 因不同的安装期 / 启动期 bug 全部 npm deprecate,
> **请直接用 rc.7+**。详见下方各 rc 版本的 deprecation 说明。

### Fixed(rc.6 → rc.7 关键修复)

**MCP 子进程缺 event-loop hang,startMcpServer 后立即 exit 导致 stdio 关闭**

实测 Cursor MCP 连接报"MCP error -32000: Connection closed":

- `[ai-productivity-mcp] running ...` 启动日志正常
- 紧接着 `Connection failed`,Cursor 前端红色 Error

根因:`@modelcontextprotocol/sdk` 的 `await server.connect(transport)` 只是把
stdio transport 注册到事件循环,**立刻 resolve(不阻塞)**。我们的 `runMcp()`
resolve 后,`main().then(code => process.exit(code))` 立即调用 process.exit,
mcp 子进程立即退出 → stdio JSON-RPC channel 断开。

修复:`runMcp()` 末尾 `return new Promise<number>(() => {})` 阻塞 event loop,
让 stdio transport 处理 JSON-RPC 直到外部 SIGTERM(IDE 关闭 MCP 子进程时自然杀掉)。
daemon 子命令早就用了相同模式,mcp 子命令漏改。

---

## [1.0.0-rc.3] - 2026-05-25(被 rc.4+ 修复迭代取代)

### Added(首版核心能力)

- **`@ai-productivity-tracker/cli`** 单包发布:
  - bin: `ai-productivity-tracker` / `aipt`(别名)
  - argv-router 13 个子命令(`mcp` / `daemon` / `hook` / `stop-check` / `install` / `install-mcp` / `migrate` / `ui open` / `doctor` / `version` / `help` 等)
  - esbuild 单文件 bundle 内联 5 个内部子包,产物 ~1MB(gzip ~300KB)
- **内部 6 个子包**(esbuild bundle 内联,用户不感知):
  - `core`:数据 store / metrics / transcript-watcher / git-diff / claude-message 解析
  - `hook-core`:Cursor afterAgentResponse + Claude Stop / UserPromptSubmit hook 入口逻辑、sentinel 防伪造校验
  - `mcp`:stdio MCP bridge,5 个 tool 转发到 daemon HTTP
  - `server`:`http.createServer` daemon,30+ 个 `/ai-productivity/*` 端点 + skill-sync
  - `ui`:Vue 3 SPA 看板,6 个 Tab,内置极简 shell
  - `cli`:argv-router + ensure-daemon + runtime-lock + 子命令实现
- **runtime.json 单实例锁**:pid + port + token + version + dataRoot 协调机制,atomic write 0o600
- **端口选择**:默认 17350,与残留 `truesight-agent`(17280)主动错开;占用时自动扫描 fallback
- **daemon 自动 spawn-detached**:首个 `aipt mcp` / `ui open` / `install` 调用拉起后台 daemon,后续复用
- **9 项体检命令** `aipt doctor`:Node / home / config / daemon / data / cursor mcp.json / cursor hooks.json / claude skill / cursor rule / legacy-data
- **数据迁移命令** `aipt migrate`:从 `~/.truesight-local-agent/ai-productivity/` 平迁到 `~/.ai-productivity-tracker/data/`,默认拒绝覆盖,`--force` 走增量合并
- **同源安全模型**:daemon 强制 127.0.0.1,看板同源访问免 token;IDE / Hook 走 Bearer token,通过 runtime.json 协调
- **跨平台支持**:macOS / Linux 完整测试,Windows 路径处理已就绪(detached spawn / pid 探活 / 进程组信号待 Windows 实机验证)
- **PRD 完整文档**:`docs/PRD.md`(1031 行)涵盖现状 / 目标 / 架构 / 5 阶段实施计划 / 14 个验收用例

### Migrated from `instant-web-tools` v2.18.0

行为契约 1:1 继承,以下能力字面保留:

- 5 个 MCP tool 名称 / zod 入参 / 出参文本
- 30+ HTTP 端点路径 / 请求体 / 响应体
- 文件 schema(`requirement.json` / `iterations.jsonl` / `lessons/*` / `bindings.json` / `formula.json` / `jira.json`)
- Cursor / Claude 双方言 Hook 协议(afterAgentResponse / Stop / UserPromptSubmit)
- 90s sentinel 防伪造时间窗
- transcript-watcher Claude Code jsonl 解析(stop_hook_summary + stale-flush + msg.id 去重)
- 提效公式 boost 计算(formula.json 可自定义)
- 经验沉淀闭环(lessons-extract skill + extract_bundle + save_lessons + INDEX 重建)

### Fixed(相对 rc.1 / rc.2 的修复)

- **rc.1 → rc.2**:`cli/package.json` dependencies 含 `workspace:*` 协议,用户
  `npm i -g` 直接 `EUNSUPPORTEDPROTOCOL` 失败。修复:把所有 workspace 子包 +
  已 bundle 的 deps 全部下移到 devDependencies;新增 release.mjs
  `withPublishableManifest()` 包装,publish 前临时移除 devDependencies + scripts,
  publish 完恢复。tarball 内 package.json 从 1.7KB 缩到 866B,完全 0 个外部依赖
- **rc.2 → rc.3**:cli 入口 `isDirectRun` 在 npm 全局 symlink 启动场景下永远 false
  (`import.meta.url` 是 realpath,`process.argv[1]` 是 symlink 路径,两者不等),
  导致 main() 不跑,`aipt version` / `aipt doctor` 全部静默 exit 0。修复:删除
  isDirectRun 判断,cli.mjs 作为唯一 entry 直接调 main();单测/import 场景用
  `process.env.AIPT_SKIP_AUTOSTART` 守卫

### Changed(对外可见)

- IDE MCP 配置改为 `npx -y @ai-productivity-tracker/cli mcp`(原:手动 node `~/Downloads/...mjs` + 4 个 env)
- 数据根目录:`~/.truesight-local-agent/ai-productivity/` → `~/.ai-productivity-tracker/data/`
- daemon 端口:17280 → 17350
- skill / rule 模板:文案中 `truesight-agent` → `ai-productivity-tracker`,`17280` → `17350`,路径同步更新

### Compatibility(向后兼容)

- 老 `TRUESIGHT_AGENT_URL` / `TRUESIGHT_AGENT_TOKEN` env 保留为 fallback
- 老 `TRUESIGHT_AIP_ROOT` env 保留为 fallback
- 老 `~/.truesight-local-agent/config.json` 在新 runtime.json 不存在时作为兜底读取
- Cursor hooks.json 老 `~/Downloads/ai-productivity-mcp.mjs` 路径会被 `aipt install` 自动检测并覆盖
- `~/.claude/settings.json` 老 `mark-tool-called` hook(v2.10.0 起已下线)在 install 时一并清理

### Tests

590 例自动化测试,40 个 spec 文件覆盖:

- core(22 spec, 442 例):全部 store / metrics / transcript-watcher / hook-dedupe / jira-bug-client
- hook-core(6 spec, 83 例):hook / stop-check / install-cursor-hook / sentinel / agent-client
- mcp(3 spec, ~30 例):agent-client / tools / argv-router
- server(2 spec, 83 例):routes/ai-productivity + skill-sync
- cli(7 spec, 64 例):paths / pick-port / runtime-lock / config / install-mcp / migrate + daemon e2e(spawn 真 daemon,含 crash 重启 + 端口冲突场景)

### 发布产物指标(rc.7)

- npm tarball: **633 KB**(阈值 3 MB,PRD §V14 达标)
- unpacked dist: **2.6 MB**(阈值 5 MB,PRD §V14 达标)
- 运行时外部依赖: **0**(全部 esbuild bundle 内联)
- 文件清单:`dist/cli.mjs`(1.0 MB)+ `dist/web/`(SPA assets)+ `dist/version.json` + `package.json`(866 B 精简版)

---

## DEPRECATED 版本汇总

> 以下 6 个 rc 版本都因不同的 packaging / 启动期 bug 在 npm registry 上做了 `npm deprecate` 标记。
> 用户安装时 npm 会打印 deprecation warning + 推荐升级到 rc.7。

### [1.0.0-rc.6] - 2026-05-25 — DEPRECATED ⚠️

> mcp 子命令在 `startMcpServer()` 后立即 process.exit,stdio 关闭 → Cursor MCP
> 报 `MCP error -32000: Connection closed`。日志显示 server 启动成功但连接立刻失败。

deprecate 原因:`stop-check hook command still points to ~/Downloads/ai-productivity-mcp.mjs (legacy v2.x death path, file not exist after install). Please use 1.0.0-rc.6 or later.` (注:rc.5 → rc.6 修了路径,rc.6 → rc.7 修了 mcp hang。每次 rc 暴露的新问题都不同)

### [1.0.0-rc.5] - 2026-05-25 — DEPRECATED ⚠️

> `skill-sync.ts` 的 `defaultMcpBinPath()` 仍硬编码 `~/Downloads/ai-productivity-mcp.mjs`,
> 导致 hooks.json 中 stop-check hook 命令指向已删除的文件,Cursor stop hook 触发时 ENOENT 静默失败。

### [1.0.0-rc.4] - 2026-05-25 — DEPRECATED ⚠️

> mcp.json / hooks.json 内的 `node` 是相对命令,依赖 PATH 解析。macOS GUI 应用
> (Cursor / Claude Code)从 launchd 启动子进程时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`,
> nvm/volta/fnm 装的 node 全部不在里面,触发 ENOENT 静默失败。

### [1.0.0-rc.3] - 2026-05-25 — DEPRECATED ⚠️

> `aipt install` 调 daemon `/install-cursor-hook` 端点时,daemon handler 硬检查
> `~/Downloads/ai-productivity-mcp.mjs` 文件存在性,不存在 → HTTP 412。
> cli 早已通过 body.hookEntry 传了正确的全局 cli.mjs 路径,但 handler 完全没接住。
> 同时 install-mcp 默认 command 是 `npx -y ...`,macOS GUI 应用启 MCP 子进程时拉包易超时。

### [1.0.0-rc.2] - 2026-05-25 — DEPRECATED ⚠️

> cli 入口 main() 在 npm 全局 symlink 启动场景下不触发(`isDirectRun` 判断失效),
> 所有命令静默 exit 0,完全不可用。

deprecate 原因:`installs cleanly but cli entry never runs main() on symlinked bin. Please use 1.0.0-rc.3 or later.`

### [1.0.0-rc.1] - 2026-05-25 — DEPRECATED ⚠️

> `cli/package.json` `dependencies` 含 `workspace:*` 协议,用户 `npm install -g` 直接报
> `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"` 安装失败,完全装不上。

deprecate 原因:`packaging bug: dependencies contain workspace:* protocol, fails to install. Please use 1.0.0-rc.3 or later.`

---

## 📚 发布工程经验(踩坑笔记)

本仓库首次走完"独立 npm 包"完整发布流程,从 rc.1 走到 rc.7 才真正端到端可用。
**每个 rc 暴露不同维度的非显然问题**——这是新 OSS 包正常发布节奏,关键是
deprecate 老版本 + CHANGELOG 透明记录,让后来者一次就跑通。

记录 9 条经验供后续 release 或同类 OSS 项目参考。

### 1. pnpm `<script>` 会把全局 `~/.npmrc` 注入为 `npm_config_*` env

**现象**:`release.mjs` 通过 `execSync('npm whoami --userconfig=./.npmrc.publish')`
查身份时持续报 ENEEDAUTH,但手动在 shell 里跑完全相同的命令成功。

**根因**:`pnpm release` 跑 script 时,pnpm 会读全局 `~/.npmrc` 的所有配置,
作为 `npm_config_*` env 注入给子进程。`npm config list` 在子进程中显示:

```
; "user" config from /Users/.../.npmrc.publish
; registry = "https://registry.npmjs.org/" ; overridden by env  ← 被 env 覆盖!

; "env" config from environment
registry = "http://npm.truesightai.com/"                          ← 这才生效
```

token 在 .npmrc.publish 里,但 registry 被 env 顶到公司私有源,token 不匹配 → 401 / ENEEDAUTH。

**修复**:CLI flag 优先级最高,显式同时带 `--userconfig=<abs> --registry=<official>`,
碾压 pnpm 注入的 env。详见 `scripts/release.mjs` `userConfigFlag` 常量与 JSDoc 注释。

### 2. `workspace:*` 协议不能进 publish 的 `dependencies`

**现象**:rc.1 发布后,任何用户跑 `npm i -g @ai-productivity-tracker/cli@1.0.0-rc.1` 立即
报 `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`,根本装不上。

**根因**:pnpm workspace 用 `workspace:*` 协议链接 monorepo 子包,这是 pnpm-only
语义。`npm publish` 不识别也不重写它,把含 `workspace:*` 的 package.json 原样塞进
tarball。用户端 npm 看到 `workspace:*` 直接拒绝(npm 7+ 才识别它,但仅在 pnpm
workspace 上下文里)。

**修复(双层防御)**:

1. cli/package.json 把所有 workspace 子包从 `dependencies` 下移到
   `devDependencies`(运行时由 esbuild bundle 保证,无需声明)
2. release.mjs 新增 `withPublishableManifest()` 包装:publish 前临时改 package.json
   删除 devDependencies + scripts,publish 完恢复。tarball 内 package.json 缩到 866B

### 3. ESM 入口 `isDirectRun` 检测在 npm bin symlink 启动场景下失效

**现象**:rc.2 装上后,`aipt version` / `aipt doctor` 等所有命令静默 exit 0,没有
任何输出。

**根因**:cli/src/index.ts 末尾有经典 ESM "entry 检测":

```js
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main()
}
```

但 npm 全局装 bin 是 symlink:

- `process.argv[1]` = `/usr/local/bin/aipt`(symlink 路径)
- `import.meta.url` = `file:///usr/local/lib/.../cli.mjs`(realpath)

两者永远不相等 → `isDirectRun=false` → `main()` 不跑 → 静默 exit。

**修复**:cli.mjs 作为单一 entry 文件,删掉 `isDirectRun` 判断直接调 `main()`;
单测/import 场景用 `process.env.AIPT_SKIP_AUTOSTART` 守卫(默认值未设,自动启动)。

### 4. npm 2FA 强制策略 + Granular Access Token (GAT) 是 OSS 最佳实践

**现象**:首次 `npm publish` 报 403:

> Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.

**根因**:npm 自 2022 起对所有 public package 强制要求 2FA(或带 bypass 2fa 的
GAT)。这是 npm 平台侧策略,非代码问题。

**最佳实践组合**:

1. **账号开 2FA**(Security Key 或 TOTP 任一):保护账号本身
2. **Granular Access Token 给 publish 用**:
   - Permissions: Read and write
   - Packages: 只选 `@<scope>`(限定 scope,降低泄露面)
   - **Bypass 2FA enabled: YES**(让 CI / 脚本不卡 OTP)
   - Allow login: NO(GAT 只 publish,不 login)
   - Expiration: 90-365 天
3. token 写到项目级 `.npmrc.publish`(gitignored)+ release.mjs 自动通过
   `--userconfig` 注入

效果:`pnpm release --publish` 完全静默通过 2FA 校验,token 限定在单一 scope,
即便文件泄露最大破坏面也仅限于 publish 这一个 scope 的包。

### 5. macOS GUI 应用启子进程时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`

**现象**:rc.4 把 mcp.json 配置改成 `{ command: "node", args: ["<abs cli.mjs>", "mcp"] }`,
shell 终端跑完全 OK,但 Cursor 启 MCP 子进程时静默 ENOENT 失败。

**根因**:Cursor / Claude Code 等 GUI 应用从 macOS launchd 启动,继承的 PATH **不是**
你 shell rc 文件里的 PATH,而是 macOS 系统默认 `/usr/bin:/bin:/usr/sbin:/sbin`。
nvm / volta / fnm / asdf 等 Node 版本管理器装的 node 全部不在这个 PATH 里,
`exec node ...` 直接 ENOENT。

**修复**:**所有写到 IDE 配置的命令必须用 `process.execPath` 绝对路径**,
不依赖 PATH 解析:

```ts
// install-mcp.ts / install-cursor-hook / skill-sync stop-check 三处都这么写
const command = process.execPath // /Users/.../bin/node 绝对路径
const args = [process.argv[1] /* cli.mjs 绝对路径 */, 'mcp']
```

同样适用于 Linux 用户用 nvm/volta 时,以及未来 Windows 的 nvs/nvm-windows。

### 6. stdio MCP server 启动后必须显式 hang event loop

**现象**:rc.6 实测 Cursor 报 `MCP error -32000: Connection closed`,但日志
显示 mcp 启动成功(`[ai-productivity-mcp] running ...`)。

**根因**:`@modelcontextprotocol/sdk` 的 `await server.connect(transport)` 接受
一个 transport,底层做的事:

1. 把 process.stdin 注册成 readable 监听
2. 把 process.stdout 注册成 writable
3. resolve Promise

它**不阻塞**——只是把回调挂到 Node event loop。但 cli `runMcp()` resolve 后
`main().then(code => process.exit(code))` 立即调 `process.exit(0)`,**就算 stdio
监听器还在,process.exit 也会强制杀进程** → Cursor stdio JSON-RPC channel 断开。

**修复**:子命令显式 hang event loop:

```ts
export async function runMcp(): Promise<number> {
  await ensureDaemon()
  await startMcpServer() // 注册 stdio 监听后立刻 resolve
  // 永不 resolve,event loop keep alive,直到外部 SIGTERM
  return new Promise<number>(() => {})
}
```

`daemon` 子命令早就用了相同模式(SIGTERM/SIGINT handler 内调 process.exit),
**mcp 子命令是漏改**。所有"长期运行的 stdio / HTTP server 子命令"都需要这个模式。

### 7. 大型项目迁移时的"死代码 fallback"陷阱

**现象**:从 rc.3 到 rc.6,陆续在 4 个地方发现源仓库 v2.x 留下的死代码,
全部默认指向 `~/Downloads/ai-productivity-mcp.mjs`(老的"用户手动 curl 下载"位置):

1. `server/routes/ai-productivity.ts` `defaultHookEntryPath()` + 412 错误文案
2. `server/routes/ai-productivity.ts` `handleAiProductivityInstallCursorHook` 硬检查
3. `server/routes/ai-productivity.ts` hook command 拼装中的 `node ${path}`
4. `server/skill-sync.ts` `defaultMcpBinPath()` 用于 stop-check command

**根因**:这些函数都被单测覆盖,但**测试用例只验证"接口契约"**(传入参数 → 输出
结果),没有覆盖"默认值是否合理"。`existsSync(~/Downloads/...)` 在源仓库
测试机上可能存在(因为用户机器上有),迁移到新仓库后用户没装老工具,这些死路径
就一个一个炸出来。

**修复方法论(供后续大型迁移参考)**:

1. **grep 老路径关键字做一次 sweep**:`grep -rn "Downloads/ai-productivity-mcp\|truesight\|17280" packages/` —— 任何命中都要 case-by-case 评估保留还是清理
2. **写"全新机器端到端 e2e"**:模拟刚装完 npm 包的纯净环境跑完整流程,catch
   所有"假设用户机器上有 XX"的隐式依赖。本仓库后续可以加 vitest e2e:
   起一个 mkdtempSync 模拟 HOME → npm i → aipt install → aipt mcp → 解析 JSON-RPC
3. **rc 阶段就是用来 catch 这些坑的**:7 个 rc 看似多,实际是 OSS 发布前正常节奏;
   每次 deprecate 老版本 + CHANGELOG 透明记录,让后来者跳过坑

### 8. Cursor MCP 客户端的 stderr UI 显示约定

**现象**:cli 通过 `console.error('[ai-productivity-tracker] reusing daemon ...')` 输出
诊断日志,Cursor 端 MCP Output 面板里这些行被标 `[error]`,看着像"启动报错"。

**根因**:stdio MCP 协议规定:

- **stdout** 是 JSON-RPC 通道,只能有合法 JSON-RPC 帧
- **stderr** 可以任意输出,通常作为子进程的诊断日志

Cursor 把子进程 stderr 每行都标记成 `[error]` 是 UI 约定(不是真错误)。
Claude Code 等其它 IDE 不会这样标。

**处理**:`console.error` 写诊断日志是 stdio MCP server 标准做法,保留。
用户看到 `[error] running v1.0.0-rc.7` 不要慌,真正的错误会有
"Connection closed" / "JSON parse error" 等 MCP 级别报错伴随。

### 9. Cursor `stop` hook 在用户手动中断时**也会触发**,必须读 `status` 字段过滤

**现象**:用户在 Cursor 里按 ESC / Cancel 中断对话后,几秒内 Cursor 自动 submit
一条 `[ai-productivity 防伪造校验] ...` 文案当作新一轮 prompt,LLM 被迫重新答复,
完全违背中断意图,用户体验极差。

**根因**:不能假设"stop hook = 正常完成才触发"。两个 IDE 行为**截然不同**:

| IDE         | 用户中断时 stop hook 是否触发         | 行为依据                                  |
| ----------- | ------------------------------------- | ----------------------------------------- |
| Claude Code | **不触发**                            | 文档原文 "do not fire on user interrupts" |
| Cursor      | **会触发**,payload `status='aborted'` | 文档显式定义 `status` 三态                |

我们的 `runStopCheck()` 只看了 `loop_count` / `stop_hook_active`(死循环防御),
完全没读 Cursor payload 的 `status` 字段,中断/出错都走 sentinel 校验 → inject_followup
路径,Cursor 把 followup_message 当作下一轮 user prompt 自动 submit。

参考对照:`.claude/skills/evolution` skill 也有 Stop hook(`session-end.sh`),
但它装的是 Claude Code 端 → 用户 ESC 时根本不触发,**evolution 自身没做任何
过滤**,只是天然受益于 Claude Code 的设计。这就是为什么用户感觉"evolution 中断不会
打扰,我们的 stop-check 会打扰"。

**修复**(`packages/hook-core/src/stop-check.ts`):

```ts
function isAbortedStop(parsed: Record<string, unknown>, dialect: StopDialect): boolean {
  const status = typeof parsed.status === 'string' ? parsed.status : ''
  return status === 'aborted' || status === 'error'
}

// runStopCheck() 内 detectDialect() 之后立即:
if (isAbortedStop(parsed, dialect)) {
  return { kind: 'skipped_aborted', dialect, output: null }
}
```

放在最前面的好处:中断时连 git resolveTrackingContext / fetch ping / sentinel read
都不跑,零开销零副作用。

**方法论**:任何"借用 IDE hook 注入 followup"的设计都必须先调研 hook 在 IDE
**异常/中断/失败**路径下的行为,不能只盯着 happy path 写代码。同样的 hook 名,
不同 IDE 行为可能完全相反(Claude `Stop` vs Cursor `stop` 就是典型反例)。
新增 outcome 维度 `skipped_aborted`,与 `skipped_*` 系列对齐,便于事后日志统计
"被打扰的中断次数 → 应该为 0"。

---

## 未来路线图(v1.x)

- **v1.1**:Windows 完整支持(systemd-equivalent 守护脚本生成器)
- **v1.1**:看板「全局复盘报告」一键导出 Markdown / HTML
- **v1.2**:skill / rule 版本管理面板(diff / 回滚 / 自定义 fork)
- **v1.2**:多 dataRoot 切换(按"工作"/"个人"切档)
- **v1.3**:团队同步 — daemon 可选 push 经验到 git 仓库
- **v1.3**:VS Code Extension 替代手动注入 mcp.json

详见 [`PRD.md` §12](./PRD.md)。
