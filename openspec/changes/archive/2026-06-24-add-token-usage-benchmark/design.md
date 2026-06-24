## Context

现状(详见 `AGENTS.md` / `openspec/changes/add-ai-usage-overview/`):

- `add-ai-usage-overview` 已落地。三条采集链路(Claude `TranscriptWatcher` flushTurn、Codex `CodexWatcher` flush、Cursor daemon `handleAiProductivityHook`)各自把原生数据归一化成 `AiUsageEvent`,再调用 **唯一汇聚点** `recordUsage(event)`(`packages/core/src/store/ai-usage-store.ts:251`)。
- `AiUsageEvent` 已携带 `{ source, sessionId, turnId?, model?, provider?, tokens:{input,output,cacheRead,cacheCreation,total}, toolCalls?, at }`,**仅结构化元数据,无对话正文**。
- 三处调用点当前的采集闸门是 `if (isAiUsageEnabled()) { recordUsage(...) }`(`transcript-watcher.ts:591`、`codex-watcher.ts:524`、`routes/ai-productivity.ts:707`)。`isAiUsageEnabled()` 读 `ai-usage.json` 的 `config.enabled`(进程内缓存,零盘 I/O 短路)。**全局监控关闭时,事件流根本不产生**。
- Cursor 非仓库会话:hook-core 客户端(`hook.ts:361`)在无 project root 时,仍**无条件**向 daemon 上报 `usageOnly:true` 最小化用量信号;是否计数由 daemon 侧闸门决定。**故本变更无需改动高危的 hook-core 客户端**。
- 落盘根 `~/.ai-productivity-tracker/data/`,路径常量在 `store/paths.ts`,全局单文件(`ai-usage.json` 等)直接落 data 根;写盘用 tmp+rename 原子写。
- 看板:Vue3 + vue-router(hash),菜单在 `router.ts` 的 `primaryNav`;echarts 按需注册(`charts/echarts.ts`);API 客户端 `api.ts`;glass/token 设计体系在 `styles/`;已有同构页面 `tabs/AiUsageTab.vue` 可直接参考。

**核心机会**:`recordUsage` 是所有用量事件的唯一漏斗,天然是「秒表测算」的旁路 tee 点;`AiUsageEvent` 已含 token 细分,无需重复解析。

## Goals / Non-Goals

**Goals:**

- 提供**秒表式窗口化测算**:手动开始/结束圈定一段时间窗,精确累加该窗口内**选定 AI 工具**的 token 用量。
- **开始记录可多选工具**(cursor / claude-code / codex 任意子集,至少一个),只累加选中工具的事件。
- **独立于「整体用量」全局开关**:有进行中的测算会话时照常采集,即便 `ai-usage.json` 监控关闭;同时 `ai-usage.json` 的写入语义保持原样(只在 `enabled` 时写)。
- 测算记录**本地落盘、可命名、可查看、可对比、可删除**,供「优化前 vs 优化后」A/B 验证。
- 复用 `recordUsage` 汇聚点与 `AiUsageEvent`,**零新增解析、零额外文件 watch**;不破坏既有需求维度采集与整体用量采集(纯旁路)。
- 不动高危 hook-core 客户端,采集闸门改动集中在 core watcher × 2 + server 路由 × 1。

**Non-Goals:**

- 不做 token 成本(USD)计费。
- 不做自动起停 / 定时测算(纯手动秒表);不做跨设备同步。
- v1 不持久化每条事件明细,只持久化「会话级累加结果」(对比所需粒度足够)。
- 不改 5 个 MCP tool 与既有 HTTP 端点对外契约;不改 `ai-usage.json` schema。

## Decisions

### D1:独立 store `usage-benchmark.json`,active 会话 + 历史记录

新增 `packages/core/src/store/usage-benchmark-store.ts`,落盘 `~/.ai-productivity-tracker/data/usage-benchmark.json`,schema(version=1):

```jsonc
{
  "version": 1,
  "active": {
    // 进行中的测算会话;无进行中会话时为 null
    "id": "bmk-20260623-ab12cd",
    "label": "优化前", // 可选,用户填的一句话标签
    "sources": ["cursor", "codex"], // 开始时多选的工具集(至少 1 个)
    "startedAt": "2026-06-23T12:00:00.000Z",
    "totals": {
      // 仅含 sources 内的工具;随事件累加
      "cursor": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheCreation": 0,
        "total": 0,
        "turns": 0,
        "sessionIds": []
      },
      "codex": {
        /* 同构 */
      }
    }
  },
  "sessions": [
    // 已完成记录,按 endedAt 倒序;append-only(可删)
    {
      "id": "bmk-...",
      "label": "优化后",
      "sources": ["cursor", "codex"],
      "startedAt": "...",
      "endedAt": "...",
      "durationMs": 612000,
      "totals": {
        /* 同 active.totals 形态 */
      },
      "grandTotal": {
        "total": 0,
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheCreation": 0,
        "turns": 0
      } // 跨选中工具求和,便于列表/对比直接读
    }
  ]
}
```

