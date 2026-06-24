## Why

当前工具只在「分支名含 Jira issue key」时才采集硬/软数据,以**需求**为维度统计提效。这导致大量真实 AI 用量被丢弃:在 `main`、`bugfix-*`、个人实验分支,或根本不在 git 仓库里发生的对话,都不会被记录。用户无法回答一个很基础的问题——「我今天到底在 Cursor / Claude Code / Codex 上各烧了多少 token、聊了多少轮」。

新增一个与需求维度正交的「AI 整体用量」模块,以**每个 AI 工具**为维度,自动、无差别地采集整体硬数据,给用户一个跨需求、跨分支的全局用量视图。

设计参考了用户本机已安装的 loongsuite-pilot(阿里 LoongSuite 的本地 AI 用量采集器):借鉴其「全 agent Hook 采集 + OpenTelemetry GenAI 语义约定归一化 + 丰富按日聚合」的数据模型,但**自建复刻、不依赖该工具是否安装**,采集逻辑随 `@ai-productivity-tracker/cli` 包分发。

- **新增侧边栏菜单「AI 用量」**:点击进入独立页面,顶部以卡片并排展示 Cursor / Claude Code / Codex 各自的整体用量。
- **页面顶部提供监控开关**:全局开启/关闭「AI 整体用量采集」。关闭时不写任何整体用量数据,开关状态持久化到本机配置,默认关闭(opt-in)。
- **新增整体用量采集链路**:开关开启时,从各 AI 的会话来源自动抓取用量,按 `AI 工具 × 自然日` 聚合落盘。该链路**独立于 Jira 绑定**——不要求分支含 issue key,`main` 分支、非 git 目录会话也计入。
- **采集"全"、展示先"简"**:采集层内部 schema 对齐 OTel GenAI 语义约定,落盘保留 token 细分(input/output/cacheRead/cacheCreation)、对话次数/会话数、可得的 model/provider 维度;v1 看板仅呈现「每个 AI 当天 token + 对话次数」与趋势,丰富维度入库但暂不全部上屏。
- **新增整体用量查询 HTTP 端点**:看板通过同源 API 读取按 AI、按日聚合后的用量数据与开关状态。
- **页面底部展示用量趋势图表**:用既有 echarts 封装,直观展示近 N 天各 AI 的消耗曲线。
- **界面风格沿用现有设计 token / glass 卡片体系**,与「需求看板」「复盘经验」等页面保持一致。

## Capabilities

### New Capabilities

- `ai-usage-overview`: 以每个 AI 工具为维度的整体用量采集、聚合、查询与展示能力,包括监控开关、按 AI×日聚合的硬数据采集、查询 HTTP 端点、看板「AI 用量」页面(卡片 + 趋势图表)。

### Modified Capabilities

<!-- openspec/specs/ 当前为空,无既有能力的需求变更。整体用量采集复用但不改变既有 watcher 的需求采集行为(向后兼容、新增旁路)。 -->

## Impact

- **`packages/core`**:新增整体用量 store(`ai-usage.json`,按 AI×日聚合 OTel 对齐的丰富字段)与采集开关;定义归一化 `AiUsageEvent`(OTel GenAI 子集);在既有 `TranscriptWatcher`(Claude)/ `CodexWatcher`(Codex)的 flush 点、Jira issueKey 闸门**之前**新增「整体用量旁路」,开关关闭时短路;watcher 文件追踪 state 从 `offset+mtime` 升级为 `offset+size+ino`(借鉴 loongsuite,识别 inode 变化/轮转,增强幂等)。
- **`packages/hook-core` / Cursor 数据源**:Cursor 无 transcript,经 Hook 采集;放宽「无 project root 即静默退出」,在退出前仍向 daemon 上报最小化用量信号(具体方案与降级见 design.md D3)。
- **`packages/server`**:`handleAiProductivityHook` 在 issueKey 解析前记录 Cursor 整体用量;新增 `GET /ai-productivity/ai-usage`(聚合用量 + 开关)与 `PATCH /ai-productivity/ai-usage/config`(切换开关)路由,归入 panel-origin 放行。
- **`packages/ui`**:新增 `router.ts` 菜单项与路由、`tabs/AiUsageTab.vue` 页面(卡片 + 开关 + 趋势图,v1 简单展示),`api.ts` 新增客户端方法与完整类型。
- **数据兼容**:纯新增文件/端点;watcher state 升级向后兼容(缺字段兜底);不改既有 requirement / iteration / formula schema,不依赖第三方工具,无 BREAKING。
