## Context

现状(详见 `AGENTS.md` / `docs/ARCHITECTURE.md`):

- 采集完全围绕 **Jira 需求**维度。Claude 用 `TranscriptWatcher`(watch `~/.claude/projects/**/*.jsonl`)、Codex 用 `CodexWatcher`(watch `~/.codex/sessions/**/*.jsonl`)、Cursor 用 **Hook**(`aipt hook`,挂 `afterAgentResponse` / `afterAgentThought` 每轮上报到 daemon)。
- 三条链路共用一个闸门:`ensurePendingTurn` 在「分支不含 Jira issue key / 不在 git 仓库」时返回 null(`packages/core/src/codex-watcher.ts:399-416`,Claude 同构);Cursor hook 在拿不到 project root 时客户端静默退出(`packages/hook-core/src/hook.ts:355`)。非 Jira 分支、`main`、非仓库会话用量**被整体丢弃**。
- token 解析口径已统一:`parseHookTokens`(`hook.ts:79`)与 watcher 的 `effectiveTokens` / `effectiveCodexTokens` 都按「input(剔除 cache_read)+ output」口径,且**已经解析出 input/output/cache_read/cache_creation 细分**,只是落盘时丢弃了细分、只留合计。
- 数据落盘在 `~/.ai-productivity-tracker/data/`,store 在 `packages/core/src/store/`,路径常量在 `store/paths.ts`;全局单例配置(`formula.json` / `jira.json`)直接落 data 根。
- daemon 在 `startDaemon`(`packages/server/src/http/server.ts:104`)`new` 两个 watcher 并 `.start()`;路由集中在 `routes/ai-productivity.ts` + `http/server.ts` 的 `routeAiProductivity`。
- 看板:Vue3 + vue-router(hash),菜单在 `router.ts` 的 `primaryNav`;echarts 按需注册(`charts/echarts.ts`);API 客户端 `api.ts`;设计 token / glass 体系在 `styles/`。

**参考工具调研(loongsuite-pilot)**:用户本机已装阿里 LoongSuite 的本地 AI 用量采集器。其做法对本设计有直接启发,**本变更选择自建复刻其模式(不依赖该工具)**:

- 全 agent 走 Hook 采集,**Cursor hook 不卡 git 仓库**,天然覆盖非仓库/非 Jira 会话。
- 归一化成 **OpenTelemetry GenAI 语义约定**事件:`gen_ai.usage.{input_tokens,output_tokens,cache_read.input_tokens,cache_creation.input_tokens,total_tokens}`、`gen_ai.{session.id,turn.id,agent.type,provider.name,request.model,response.model}`、`event.name=llm.request/llm.response`。
- 增量扫描用 `offset + size + ino` 三元组(比仅 offset+mtime 更稳,识别 inode 变化/轮转),幂等不重复计数。
- 聚合产物丰富:token 拆 input/output/cacheRead/cacheCreation;维度 sessions/requests/toolCalls/events;多维占比 model/provider/agent;range today/7d/30d + daily 序列。

## Goals / Non-Goals

**Goals:**

- 以 **AI 工具 × 自然日** 为维度,无差别采集 Cursor / Claude Code / Codex 的整体用量,独立于 Jira 绑定(含 `main`、非仓库会话)。
- **采集层做"全":** 内部 schema 对齐 OTel GenAI 语义约定,落盘保留 token 细分(input/output/cacheRead/cacheCreation)、sessions/turns、可得的 model/provider 维度,为后续扩展留好数据。
- **展示层先"简":** v1 看板页面只呈现「每个 AI 当天 token + 对话次数」卡片 + 监控开关 + 近 N 天趋势图;丰富维度入库但暂不全部上屏。
- 提供全局监控开关(默认关闭,opt-in),持久化、可页面切换、即时生效。
- 自包含:全部采集/聚合/查询逻辑在本仓库实现,随 `@ai-productivity-tracker/cli` 包分发,**不依赖任何第三方工具是否安装**。
- 复用既有 token 解析与 watcher/hook 基础设施,不破坏既有需求维度采集(纯旁路新增)。

**Non-Goals:**

- 不做 token 成本(USD)计费(后续叠加)。
- v1 不在 UI 暴露全部丰富维度(model/provider 占比、cacheRead 等),只入库不上屏。
- 不做按需求/分支细分的整体用量(那是既有需求维度职责)。
- 不依赖、不读取、不写入 loongsuite-pilot 的任何文件(仅借鉴其数据模型)。
- 不改 5 个 MCP tool 与既有 HTTP 端点对外契约。

## Decisions

### D1:独立 store,落盘 OTel 对齐的丰富按日聚合

新增 `packages/core/src/store/ai-usage-store.ts`,落盘单文件 `~/.ai-productivity-tracker/data/ai-usage.json`,schema(version=1):