- 工具维度键复用 `AiUsageSource`(`'cursor' | 'claude-code' | 'codex'`),不引新枚举。
- token 细分口径与 `AiUsageTokens` 完全一致(`total` = input+output+cacheCreation,剔除 cacheRead)。
- 每工具保留 `sessionIds`(distinct),用于展示「这段窗口跨了几个会话」;数量级极小。
- 函数式 API:`readBenchmark()` / `startBenchmark({label?, sources})` / `accumulateBenchmark(event)` / `stopBenchmark()` / `cancelBenchmark()` / `deleteBenchmark(id)`,并维护进程内 **active 缓存**(`hasActiveBenchmark()` 零盘 I/O)。
- **为何独立单文件**:与 `ai-usage.json` 的日聚合语义完全不同(窗口化、可起停、可对比),塞进去会污染 schema;独立文件让起停/对比逻辑自洽,且 daemon 重启后能从盘恢复 active 会话。

### D2:在 `recordUsage` 内部 tee,旁路累加进 active 会话

`recordUsage(event)` 内部在「整体用量日聚合」之外,新增一次 `accumulateBenchmark(event)`:

```text
recordUsage(event):
  if isAiUsageEnabled():        # 既有:整体用量日聚合,语义不变
      <现有 daily 累加 + 写 ai-usage.json>
  accumulateBenchmark(event)    # 新增:若有 active 会话且 event.source ∈ active.sources → 累加 + 写盘
```

- `accumulateBenchmark` 自身先查进程内 active 缓存,无 active 会话立即返回(零盘 I/O),保证非测算期间零开销。
- 命中时:按 `event.source` 累加 token 细分 + `turns += 1` + sessionId 去重,tmp+rename 写回。
- **幂等继承上游**:`recordUsage` 的调用点幂等由既有机制保证(Claude/Codex watcher 的 offset state 防重读、Cursor hook 的 dedupeKey 防重复 POST),测算累加直接受益,无需自建去重。

**替代方案(否决)**:在各采集链路分别插桩调用 benchmark —— 重复三处、易漏、与整体用量旁路逻辑割裂。`recordUsage` 单点 tee 是最小且收敛的接入。

### D3:采集闸门从「整体用量开启」放宽为「有任意消费者」

测算要独立于全局监控开关工作,但三处调用点当前用 `if (isAiUsageEnabled())` 把关,关闭时事件流不产生。引入:

```ts
// ai-usage-store / 同模块导出
export function isUsageCaptureActive(): boolean {
  return isAiUsageEnabled() || hasActiveBenchmark()
}
```

把三处调用点的闸门 `isAiUsageEnabled()` → `isUsageCaptureActive()`:

- `transcript-watcher.ts:591`、`codex-watcher.ts:524`、`routes/ai-productivity.ts:707`。
- `recordUsage` 内部仍各自判断:`isAiUsageEnabled()` 控制是否写 `ai-usage.json`(语义不变),`accumulateBenchmark` 控制是否写 benchmark。故「只开测算、全局监控关」时:`ai-usage.json` 不写、`usage-benchmark.json` 写;两者互不干扰。
- **零额外开销保证**:无测算且全局关时,`isUsageCaptureActive()` 两个分支都读进程内布尔缓存,返回 false,链路与改造前等价短路。

**风险定位**:`transcript-watcher` / `codex-watcher` / server 路由属中风险区(非 hook-core 客户端那种发布工程高危区),改动仅是「布尔闸门替换 + 单点 tee」,无新增文件 watch、无 IDE 子进程交互。仍走 `pnpm --filter core/server test` 回归。

### D4:会话生命周期与边界规则

- **开始**:`sources` 至少 1 个合法值,否则拒绝;已有 active 会话时拒绝(返回 409 语义,UI 提示先结束/取消),不静默覆盖。生成 `id`(时间戳 + 随机短串)。
- **结束**:把 active 的 `totals` 定格,计算 `durationMs = endedAt - startedAt` 与 `grandTotal`,push 进 `sessions`(倒序),清空 active。无 active 时返回明确错误。
- **取消**:直接清空 active,不写入 sessions。
- **删除**:按 id 从 sessions 移除;不存在则无操作(幂等)。
- **跨重启**:active 持久化在盘,daemon 重启后 `hasActiveBenchmark()` 首次读盘恢复缓存,测算继续(期间事件仍累加)。
- **时间窗边界**:Claude/Codex 用量按 watcher flush 时刻 `at` 归属;若一轮对话跨越 start/stop 边界,按 flush 落点归属(可接受的边界误差,A/B 对比关注量级差异而非单 token 精确)。

### D5:HTTP 端点(panel-origin 放行)