```jsonc
{
  "version": 1,
  "config": { "enabled": false },                 // 监控开关
  "daily": {
    "claude-code": {
      "2026-06-23": {
        "totalTokens": 12000,
        "inputTokens": 9000,
        "outputTokens": 1000,
        "cacheReadTokens": 8000,
        "cacheCreationTokens": 2000,
        "turns": 5,                                 // = 对话次数(flush 一次 +1)
        "sessions": 2,                              // 去重 sessionId 计数
        "toolCalls": 0,                             // 可得则记,缺则 0(best-effort)
        "models": { "claude-opus-4-8": { "totalTokens": 12000, "turns": 5 } },
        "providers": { "anthropic": { "totalTokens": 12000 } }
      }
    },
    "codex":  { /* 同构 */ },
    "cursor": { /* 同构 */ }
  }
}
```

- AI 维度键复用既有 `IterationSource`(`'cursor' | 'claude-code' | 'codex'`),不引新枚举。
- 字段命名对齐 OTel GenAI usage(便于将来导出/横向比较),但落盘用扁平 camelCase 适配前端。
- 自然日按本机时区取 `YYYY-MM-DD`;写盘用既有 tmp+rename 原子写。
- 函数式 API:`readAiUsage()` / `recordUsage(event)` / `setAiUsageEnabled(bool)`,其中 `event` 是归一化用量事件(见 D2)。进程内维护 `enabled` 布尔缓存,供旁路零盘 I/O 短路判断。

**为何独立单文件而非塞进 iteration?** iteration 强绑 jiraKey 目录,整体用量恰恰要覆盖「无 jiraKey」;独立单文件聚合让查询 O(1),不必扫全部需求目录。

### D2:归一化「用量事件」,在 issueKey 闸门之前记录

定义内部 `AiUsageEvent`(OTel GenAI 子集):`{ source, sessionId, turnId?, model?, provider?, tokens:{input,output,cacheRead,cacheCreation,total}, toolCalls?, at }`。三条链路各自把原生数据归一化成它,再调 `recordUsage(event)`:

- **Claude**(`TranscriptWatcher` flushTurn):已有的 `ParsedTokens` 含 input/output/cache_* 细分,直接映射;model 取 assistant message。
- **Codex**(`CodexWatcher` flush):token 增量 = `currentTotalEffective - flushedTotal`;细分按 `parseCodexTokenCount` 已解析字段映射;model 取 turn_context。
- **Cursor**(daemon `handleAiProductivityHook`):用 `parseHookTokens` + 透传的 `cache_read/creation_tokens` 映射;model 取 body.model。

关键:**旁路插在各链路 issueKey 判空之前**,所以非 Jira 分支也记;`enabled===false` 整段短路(读内存缓存)。需求维度采集逻辑保持原样、不动。

**替代方案(否决):** 单独再起 watcher 重复 watch 同样 jsonl —— 抢 `transcript-state.json` offset、重复解析、违背单实例约束。复用现有 flush/hook 触发点零额外 I/O。

### D3:Cursor v1 即改 hook-core,覆盖非仓库会话(已定)

参考 loongsuite(Cursor 用量天然全量,hook 每轮触发),**v1 直接改 hook-core**(不走降级):

- 在 `aipt hook` 客户端(`hook-core/src/hook.ts`)「无 project root 即静默退出」之前,**仍向 daemon 上报一条最小化用量信号**(只带 source/tokens 细分/model/sessionId,**不带任何对话正文与需求上下文**),供整体用量旁路消费;有 project root 时维持既有需求链路不变。
- daemon 侧 `handleAiProductivityHook` 在解析 issueKey 之前先 `recordUsage(cursorEvent)`。
- 风险控制:hook-core 是发布工程高危区(CHANGELOG 经验 5/6/7),改动走「grep sweep + 新机器 e2e + rc deprecate」三层防御;新增的上报必须**容错静默**(daemon 不可达 / 解析失败一律吞掉,绝不影响 hook 主流程退出码与既有需求上报)。

### D4:幂等与去重(已定:sessions 按当日事件重算)

- Claude/Codex:`recordUsage` 调用点即既有 watcher 的「每轮 flush 一次」去重后位置;watcher 的 offset/state 保证 daemon 重启重读不重复 flush → 自然不重复计数(对应文章的 StateStore checkpoint 思路)。
- 文件追踪幂等增强(`offset+mtime` → `offset+size+ino`,对应文章 StateStore 识别轮转)**拆为独立前置变更/rc 先发**(见下「前置依赖」),本变更建立在其之上。
- Cursor:经 hook `dedupeKey`(`hook-dedupe.ts`)去重,重复事件不重复累加(对应文章的 SnapshotStore 去重快照)。
- **sessions 维度去重:按当日事件重算**,不持久化 sessionId 集合。即 `recordUsage` 落盘的是「事件流/计数」,sessions 计数在聚合查询时对当日事件的 sessionId 去重得出。简化跨重启逻辑,代价是查询侧多一次 distinct(数据量小,可接受)。

### 前置依赖(独立前置 rc,已定)