沿用既有 `/ai-productivity/*` 风格,集中在 `routes/ai-productivity.ts` + `http/server.ts`:

- `GET /ai-productivity/usage-benchmark` → `{ active, sessions }`(全量读盘,数据量小)。
- `POST /ai-productivity/usage-benchmark/start` body `{ label?, sources:string[] }` → `{ active }`;参数非法/已有 active → 4xx + 错误信息。
- `POST /ai-productivity/usage-benchmark/stop` → `{ session }`(刚定格的记录),active 置 null;无 active → 4xx。
- `POST /ai-productivity/usage-benchmark/cancel` → `{ active:null }`。
- `POST /ai-productivity/usage-benchmark/delete` body `{ id }` → `{ ok:true }`(幂等)。
- 全部加入 `isAiProductivityPanelPath` 放行集合(同源免 token)。
- 用 POST 子路径而非 RESTful `DELETE /:id`,与现有路由「字面 pathname 匹配」风格一致,避免引入路径参数解析。

### D6:前端页面「用量测算」

- `router.ts` `primaryNav` 增 `{ key:'usage-benchmark', label:'用量测算', icon:'i-lucide-timer', routeName:'usage-benchmark' }` + 路由。
- 新增 `tabs/UsageBenchmarkTab.vue`:
  - **控制区(idle 态)**:工具多选(`el-checkbox-group`,cursor / claude-code / codex)+ 标签输入(可空)+「开始记录」按钮(未选工具时禁用)。
  - **控制区(running 态)**:实时已用时长(本地 `setInterval` 计时)、所选工具、轮询拉取的滚动 totals(token + turns);「结束记录」「取消」按钮。轮询 `GET usage-benchmark`(如每 3–5s)刷新滚动值。
  - **历史列表**:每条 glass 卡片/表格行展示 label / 时间窗 / 时长 / 各工具 token 合计 / grandTotal;可多选 → 对比区。
  - **对比区**:选中 ≥2 条 → 并排表格(各工具细分 + 合计 + 差值/百分比)+ echarts 柱状图(按 grandTotal 或可切 token 维度对比)。
  - 删除记录按钮(二次确认)。
- `api.ts` 增类型(`UsageBenchmarkTotals`、`UsageBenchmarkSession`、`UsageBenchmarkState`)与 `fetchUsageBenchmark()` / `startUsageBenchmark(payload)` / `stopUsageBenchmark()` / `cancelUsageBenchmark()` / `deleteUsageBenchmark(id)`。
- 复用 `styles/tokens.css` / `glass.css` / `useChartTheme`;空态引导「开始一次记录」。

### D5b:隐私——仅结构化元数据

延续既有原则:测算只累加 `AiUsageEvent` 的结构化字段(source / token 细分 / turns / sessionId),**绝不入库对话正文 / 工具参数 / 模型输入输出**。`label` 由用户手填,仅作记录命名。

## Risks / Trade-offs

- [改三处采集闸门 `isAiUsageEnabled`→`isUsageCaptureActive`] → 改动是纯布尔谓词替换,无新增 I/O;`isUsageCaptureActive` 内部仍读进程内缓存,无测算时与原行为等价;`pnpm --filter core/server test` 回归 + 断言「无测算且全局关时 recordUsage 不被调用」。
- [active 会话跨 daemon 重启] → active 持久化落盘,`hasActiveBenchmark()` 首读恢复;测试覆盖重启后继续累加 + 进程缓存与盘一致。
- [窗口边界归属误差] → 接受:按 flush 时刻归属,A/B 对比关注量级;design D4 记录此 trade-off。
- [并发写 `usage-benchmark.json`] → 单 daemon 进程内串行触发 + tmp+rename;单实例锁保证无跨进程并发。
- [Cursor 非仓库会话依赖 hook-core 一直上报 usageOnly] → 既有行为(hook 客户端无条件上报),本变更不改;仅 daemon 侧闸门放宽即可纳入测算。
- [用户忘记结束记录导致窗口无限增长] → 可接受;UI 显著展示「记录进行中 + 计时」并提供取消;v1 不做超时自动结束(列 Non-Goal)。

## Migration Plan

- 纯新增:新 store 文件、新端点、新页面;`usage-benchmark.json` 惰性创建(无 active、空 sessions)。
- `ai-usage.json` schema 与写入语义零改动;三处闸门替换向后兼容(`isUsageCaptureActive` 在无测算时退化为 `isAiUsageEnabled`)。
- 回滚:删新增端点/页面/store + 把三处闸门改回 `isAiUsageEnabled()` 即可;`usage-benchmark.json` 残留无害。
- 发版:沿用 `pnpm release prerelease --publish` 叠 rc。

## Open Questions

- 暂无阻塞性未决项。后续可叠加项(超出 v1):测算超时自动结束、按需求/分支标注测算上下文、导出对比报告 Markdown、单条事件明细留存以支持窗口内更细的时间序列。