watcher state 文件追踪从 `offset+mtime` 升级到 `offset+size+ino`,**拆成本变更之前的独立 change / 单独发一个 rc**,理由:它是采集幂等的通用增强、与本功能解耦,独立发版可单独回归、降低与新功能耦合风险。本变更声明依赖该前置 rc 落地后再实现采集旁路。

### D5b:隐私——仅采结构化元数据(借鉴文章选择四)

整体用量采集**只记结构化元数据**(source / model / provider / token 细分 / 对话次数 / sessionId / 时间戳),**绝不入库对话正文、工具参数、模型输入输出等大字段**。这既延续本仓库既有隐私原则(hook 只传 text_length 不传 text),也对齐文章「默认仅结构化元数据」的安全取舍。v1 不引入脱敏引擎(因为根本不采正文,无敏感内容入库面);若将来扩展采正文再评估脱敏。

### D5:HTTP 端点

- `GET /ai-productivity/ai-usage?days=N`:返回 `{ enabled, today:{<source>:{...}}, series:[{date, <source>:{totalTokens,turns,...}}...] }`,默认 `days=14`。响应**携带全部已采集维度**(前端按需取子集)。
- `PATCH /ai-productivity/ai-usage/config`:body `{ enabled }`,持久化 + 刷新进程内缓存,返回最新 config。
- 二者加入 `isAiProductivityPanelPath` 放行集合(panel-origin 免 token)。

### D6:前端页面(v1 简单展示)

- `router.ts` `primaryNav` 增 `{ key:'ai-usage', label:'AI 用量', icon:'i-lucide-activity', routeName:'ai-usage' }` + 路由。
- 新增 `tabs/AiUsageTab.vue`:顶部各 AI glass 卡片(**仅展示当天 totalTokens + turns**)+ 监控开关(el-switch);底部 `VChart` 趋势图(**默认按 token 维度**,echarts Line 已注册;可选切换到对话次数)。
- `api.ts` 增 `fetchAiUsage(days?)` / `patchAiUsageConfig({enabled})` 及类型(类型含完整字段,UI 先取子集)。
- 复用 `styles/tokens.css` / `glass.css` / `useChartTheme`;空态引导「开启监控」。

## Risks / Trade-offs

- [改 hook-core 上报路径风险高] → D3 给降级方案;改动走「grep sweep + 新机器 e2e + rc deprecate」三层防御(CHANGELOG 经验 7)。
- [采全维度但 UI 先简,数据可能"采了不用"] → 可接受:schema 向后兼容,后续上屏不需迁移;入库成本极低。
- [model/provider/toolCalls 各家可得性不一] → best-effort:缺失字段记 0 / 跳过,不阻断主流程。
- [sessions 去重跨重启] → 当日 sessionId 集合落盘或按事件重算,测试覆盖重启场景。
- [时区跨天] → 本机时区切日,DST 边界忽略(可接受)。
- [并发写 ai-usage.json] → 三链路同 daemon 进程内串行触发 + tmp+rename;单 daemon 实例锁保证无跨进程并发。

## Migration Plan

- 纯新增:新文件、新端点、新页面;`ai-usage.json` 惰性创建(默认 enabled=false、空 daily)。
- watcher state 从 `offset+mtime` 升级到 `offset+size+ino` 需兼容旧 state(缺 ino/size 字段时按旧逻辑兜底,首次扫描自动补齐)。
- 回滚:删新增端点/页面/store 即可;`ai-usage.json` 残留无害。
- 发版:沿用 `pnpm release prerelease --publish` 叠 rc。

## Resolved Decisions(原 Open Questions,已拍板)

1. **Cursor 覆盖非仓库会话:v1 即改 hook-core**(D3),配三层防御 + 容错静默。
2. **watcher state `+size+ino` 升级:拆成独立前置 rc 先发**,本变更依赖之(见「前置依赖」)。
3. **趋势图默认维度:token**(可切换到对话次数)。
4. **sessions 去重:按当日事件重算**,不持久化 sessionId 集合(D4)。

## 与参考文章(LoongSuite Pilot)的方案校验

- 采集模式:文章的 `BaseHookInput`(Hook JSONL 增量读)↔ 本设计 Cursor/Claude/Codex 全走 hook/flush 旁路。✔
- 可靠性:文章 StateStore(读偏移)+ SnapshotStore(去重快照)↔ 本设计 watcher offset state(前置 rc 升级 ino)+ hook dedupeKey。✔
- 语义统一:文章 AgentActivityEntry / LoongSuite GenAI 规范(扩展 OTel GenAI)↔ 本设计 `AiUsageEvent` 对齐 `gen_ai.usage.*` 等字段。✔
- 隐私粒度:文章「默认仅结构化元数据 + 可选脱敏」↔ 本设计 D5b 仅采元数据、不入库正文。✔
- 差异(有意为之):文章面向多后端扇出(SLS/OTLP/HTTP)与 session→turn→step→tool 全链路 trace;本设计只做**本机单文件按 AI×日聚合 + 看板展示**,不做 trace 全链路、不做多后端输出(超出本功能范围,留作 v1.x 演进方向)。
