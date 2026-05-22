# AI Productivity Tracker 独立化 PRD

> 文档版本：v1.0.0
> 状态：迁移设计（待评审 → 实施）
> 作者：zhongleijian
> 最后更新：2026-05-22
> 源项目：`instant-web-tools / web-tool-platform`（`apps/web/src/modules/ai-productivity-tracker/` + `apps/local-agent-service/src/services/ai-productivity/*` + `packages/ai-productivity-mcp/` + `packages/ai-productivity-hook-core/` + `skills/ai-productivity-*`、`skills/lessons-extract/`）
> 目标项目：`my/ai-productivity-tracker`（本仓库）

---

## 0. TL;DR

把当前嵌在 `instant-web-tools` 平台里的 **AI 提效追踪工具**整体迁出来，做成一个**独立、自包含、npm 可分发**的产品。

- 用户安装：`npm i -g @ai-productivity-tracker/cli` 或直接 `npx @ai-productivity-tracker/cli ...`。
- 用户使用：在 IDE（Cursor / Claude Code 等）的 MCP 配置里指向 `npx @ai-productivity-tracker/cli mcp`；浏览器打开 `http://127.0.0.1:17350` 即可看到看板。
- **不再依赖** `truesight-agent` 本地服务，**不再依赖** `web-tool-platform` Web 应用，**不再依赖** `launchctl`/`launchd`。
- 所有原能力（init / status / attach_summary / lessons / hook / stop-check / watcher / skill 注入 / 看板 UI）一比一保留，**对 LLM / 用户配置端的协议尽量保持向后兼容**。

---

## 1. 现状（源系统）盘点

### 1.1 当前体系组成（5 块）

| #   | 模块                      | 路径（源仓库）                                                                                   | 行数         | 角色                                                                                                                                                                                                                                 |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | 前端看板                  | `apps/web/src/modules/ai-productivity-tracker/`                                                  | ~5.3k        | Vue 3 SPA，注册成平台一个 module；6 个 Tab：需求看板 / 复盘经验 / 业务配置 / MCP 配置 / 工具说明 / 使用说明                                                                                                                          |
| ②   | 本地 Agent（HTTP daemon） | `apps/local-agent-service/`                                                                      | ~3k+ AI 相关 | Node `http.createServer`，端口 17280，提供 30+ 个 `/ai-productivity/*` 端点 + WebSocket（仅终端用，非本能力域）                                                                                                                      |
| ③   | MCP 服务                  | `packages/ai-productivity-mcp/`                                                                  | ~1k          | stdio MCP，提供 5 个 tool：`ai_productivity_init` / `ai_productivity_status` / `ai_productivity_attach_summary` / `ai_productivity_extract_bundle` / `ai_productivity_save_lessons`；同时通过 argv 复用为 `hook` / `stop-check` 入口 |
| ④   | Hook 核心库               | `packages/ai-productivity-hook-core/`                                                            | ~1.7k        | 纯逻辑库：runHook / runStopCheckCli / installCursorHookFile / sentinel / loadAgentEndpoint                                                                                                                                           |
| ⑤   | Skill / Cursor Rule 模板  | `skills/ai-productivity-{init,track}/`、`skills/lessons-extract/`、`skills/clarify-requirement/` | ~630         | 通过 agent `/install-track-skill` 写到用户 `~/.claude/skills/` 与 `~/.cursor/rules/`                                                                                                                                                 |

### 1.2 关键运行模型（当前）

```
┌─────────────────────────────────────────────────────────────────────┐
│  用户机器                                                            │
│                                                                      │
│  ┌──────────────┐  stdio   ┌──────────────────────┐                  │
│  │ Cursor IDE   │ ───────► │ ai-productivity-mcp  │ ─┐               │
│  └──────────────┘          │ (Node 子进程,IDE 拉)  │  │               │
│  ┌──────────────┐  stdio   └──────────────────────┘  │ HTTP          │
│  │ Claude Code  │ ─────────────────────────────────► │ + Bearer      │
│  └──────────────┘                                     ▼ token        │
│                                                ┌────────────────┐    │
│  ┌──────────────────────────────────────────►  │ truesight-agent│    │
│  │ Cursor hooks.json afterAgentResponse:        │ launchd 守护    │    │
│  │   node ~/Downloads/ai-productivity-mcp.mjs   │ 127.0.0.1:17280│    │
│  │   hook  # ai-productivity-hook               └──┬─────────────┘    │
│  └──────────────────────────────────────────────────┤                  │
│  ┌──────────────────────────────────────────────────┤                  │
│  │ Claude Code ~/.claude/settings.json hooks:       │ 读写             │
│  │   Stop + UserPromptSubmit                        ▼                  │
│  └─────────────────────────────────────────────► ~/.truesight-       │
│                                                  local-agent/         │
│                                                  ├── config.json       │
│                                                  ├── logs/             │
│                                                  └── ai-productivity/  │
│                                                      ├── bindings.json │
│                                                      ├── formula.json  │
│                                                      ├── jira.json     │
│                                                      ├── lessons/      │
│                                                      ├── pending-summary.json
│                                                      ├── recent-attach-sentinel.json
│                                                      ├── transcript-state.json
│                                                      └── <JIRA-KEY>/   │
│                                                          ├── requirement.json
│                                                          ├── iterations.jsonl
│                                                          ├── subtask-events.jsonl
│                                                          └── raw/      │
│                                                                       │
│  ┌────────────────────────────────────────────────┐                   │
│  │ 浏览器 https://web-tool-platform.../modules/…  │                   │
│  │   通过同源 Origin → CORS panel 放行            │                   │
│  │   fetch http://127.0.0.1:17280/ai-productivity │                   │
│  └────────────────────────────────────────────────┘                   │
│                                                                      │
│  transcript-watcher（agent 内常驻线程，扫 ~/.claude/projects/*.jsonl）│
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 数据原子（迁移时**必须 1:1 保留**）

#### 文件布局（用户机器）

```
~/.truesight-local-agent/
├── config.json                 # token + port + allowedOrigins
└── ai-productivity/
    ├── index.json              # jiraKey 全局索引
    ├── bindings.json           # cwd ↔ jiraKey 映射、最近活跃 binding
    ├── formula.json            # 提效公式参数
    ├── jira.json               # Jira 凭证
    ├── pending-summary.json    # attach_summary pending 中间态
    ├── recent-attach-sentinel/ # 防伪造校验（10s + 90s 时间窗）
    ├── lessons/
    │   ├── INDEX.json
    │   └── lsn-<JIRA>-<rand>.json
    └── <JIRA-KEY>/
        ├── requirement.json
        ├── iterations.jsonl
        ├── subtask-events.jsonl
        ├── numstat-snapshot.json
        └── raw/<seq>.json

~/.cursor/
├── hooks.json                  # afterAgentResponse → node <abs>.mjs hook
├── mcp.json                    # 用户填的 MCP 配置
└── rules/
    ├── ai-productivity-track.mdc
    └── lessons-extract.mdc

~/.claude/
├── settings.json               # Stop / UserPromptSubmit hooks
└── skills/
    ├── ai-productivity-track/SKILL.md
    └── lessons-extract/SKILL.md
```

#### MCP Tool 协议（**对 IDE / LLM 完全冻结**）

| Tool                             | 入参                                                                              | 出参                                                               |
| -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ai_productivity_init`           | `{ jira, title?, projectRoot?, summary?, manualEstimateMinutes?, complexity? }`   | `{ jiraKey, branch, gitRoot, panelUrl }`                           |
| `ai_productivity_status`         | `{ projectRoot? }`                                                                | `{ bound, branch, issueKey, jiraKey?, cumulativeToken?, gitRoot }` |
| `ai_productivity_attach_summary` | `{ oneLine, type?, changeScope?, discussion?, jiraKey?, branch?, source?, cwd? }` | `{ ok: true, updated, pending?, jiraKey, iterationSeq, reason? }`  |
| `ai_productivity_extract_bundle` | `{ jiraKey, cwd? }`                                                               | `LessonsBundle`（含 `computedSignals`）                            |
| `ai_productivity_save_lessons`   | `{ jiraKey, lessons[], source?, projectSlug? }`                                   | `{ saved[], savedCount, replaced[], rejected[] }`                  |

#### HTTP 端点（**当前 30+ 端点全部保留**，仅 host 从外部域改为同源 loopback）

```
GET   /status                                    # daemon 心跳
GET   /ai-productivity/storage-path
GET   /ai-productivity/watcher-status
GET   /ai-productivity/cursor-hook-status
POST  /ai-productivity/install-cursor-hook
POST  /ai-productivity/install-mcp-entry        # 见 §3.6 改造
GET   /ai-productivity/track-skill-status
POST  /ai-productivity/install-track-skill
GET   /ai-productivity/summary
GET   /ai-productivity/formula
PATCH /ai-productivity/formula
GET   /ai-productivity/jira-config
PATCH /ai-productivity/jira-config
GET   /ai-productivity/requirements?owner&status&project&q
GET   /ai-productivity/requirements/:jiraKey
PATCH /ai-productivity/requirements/:jiraKey
GET   /ai-productivity/requirements/:jiraKey/iterations
PATCH /ai-productivity/requirements/:jiraKey/subtasks/:subtaskId
POST  /ai-productivity/requirements/:jiraKey/refresh-bugs
POST  /ai-productivity/requirements/:jiraKey/sync-jira-title
GET   /ai-productivity/requirements/:jiraKey/lessons-bundle
GET   /ai-productivity/lessons?jiraKey&type&tag&q&scope&projectSlug
POST  /ai-productivity/lessons
GET   /ai-productivity/lessons/:id
DELETE /ai-productivity/lessons/:id

# IDE / Hook 主鉴权链路（仍需 Bearer token）
POST  /ai-productivity/init
GET   /ai-productivity/status
POST  /ai-productivity/hook
POST  /ai-productivity/attach-summary
```

### 1.4 平台耦合点（迁移时必须解开）

| #   | 耦合点                                   | 当前实现                                                                                       | 影响                                         |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| C1  | **CORS allowedOrigins**                  | `config.ts` 硬编码 `web-tool-platform.*` 等业务域名                                            | 看板必须由 web-tool 平台托管才能 fetch agent |
| C2  | **公开下载链路**                         | `apps/web/public/downloads/ai-productivity-mcp/*.mjs` + `skills/*` 由 web 静态分发             | 用户必须能访问 web-tool 才能下载 .mjs        |
| C3  | **launchd plist**                        | `~/Library/LaunchAgents/com.truesight.local-agent.plist` 守护 agent 进程                       | macOS-only，需要单独命令重启                 |
| C4  | **panel-origin 放行**                    | `isAiProductivityPanelPath` 白名单豁免 token                                                   | 与 web 平台域名强绑定                        |
| C5  | **agent 多职责复用**                     | 同一个 daemon 还承载 NAS / 协议 / S3 / 钉钉 / WebSocket 终端                                   | 想独立化必须拆出 AI 提效那块                 |
| C6  | **前端 module registry**                 | `apps/web/src/modules/registry.ts` 注册成平台模块、依赖 `packages/ui`/`packages/module-sdk` 壳 | 不能直接拿来跑                               |
| C7  | **AGENT_BASE 硬编码**                    | 前端 `AGENT_BASE = 'http://127.0.0.1:17280'`                                                   | 端口冲突时不可调整                           |
| C8  | **MCP 入口路径硬编码**                   | `~/Downloads/ai-productivity-mcp.mjs` 是用户「一键下载」目标                                   | 没有 npm 分发通道                            |
| C9  | **mcp.mjs 与 build 一起拷到 web public** | `build.mjs` 直接写 `apps/web/public/downloads/`                                                | 出包流程依附 web 项目                        |
| C10 | **数据根目录命名**                       | `~/.truesight-local-agent/ai-productivity/`                                                    | 命名带"truesight"私有品牌                    |

---

## 2. 迁移目标与设计原则

### 2.1 目标（用户提出的 4 点）

| #   | 用户原话                                                        | 设计落点                                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| G1  | 后端能力直接集成到 MCP 服务，用户只装一个 MCP                   | npm 单包同时承载 stdio MCP / HTTP daemon / 面板静态资源 / Hook 入口                                                          |
| G2  | 发到 npm，通过 npx 使用                                         | 包名 `@ai-productivity-tracker/cli`，`bin: ai-productivity-tracker`；IDE MCP 配置：`npx -y @ai-productivity-tracker/cli mcp` |
| G3  | npx 启动 MCP 服务后自动起端口展示看板                           | daemon 默认监听 `127.0.0.1:17350`，自动注册静态资源路由 `/`、`/assets/*`、API 路由 `/ai-productivity/*`                      |
| G4  | 基于本地文件抓取/上报/分析逻辑都可不变（skills/rules 注入形式） | 5 个 MCP tool + 全部 skill 文案 1:1 迁移                                                                                     |

### 2.2 设计原则（HARD）

1. **协议向后兼容**：MCP tool 名 / 入参 / 出参 / HTTP 端点路径 / 文件 schema 全部冻结。skill / rule 文案可同步升级版本号但不改语义。
2. **单进程多角色**：通过 argv-router 分发 `mcp` / `daemon` / `hook` / `stop-check` / `ui` / `install` / `doctor` 等命令。
3. **零网络依赖**：不调云端 LLM、不上报任何遥测、不下载外部资源；唯一可选外部调用是用户配置的 Jira REST（继承当前实现）。
4. **零特权安装**：纯 npm 包，不写 `launchctl` / `systemd`、不要求 sudo；daemon 由 MCP 进程在需要时 spawn-detached。
5. **跨平台**：macOS / Linux / Windows 都要可跑；Hook 安装与路径处理替换 `~/` 为 `os.homedir()`。
6. **可被 Cursor / Claude Code / Codex 等任意 MCP 客户端使用**：不假设 IDE 类型，IDE 特异性逻辑（hook 路径 / settings.json schema）按 IDE 分支处理。
7. **演进路径**：保留 `TRUESIGHT_AIP_ROOT` 兼容 env，并新增 `AIPT_DATA_ROOT`；提供一次性 `migrate` 命令把老数据搬到新根。

### 2.3 非目标（这一期不做）

- 不重写看板 UI（Vue 3 + Element Plus 沿用）。
- 不重写 transcript-watcher / metrics / lessons-store / hook-core 等业务核心；只做"挪窝"。
- 不迁移源仓库里的 NAS / S3 / 钉钉 / 协议 / WebSocket 终端能力（属于 local-agent-service 但**不属于** AI 提效追踪域）。
- 不做团队/云端聚合、不做账号体系。完全本机使用。

---

## 3. 目标架构

### 3.1 顶层运行模型

```
┌────────────────────────────────────────────────────────────────────────┐
│  用户机器                                                                │
│                                                                          │
│  ┌──────────────┐  stdio  ┌────────────────────────────────────────┐    │
│  │ Cursor IDE   │ ───────►│  ai-productivity-tracker mcp           │    │
│  └──────────────┘         │  (子进程,IDE 拉起,极薄 stdio↔HTTP 桥) │ ┐  │
│                           └────────────────────────────────────────┘ │  │
│  ┌──────────────┐  stdio  ┌────────────────────────────────────────┐ │  │
│  │ Claude Code  │ ───────►│  ai-productivity-tracker mcp           │ │  │
│  └──────────────┘         └────────────────────────────────────────┘ │  │
│                                                                       │  │
│  ┌──────────────┐  HTTP   ┌────────────────────────────────────────┐ │  │
│  │ Cursor hook  │ ───────►│  ai-productivity-tracker hook          │ ├─┤ │
│  │ Claude hook  │         │  (短 CLI,读 stdin,POST daemon)        │ │  │
│  └──────────────┘         └────────────────────────────────────────┘ │  │
│                                                                       ▼  │
│                          ┌────────────────────────────────────────────┐ │
│                          │  ai-productivity-tracker daemon            │ │
│  ┌──────────────┐  HTTP  │  (单实例后台进程,被首个 mcp 自动 spawn)    │ │
│  │ 浏览器        │ ─────► │  127.0.0.1:17350                           │ │
│  │ Web UI 看板  │        │  ├─ Static SPA  (/)                       │ │
│  └──────────────┘        │  ├─ JSON API    (/ai-productivity/*)      │ │
│                          │  ├─ transcript-watcher                     │ │
│                          │  └─ Hook entry refresher                   │ │
│                          └─────────────────┬──────────────────────────┘ │
│                                            │ 读写                       │
│                                            ▼                            │
│                          ┌────────────────────────────────────────────┐ │
│                          │  ~/.ai-productivity-tracker/               │ │
│                          │  ├── runtime.json   {port,token,pid}       │ │
│                          │  ├── config.json    {formula,jira,...}      │ │
│                          │  ├── logs/                                  │ │
│                          │  └── data/                                  │ │
│                          │      ├── bindings.json                      │ │
│                          │      ├── lessons/                           │ │
│                          │      ├── pending-summary.json               │ │
│                          │      ├── recent-attach-sentinel/            │ │
│                          │      ├── transcript-state.json              │ │
│                          │      └── <JIRA-KEY>/...                     │ │
│                          └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

#### 进程拓扑

| 进程                  | 生命周期                                                                                    | 数量                                              | 通信                              |
| --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- |
| `daemon`              | 后台常驻（fork-detached），第一个 `mcp` 子进程启动时自动 spawn；用户也可手动 `npx … daemon` | **全局唯一**（通过 `runtime.json` lockfile 互锁） | 监听 127.0.0.1:17350              |
| `mcp`                 | 与 IDE 一一对应，IDE 退出即退出                                                             | N 个（每个 IDE/窗口一个）                         | stdio ↔ IDE；HTTP+Bearer ↔ daemon |
| `hook` / `stop-check` | 一次性短 CLI（每次 hook 事件触发）                                                          | 触发即起触发即退                                  | stdin ← IDE；HTTP+Bearer → daemon |
| 浏览器看板            | 用户主动打开                                                                                | 任意                                              | 同源 HTTP → daemon                |

> daemon 单实例由 `runtime.json` 中的 `pid` + 健康探活保证；任意时刻只有一个进程绑定 17350 端口（端口被占时同时 lockfile 探活，发现旧 pid 已死 → 接管端口）。

### 3.2 npm 包结构

```
@ai-productivity-tracker/cli                  (主包,用户直接 npx)
├── package.json                              {bin: {ai-productivity-tracker: dist/cli.mjs}}
├── README.md
├── CHANGELOG.md
└── dist/
    ├── cli.mjs                               # esbuild 单文件 bundle,1 个 Node 入口
    ├── cli.mjs.map
    └── web/                                  # 看板 SPA 静态产物(Vite build)
        ├── index.html
        ├── assets/*.{js,css,svg,png}
        └── …
```

> 产物完全 self-contained：单 `cli.mjs` ≈ 800KB - 1.5MB（含 MCP SDK / zod / chokidar 等依赖 bundle），加上 Vue 看板 ≈ 1MB（gzip ~300KB），整包 < 3MB。

### 3.3 子命令 / 入口设计（argv-router）

入口文件 `dist/cli.mjs` 第一个 arg 决定角色（沿用当前 mcp.mjs 的 argv-router 思路，扩展子命令空间）：

| 命令                                  | 行为                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mcp` _(主入口)_                      | 启 stdio MCP server，启动时**确保** daemon 在线（不在则 spawn-detached），随后只做协议转换   |
| `daemon` _(别名 `serve`)_             | 前台启 daemon（HTTP + watcher），打印面板 URL；用户手动用，或 launchd/systemd 拉起           |
| `hook`                                | Cursor `afterAgentResponse` 入口；读 stdin → 解析 → POST daemon `/ai-productivity/hook`      |
| `stop-check`                          | Cursor `stop` + Claude Code `Stop` 入口；防伪造校验                                          |
| `ui open`                             | 检测 daemon 状态，必要时 spawn，再 `open ${url}` 唤起默认浏览器                              |
| `install [--ide=cursor\|claude\|all]` | 一键安装：注入 hook/skill/rule 到对应 IDE 配置                                               |
| `install-mcp [--ide=cursor]`          | 把 `npx … mcp` 这条 JSON 项写入 `~/.cursor/mcp.json`（覆盖式）                               |
| `migrate`                             | 把 `~/.truesight-local-agent/ai-productivity/` 旧数据搬到 `~/.ai-productivity-tracker/data/` |
| `doctor`                              | 体检：daemon 健康 / runtime.json 完整 / hook 安装 / skill 安装 / 老数据是否需要迁移          |
| `version`                             | 打印当前 cli 版本                                                                            |
| `--help` / 无 arg                     | 打印用法                                                                                     |

兼容旧 argv：`hook` / `stop-check` / `mark-tool-called` 保持现行语义，方便用户从老 `mcp.mjs` 平滑切换。

### 3.4 daemon 单实例 + 自动 spawn 策略

```ts
// dist/cli.mjs (伪代码)
async function ensureDaemon(): Promise<{ port: number; token: string }> {
  const lockPath = join(homedir(), '.ai-productivity-tracker', 'runtime.json')
  const lock = readLockIfFresh(lockPath) // 读 pid + port + token,pid 存活则视为活
  if (lock && (await ping(`http://127.0.0.1:${lock.port}/status`, lock.token))) {
    return lock
  }

  // spawn detached daemon
  const port = lock?.port ?? pickAvailablePort(17350)
  const token = lock?.token ?? randomBytes(32).toString('hex')
  const child = spawn(process.execPath, [process.argv[1], 'daemon', '--port', port, '--token', token], {
    detached: true,
    stdio: ['ignore', openLogFd('out.log'), openLogFd('err.log')]
  })
  child.unref()

  await waitForReady(`http://127.0.0.1:${port}/status`, token, 5000)
  return { port, token }
}

if (argv[2] === 'mcp') {
  const { port, token } = await ensureDaemon()
  await startStdioMcp({ baseUrl: `http://127.0.0.1:${port}`, token })
}
```

关键点：

- **`runtime.json`** 是唯一的进程协调凭证；schema：`{ pid, port, host: '127.0.0.1', token, startedAt, version, dataRoot }`。
- 端口默认 `17350`（与旧 17280 错开，避免与残留 `truesight-agent` 撞车）；可被 env `AIPT_PORT` 覆盖。
- 用户也可 `npx … daemon --port 17350` 手动前台跑（方便看日志、用 systemd 守护）。
- daemon 写日志到 `~/.ai-productivity-tracker/logs/daemon.log`（按天滚动）。

### 3.5 安全模型

| 维度       | 设计                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 监听地址   | 强制 `127.0.0.1`（不开 `0.0.0.0`）                                                                                                                      |
| 鉴权       | Bearer token；token 在首次 daemon 启动时生成，保存到 `runtime.json`（mode 0600）                                                                        |
| CORS       | 默认放行 `http://127.0.0.1:*` 与 `http://localhost:*`；同源访问无需 token。额外可在 `config.json.allowedOrigins[]` 自定义（移除当前所有平台域名硬编码） |
| 浏览器同源 | 看板由 daemon 自服务，浏览器访问 `http://127.0.0.1:17350` 时是同源请求 → 自动放行                                                                       |
| MCP / Hook | 子进程通过 `runtime.json` 读 token，HTTP 调用带 `Authorization: Bearer <token>`                                                                         |
| 跨网络     | 拒绝任何非 loopback 请求（在 server 层校验 `req.socket.remoteAddress`）                                                                                 |
| 文件权限   | `~/.ai-productivity-tracker/` 与 `runtime.json` 强制 `chmod 700/600`                                                                                    |

### 3.6 看板 UI 改造点（前端）

| 当前实现                                                   | 迁移后                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册到 `apps/web/src/modules/registry.ts` 平台 module 容器 | 独立 Vite SPA，`index.html` 是单页入口，Vue Router 直接路由 6 个 Tab                                                                                                                         |
| 使用 `packages/ui/ToolWorkbenchShell` 平台外壳             | 内置极简壳层（顶部 Tab Bar + 内容区），CSS 沿用 `aip-shared.css`                                                                                                                             |
| `AGENT_BASE = 'http://127.0.0.1:17280'` 跨域 fetch         | 改为相对路径（同源）；当 daemon 端口非默认时通过 `<meta name="x-aipt-port">` 注入                                                                                                            |
| "一键下载 mcp.mjs" 按钮（指向 web 静态资源）               | 改文案为 **"已通过 npm 安装"**，展示当前 daemon 版本 + 给出 IDE MCP JSON 复制片段                                                                                                            |
| "MCP 版本对比"（线上 vs 本地）                             | 改为 **"当前 daemon 版本 vs npm latest"**（可选；通过 `GET /status` 拿本地版本 + 用户手动跑 `npm view @ai-productivity-tracker/cli version` 对比，或干脆下线该面板，由 `doctor` 子命令承担） |
| "一键注入 Hook"按钮                                        | 保留；端点参数从 `mcpAbsolutePath = ~/Downloads/...mjs` 改为 daemon 自动定位的 npm 安装路径（`require.resolve` 拿到 `dist/cli.mjs` 绝对路径）                                                |
| "一键注入 Skill"                                           | 保留；模板文案 1:1 迁移；写盘路径不变（`~/.claude/skills/`、`~/.cursor/rules/`）                                                                                                             |
| Element Plus / 中文 i18n / theme                           | 1:1 保留                                                                                                                                                                                     |
| 平台主题（深浅双色）                                       | 看板内置开关，不再依赖 platform-ui 主题包                                                                                                                                                    |

### 3.7 端口冲突 / 多实例策略

1. 启动 daemon 时优先用 `runtime.json` 里上次记录的 port。
2. 该 port 占用且无法连接 → 视为残留进程或被其他人占用，**回退**到端口扫描（从 17350 起 +1 探测 20 个）。
3. 选定新 port → 更新 `runtime.json` → 已经运行的 mcp / hook 子进程会按 lockfile 重新指向。
4. 用户也可在 `~/.ai-productivity-tracker/config.json` 显式锁定 `port`（写定后 daemon 拒绝换端口，失败则报错）。

### 3.8 老数据 / 老安装迁移

| 来源                                                                                                       | 迁移动作                                                                                                    | 触发方式                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `~/.truesight-local-agent/ai-productivity/*`                                                               | 文件级 `cp -r` 到 `~/.ai-productivity-tracker/data/`；保留源不动                                            | `npx … migrate`（手动）、或 daemon 启动时若新根空 + 老根存在 → 提示用户跑 migrate |
| `~/.truesight-local-agent/config.json.token`                                                               | 不迁移（新 token 独立生成）                                                                                 | —                                                                                 |
| Cursor `hooks.json` 老条目（指向 `~/Downloads/ai-productivity-mcp.mjs` 或 `~/.local/bin/ai-productivity`） | `install` 子命令检测后**替换为**新绝对路径（继承当前 `LEGACY_CLI_PATH_PATTERN` 清理逻辑）                   | `npx … install`                                                                   |
| Claude `~/.claude/settings.json` 老 Stop / UserPromptSubmit hooks                                          | 同上，marker 命中后覆盖；旧 marker `ai-productivity-mark-tool-called` 顺手清掉（继承 v2.13.0 cleanup 逻辑） | `npx … install`                                                                   |
| `~/.cursor/rules/ai-productivity-track.mdc` / `~/.claude/skills/ai-productivity-track/SKILL.md`            | 覆盖式重写，含新版本 marker                                                                                 | `install`                                                                         |

---

## 4. 目标项目目录结构

```
ai-productivity-tracker/                       (本仓库根)
├── package.json                               # 顶层 pnpm workspace 配置
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md                                  # 面向用户的安装/使用
├── LICENSE                                    # MIT
├── docs/
│   ├── PRD.md                                 # 本文档
│   ├── ARCHITECTURE.md                        # 详细架构与时序图
│   ├── MIGRATION.md                           # 老用户迁移手册
│   ├── HOOK-PROTOCOL.md                       # Cursor/Claude hook 协议描述
│   ├── DATA-MODEL.md                          # 文件 schema 详细字段
│   └── CHANGELOG.md
│
├── packages/
│   ├── cli/                                   # 发布包 @ai-productivity-tracker/cli
│   │   ├── package.json                       # bin: ai-productivity-tracker
│   │   ├── build.mjs                          # esbuild 单文件 bundle
│   │   ├── src/
│   │   │   ├── index.ts                       # argv-router 入口
│   │   │   ├── commands/
│   │   │   │   ├── mcp.ts                     # 子命令 mcp
│   │   │   │   ├── daemon.ts                  # 子命令 daemon
│   │   │   │   ├── hook.ts                    # 子命令 hook(复用 hook-core)
│   │   │   │   ├── stop-check.ts              # 子命令 stop-check
│   │   │   │   ├── install.ts                 # 一键安装 hook + skill
│   │   │   │   ├── install-mcp.ts             # 写入 ~/.cursor/mcp.json
│   │   │   │   ├── migrate.ts                 # 老数据迁移
│   │   │   │   ├── doctor.ts                  # 体检
│   │   │   │   ├── ui.ts                      # 唤起浏览器
│   │   │   │   └── version.ts
│   │   │   ├── lib/
│   │   │   │   ├── runtime-lock.ts            # runtime.json 读写 + 探活
│   │   │   │   ├── ensure-daemon.ts           # mcp/hook 启动时自动拉起 daemon
│   │   │   │   ├── pick-port.ts               # 端口扫描
│   │   │   │   ├── paths.ts                   # 新根目录解析
│   │   │   │   └── log.ts
│   │   │   └── version.ts                     # 编译期注入版本号
│   │   └── tsconfig.json
│   │
│   ├── core/                                  # 数据模型 / 业务核心 (不直接发布,被 cli/server bundle)
│   │   ├── package.json                       # @ai-productivity-tracker/core (private)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── store/                         # 1:1 迁自 apps/local-agent-service/src/services/ai-productivity/store
│   │   │   │   ├── paths.ts
│   │   │   │   ├── requirement-store.ts
│   │   │   │   ├── iteration-store.ts
│   │   │   │   ├── index-store.ts
│   │   │   │   ├── formula-store.ts
│   │   │   │   ├── jira-config-store.ts
│   │   │   │   ├── lessons-store.ts
│   │   │   │   ├── pending-summary.ts
│   │   │   │   ├── recent-attach-sentinel.ts
│   │   │   │   ├── subtask-event-store.ts
│   │   │   │   └── numstat-snapshot.ts
│   │   │   ├── bindings.ts                    # cwd ↔ jiraKey 映射
│   │   │   ├── jira.ts                        # parseJiraReference
│   │   │   ├── git.ts                         # findGitRoot / extractIssueKey / getCurrentBranch
│   │   │   ├── git-diff.ts                    # numstat / HEAD sha
│   │   │   ├── iteration-extras.ts            # thinkSeconds / token 口径
│   │   │   ├── jira-bug-client.ts             # 关联 Bug 数刷新 + sync-jira-title
│   │   │   ├── metrics.ts                     # boost 计算
│   │   │   ├── project-meta.ts                # package.json name → projectSlug
│   │   │   ├── claude-message.ts              # transcript jsonl 解析
│   │   │   ├── jsonl-incremental.ts
│   │   │   ├── hook-dedupe.ts
│   │   │   ├── transcript-watcher.ts          # ~/.claude/projects watcher
│   │   │   ├── watcher-state.ts
│   │   │   └── track-skill-templates.ts       # skill / rule 内嵌模板字符串
│   │   └── __tests__/                         # 全部既有 .spec.ts 迁移
│   │
│   ├── hook-core/                             # @ai-productivity-tracker/hook-core (private)
│   │   ├── package.json
│   │   └── src/                               # 1:1 迁自 packages/ai-productivity-hook-core
│   │       ├── index.ts
│   │       ├── hook.ts
│   │       ├── install-cursor-hook.ts
│   │       ├── stop-check.ts
│   │       └── lib/
│   │           ├── agent-client.ts            # 改成读 runtime.json 的实现
│   │           ├── sentinel.ts
│   │           ├── paths.ts                   # 改成 ~/.ai-productivity-tracker/
│   │           ├── files.ts
│   │           ├── git.ts
│   │           └── tracking-context.ts
│   │
│   ├── server/                                # @ai-productivity-tracker/server (private)
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts                       # startDaemon(port, token, deps)
│   │       ├── http/
│   │       │   ├── server.ts                  # createServer + router
│   │       │   ├── cors.ts                    # 默认 loopback + 用户白名单
│   │       │   ├── auth.ts                    # Bearer + same-origin bypass
│   │       │   ├── envelope.ts                # OK/ERROR 统一信封
│   │       │   ├── static.ts                  # 服务 dist/web/ 看板 SPA
│   │       │   └── routes/
│   │       │       ├── status.ts
│   │       │       ├── ai-productivity/
│   │       │       │   ├── init.ts
│   │       │       │   ├── status.ts
│   │       │       │   ├── hook.ts
│   │       │       │   ├── attach-summary.ts
│   │       │       │   ├── requirements.ts
│   │       │       │   ├── iterations.ts
│   │       │       │   ├── formula.ts
│   │       │       │   ├── jira-config.ts
│   │       │       │   ├── refresh-bugs.ts
│   │       │       │   ├── sync-jira-title.ts
│   │       │       │   ├── summary.ts
│   │       │       │   ├── storage-path.ts
│   │       │       │   ├── watcher-status.ts
│   │       │       │   ├── cursor-hook-status.ts
│   │       │       │   ├── install-cursor-hook.ts
│   │       │       │   ├── install-mcp-entry.ts        # 不再做"下载.mjs",改提示用户用 npm
│   │       │       │   ├── track-skill-status.ts
│   │       │       │   ├── install-track-skill.ts
│   │       │       │   └── lessons.ts
│   │       │       └── _matcher.ts            # /:jiraKey 等参数路由
│   │       ├── watcher.ts                     # transcript-watcher 生命周期
│   │       └── skill-sync.ts                  # 1:1 迁自 apps/local-agent-service/src/services/skill-sync.ts
│   │
│   ├── mcp/                                   # @ai-productivity-tracker/mcp (private)
│   │   ├── package.json
│   │   └── src/                               # 1:1 迁自 packages/ai-productivity-mcp
│   │       ├── index.ts                       # startStdioMcp({baseUrl, token})
│   │       ├── agent-client.ts
│   │       └── tools.ts
│   │
│   └── ui/                                    # @ai-productivity-tracker/ui (private,Vite SPA)
│       ├── package.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/                               # 1:1 迁自 apps/web/src/modules/ai-productivity-tracker
│           ├── main.ts                        # createApp + Element Plus + Router
│           ├── App.vue                        # 顶级壳 (顶部 Tab Bar + <router-view/>)
│           ├── api.ts                         # AGENT_BASE → '' 同源 / 或读 <meta>
│           ├── definition.ts
│           ├── components/
│           │   └── AipAgentStatusCard.vue
│           ├── tabs/
│           │   ├── AiProductivityTrackerWorkspaceTab.vue
│           │   ├── AiProductivityTrackerLessonsTab.vue
│           │   ├── AiProductivityTrackerSettingsTab.vue
│           │   ├── AiProductivityTrackerMcpConfigTab.vue
│           │   ├── AiProductivityTrackerAboutTab.vue
│           │   └── AiProductivityTrackerGuideTab.vue
│           ├── styles/
│           │   └── aip-shared.css
│           └── router.ts
│
├── skills/                                    # 模板源文件(随 cli 包发布)
│   ├── ai-productivity-init/
│   │   └── SKILL.md
│   ├── ai-productivity-track/
│   │   ├── SKILL.md
│   │   └── CURSOR_RULE.md
│   ├── lessons-extract/
│   │   ├── SKILL.md
│   │   └── CURSOR_RULE.md
│   └── clarify-requirement/                   # 顺带迁过来(被 init skill 引用)
│       ├── skill.md
│       ├── references/
│       └── templates/
│
└── scripts/
    ├── pack.mjs                               # 打包 npm tarball 验证
    ├── release.mjs                            # 自动 bump + tag + publish
    └── sync-skills-to-templates.mjs           # 把 skills/ 同步到 packages/core/src/track-skill-templates.ts
```

### 4.1 包内依赖关系

```
@ai-productivity-tracker/cli  ──depends─►  server, mcp, hook-core, core
                                        ▲
                                        │ bundle 时 esbuild --bundle 全部内联到 dist/cli.mjs
                                        │ ui 通过 Vite 单独 build,产物 cp 到 cli/dist/web/

@ai-productivity-tracker/server   ──►   core
@ai-productivity-tracker/mcp      ──►   core, hook-core
@ai-productivity-tracker/hook-core──►   core
@ai-productivity-tracker/ui       (无后端依赖,只读 OpenAPI 风格的 daemon 端点)
```

只有 `cli` 一个包发到 npm；其它包都是 `"private": true`，被 cli 在构建时 bundle 进去。

---

## 5. 关键设计决策（含权衡）

### 5.1 为什么 daemon + mcp 拆两个进程？

**选项 A（拒绝）**：每个 MCP 子进程独立读写文件。

- ✗ 多 IDE 并行时 transcript-watcher 跑多份，重复 flush iteration，bindings.json 竞写。
- ✗ 看板浏览器无法连接到"某个 IDE 的 MCP 子进程"——IDE 退出即没。

**选项 B（拒绝）**：第一个 MCP 子进程升级成 daemon，其他 mcp 通过 IPC 转发。

- ✗ "升级"边界复杂，需要 leader election。
- ✗ 首个 MCP 退出（关 IDE）后 daemon 一起死，看板掉线。

**选项 C（采纳）**：daemon 独立 detached 进程 + mcp 极薄桥。

- ✓ daemon 单实例，文件并发安全。
- ✓ mcp 无状态，启停自由，多 IDE 共享 daemon。
- ✓ 看板 / hook / mcp 全走同一个 HTTP 接口，逻辑统一。
- ⚠️ 多了一次 spawn-detached，需要妥善处理"daemon 启动失败"反馈给 IDE（首次 mcp.run 时阻塞最多 5s 等 daemon ready，超时即把错误通过 MCP 协议告诉 LLM）。

### 5.2 为什么端口默认 17350 而非沿用 17280？

- 老 `truesight-agent` 还在用户机器上跑（macOS launchd 守护），端口 17280 占用。
- 用户**可能同时安装新老两个**进行对比验证（迁移期），所以默认错开。
- 完成迁移后用户可手动卸载老 agent（`launchctl unload …`）。
- 17350 在 IANA 未注册区间，无常见冲突。

### 5.3 为什么 Hook 不用 `npx`？

- `npx @x/cli hook` 每次启动有 500ms-2s 冷启动开销（macOS 首跑可能更慢）。
- Cursor `afterAgentResponse` 每轮触发一次，慢 hook 影响输入体验。
- **方案**：`install` 子命令把 hook 命令写成绝对路径 `node <abs cli.mjs> hook`，路径通过 `require.resolve('@ai-productivity-tracker/cli/dist/cli.mjs')` 拿到。
  - 全局安装：路径形如 `/usr/local/lib/node_modules/@ai-productivity-tracker/cli/dist/cli.mjs`。
  - 项目安装：用户当前 cwd 的 `node_modules/.bin/`，但项目可能换，不推荐。
  - **首选全局安装**：`npm i -g @ai-productivity-tracker/cli` 后 hook 路径稳定。
- `install` 子命令支持 `--hook-entry <abs>` 让用户显式指定（兼容下载式安装）。

### 5.4 为什么不用 fastify / express？

- 端点 ≤ 35 个，逻辑简单。
- Node 原生 `http.createServer` + 手写 router 在当前 agent 已稳定跑了一年，全部复用。
- 减小 bundle 体积（fastify bundle 进去 +400KB）。
- 减少依赖维护成本。

### 5.5 为什么看板 SPA 内嵌进 cli 包而不是单独发？

- 用户安装 1 个 npm 包就完事；分两个包用户要装两次。
- 看板 SPA 体积 ≈ 1MB（gzip 300KB），可接受。
- 版本永远对齐（daemon API 与 UI 强绑定）。
- 替代方案：cli 包仅含 daemon，daemon 在线时通过 CDN 拉看板——拒绝（违反"零外网依赖"原则）。

### 5.6 transcript-watcher 多 IDE 协调

当前 watcher 跑在 daemon 内，扫 `~/.claude/projects/*.jsonl`。迁移后保持不变：

- 一个 daemon = 一个 watcher。
- 所有 IDE 共享，无并发冲突。
- watcher state 存 `~/.ai-productivity-tracker/data/transcript-state.json`（沿用现行 schema）。

### 5.7 Cursor 多工作区 / WORKSPACE_FOLDER_PATHS

继承当前 v2.7.4 修复：MCP 客户端 `resolveClientCwd` 按优先级读取

1. `CLAUDE_PROJECT_DIR` / `CURSOR_PROJECT_DIR`
2. `WORKSPACE_FOLDER_PATHS`（按 `:` 切分取首项）
3. `process.cwd()`

无变化。

### 5.8 跨平台兼容

| 平台    | 当前状态         | 迁移后                                                                                                                        |
| ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS   | ✅ 主用，launchd | ✅ npx + daemon detached（不依赖 launchd）                                                                                    |
| Linux   | ⚠️ 未验证        | ✅ 同 macOS 路径；用户可自行写 systemd unit 守护 daemon（可选）                                                               |
| Windows | ❌ 未支持        | ✅ 关键调整：①路径用 `path.join`/`homedir`，②detached spawn 用 `windowsHide: true`，③hook 命令用 `node.exe <abs>`，④CRLF 处理 |

> Windows 是 nice-to-have，首个里程碑可以只保 macOS / Linux，但代码层不写死 `/` 路径。

---

## 6. API 兼容性矩阵

### 6.1 MCP Tool（**完全冻结，0 变更**）

5 个 tool 名称、入参 zod schema、出参文本格式与当前 v2.18.0 一致。

### 6.2 HTTP 端点（**路径与请求/响应体冻结**）

| 当前端点                                                   | 迁移后                                                                                                                                                                                                                      | 差异                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /status`                                              | 同                                                                                                                                                                                                                          | data 字段增加 `dataRoot: string`，**老前端解构时为 undefined 不破坏** |
| `GET /ai-productivity/*` 全量                              | 同                                                                                                                                                                                                                          | 全部 1:1                                                              |
| `POST /ai-productivity/install-mcp-entry`（一键下载 .mjs） | **保留但语义改写**：daemon 检测 cli 是否通过 npm 全局安装：是 → 200 返回 `{ ok: true, hookEntryPath: <abs cli.mjs>, replaced: false, mode: 'npm-global' }`；否 → 400 + 文案"请先 `npm i -g @ai-productivity-tracker/cli`"。 | 老前端按 `ok` 字段判断成功即可                                        |
| `POST /ai-productivity/install-cursor-hook`                | 同                                                                                                                                                                                                                          | `hookEntryPath` 不再是 `~/Downloads/...mjs`，改为 npm 全局安装路径    |
| `GET /ai-productivity/cursor-hook-status`                  | 同                                                                                                                                                                                                                          | `hookEntryPath` / `hookEntryVersion` 字段语义不变                     |

### 6.3 文件 schema（**冻结**）

`requirement.json` / `iterations.jsonl` / `bindings.json` / `lessons/*.json` / `INDEX.json` / `formula.json` / `jira.json` 全部不动。

### 6.4 Skill / Rule 模板

- 文件名不变：`SKILL.md` / `CURSOR_RULE.md` / `ai-productivity-track.mdc` / `lessons-extract.mdc`。
- 写入路径不变：`~/.claude/skills/<name>/SKILL.md`、`~/.cursor/rules/<name>.mdc`。
- 内容**仅替换**：把"truesight-agent" / "web-tool-platform" 提示性文案改为"ai-productivity-tracker daemon"；故障排查引导改为新 doctor 命令。
- 版本号自增：`TRACK_SKILL_VERSION` 2.12.0 → 3.0.0；`LESSONS_EXTRACT_SKILL_VERSION` 1.2.0 → 2.0.0（迁移到独立产品 = major bump）。
- 用户首次启动 daemon 检测到老版本 marker → 看板提示"模板已升级"，用户点击"一键注入"覆盖。

### 6.5 IDE 配置变化（用户视角）

#### Cursor `~/.cursor/mcp.json`

```diff
  {
    "mcpServers": {
-     "ai-productivity": {
-       "command": "node",
-       "args": ["/Users/<name>/Downloads/ai-productivity-mcp.mjs"],
-       "env": {
-         "TRUESIGHT_AGENT_URL": "http://127.0.0.1:17280",
-         "TRUESIGHT_AGENT_TOKEN": "<from ~/.truesight-local-agent/config.json>"
-       }
-     }
+     "ai-productivity": {
+       "command": "npx",
+       "args": ["-y", "@ai-productivity-tracker/cli", "mcp"]
+     }
    }
  }
```

或全局安装后等价的快速形式：

```json
{
  "mcpServers": {
    "ai-productivity": { "command": "ai-productivity-tracker", "args": ["mcp"] }
  }
}
```

迁移后 **无需任何环境变量**——daemon 自动 spawn，token / 端口走 `runtime.json`。

#### Cursor `~/.cursor/hooks.json`

```diff
  {
    "version": 1,
    "hooks": {
      "afterAgentResponse": [
-       { "command": "node /Users/<name>/Downloads/ai-productivity-mcp.mjs hook # ai-productivity-hook" }
+       { "command": "node /usr/local/lib/node_modules/@ai-productivity-tracker/cli/dist/cli.mjs hook # ai-productivity-hook" }
      ]
    }
  }
```

#### Claude Code `~/.claude/settings.json`

`Stop` / `UserPromptSubmit` hook 同上，绝对路径换成 npm 全局安装位置；marker (`# ai-productivity-stop-check` / `# ai-productivity-track-reminder`) 不变，install 时按 marker 覆盖。

---

## 7. 实施计划（Phase 拆分）

### Phase 0：仓库初始化（0.5 天）

- 在本目录 `my/ai-productivity-tracker` 初始化 pnpm workspace，添加 `package.json` / `pnpm-workspace.yaml` / `tsconfig.base.json` / `.gitignore` / `.editorconfig`。
- 添加 lint / format / vitest 顶层配置。
- 提交 `chore: init monorepo skeleton`。

### Phase 1：核心包 1:1 迁移（2-3 天）

> 这一步只搬代码、不改语义，保证所有 spec.ts 在新仓库下能跑通。

1. **`packages/core/`**：把 `apps/local-agent-service/src/services/ai-productivity/*`（不含 routes/）整体 cp 过来。
   - 修改 `store/paths.ts`：`AIP_ROOT_ENV = 'AIPT_DATA_ROOT'`，默认 `~/.ai-productivity-tracker/data`。
   - 保留 `TRUESIGHT_AIP_ROOT` 作为 fallback（向后兼容），但优先级低于新 env。
   - 其余文件保持原样。
2. **`packages/hook-core/`**：把 `packages/ai-productivity-hook-core/*` cp 过来。
   - `lib/agent-client.ts`：默认 `AGENT_CONFIG_PATH = ~/.ai-productivity-tracker/runtime.json`，schema 仍读 `{ token, port }`。
   - `lib/paths.ts`：`AIP_DIR_NAME` 不变（`.ai-productivity` 仓库内本地标记）。
   - 保留对 `~/.truesight-local-agent/config.json` 的 fallback 读取（迁移期兼容）。
3. **`packages/mcp/`**：把 `packages/ai-productivity-mcp/src/*` cp 过来。
   - 环境变量：`AIPT_DAEMON_URL` / `AIPT_DAEMON_TOKEN` 优先；fallback 到老 `TRUESIGHT_AGENT_URL` / `TRUESIGHT_AGENT_TOKEN`（迁移期兼容）。
4. **`packages/server/`**：把 `apps/local-agent-service/src/server.ts` + `src/routes/ai-productivity.ts` + `src/services/skill-sync.ts` cp 过来。
   - 删除：`routes/execute.ts` / `routes/nas.ts` / `routes/page-link-check.ts` / `routes/protocol-admin.ts` / `routes/repos.ts` / `routes/skills.ts` 这些**不属于 AI 提效追踪域**的路由。
   - 删除 WebSocket / TaskManager / 终端能力。
   - 删除 launchd installer (`service/installer.ts`)。
   - 删除 i18n-merge / s3-dingtalk / protocol-admin 服务。
   - `setCors()` 的 `allowedOrigins` 默认列表清空，只保留 `127.0.0.1:*` / `localhost:*`。
   - 沿用 `isAiProductivityPanelPath` 分流逻辑（同源/localhost 免 token）。
5. **`packages/ui/`**：把 `apps/web/src/modules/ai-productivity-tracker/*` cp 过来。
   - 新建 Vite SPA 壳（`index.html` / `main.ts` / `App.vue` / `router.ts`）。
   - `api.ts` 改：`AGENT_BASE = ''`（同源）；保留显式 base 支持以方便开发模式。
   - 抽离 `<ToolWorkbenchShell>` 等平台外壳，自己手写一个 60 行的极简 shell。
   - 删除模块注册到 `registry.ts` 的引用。
6. **`skills/`**：从源仓库 cp 过来（除 ai-productivity-init / track / lessons-extract / clarify-requirement 之外不带其他 skill）。
7. **测试**：所有 .spec.ts 路径修正后跑 `pnpm -r test`，要求 0 失败。

> 评估：core 1100 行 lessons-store + 各 store + watcher + metrics + hook-core + mcp 的代码合计 ~10k 行，没有重写工作量，只是搬路径 + 调 import；所有单测可以跑通。

### Phase 2：cli 包搭建（1-2 天）

- `packages/cli/src/index.ts` argv-router：实现 §3.3 全部子命令。
- `packages/cli/src/lib/runtime-lock.ts`：lockfile 读写 + 探活；并发安全（atomic open + lock）。
- `packages/cli/src/lib/ensure-daemon.ts`：spawn-detached 起 daemon、5s 内 ping ready。
- `packages/cli/src/commands/mcp.ts`：`ensureDaemon()` → `import('@ai-productivity-tracker/mcp').startStdioMcp(opts)`。
- `packages/cli/src/commands/daemon.ts`：`import('@ai-productivity-tracker/server').startDaemon({ port, token, dataRoot })`；处理 SIGTERM/SIGINT graceful shutdown。
- `packages/cli/src/commands/hook.ts`：`import('@ai-productivity-tracker/hook-core').runHook()`；不需要拉起 daemon（hook 失败 fail-open）。
- `packages/cli/src/commands/install.ts`：实现一键安装 hook（cursor hooks.json + claude settings.json）+ skill。
- `packages/cli/src/commands/install-mcp.ts`：写入 `~/.cursor/mcp.json`（merge 策略：已存在 ai-productivity 条目则覆盖 command/args）。
- `packages/cli/src/commands/migrate.ts`：检测 `~/.truesight-local-agent/ai-productivity/` 存在且新根空 → `cp -r` 全部内容。
- `packages/cli/src/commands/doctor.ts`：分组打印：runtime / hook / skill / mcp.json / old-data。
- `packages/cli/build.mjs`：esbuild bundle 成 `dist/cli.mjs`，外部依赖全部 inline；banner 注入版本 marker（同源 `__AI_PRODUCTIVITY_MCP_VERSION__` 模式）。

### Phase 3：UI 构建集成（1 天）

- `packages/ui/vite.config.ts`：base `'./'`；产物输出 `dist/`。
- `packages/ui/package.json`：`build` 脚本输出到 `../cli/dist/web/`（构建 cli 时先跑 ui）。
- 修改 cli daemon 的 static 路由：默认 serve `path.join(import.meta.dirname, 'web')`；fallback 一切非 API 路径到 `index.html`（SPA history mode）。
- UI 内置 dev mode：`VITE_AIPT_BASE=http://127.0.0.1:17350` env 注入 api 模块；prod 模式同源。

### Phase 4：跨进程协调健壮性 + 测试（1 天）

- 端口冲突 / 端口被占用 e2e 测试。
- daemon crash 重启 case。
- 多 IDE 并发跑 mcp 案例（用 child_process 模拟 2 个 IDE 同时连同一个 daemon）。
- migrate 命令 idempotent 测试。

### Phase 5：文档 + Release（0.5 天）

- `README.md`：用户视角 quickstart。
- `docs/MIGRATION.md`：老用户从 `truesight-agent` 切到 npm 版的 4 步流程。
- `docs/CHANGELOG.md`：v1.0.0 first release notes。
- `scripts/release.mjs`：bump version、build cli + ui、`npm publish --access public`。
- 发 `@ai-productivity-tracker/cli@1.0.0-rc.1` 到 npm registry，回归测试 5 个核心场景（见 §8）。

### 总时长

- 单人专注 ≈ 6-7.5 工作日 落地 v1.0.0-rc.1（含测试 + 文档）。
- 与源仓库并行运行 1 周（双跑期），灰度老用户。
- 双跑期没问题 → 1.0.0 GA + 源仓库 ai-productivity 模块下线（保留只读模式或删除，看仓库策略）。

---

## 8. 验收用例（必须全部通过才算迁移完成）

| #   | 用例                     | 验证项                                                                                                                                               |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **冷安装**               | 新机器：`npm i -g @ai-productivity-tracker/cli` → `ai-productivity-tracker install --ide=cursor` → 打开 Cursor，自动建立 MCP 连接，daemon 自动 spawn |
| V2  | **看板自启**             | `ai-productivity-tracker ui open` → 浏览器自动打开 `http://127.0.0.1:17350` → 看到 6 个 Tab                                                          |
| V3  | **init 流程**            | Cursor 内对 LLM 说"开始跟踪 INSTANT-1234" → init skill 触发 → ai_productivity_init → 看板出现需求行                                                  |
| V4  | **attach_summary**       | 同轮答复结束后看板 iteration 出现 conversationSummary，与改前完全一致                                                                                |
| V5  | **transcript-watcher**   | 在 Claude Code 跑一轮对话 → watcher 自动 flush iteration → 看板出现新行                                                                              |
| V6  | **lessons**              | 触发"经验提取" → extract_bundle → LLM 推理 → save_lessons → 看板"复盘经验"Tab 出现新条目                                                             |
| V7  | **Jira 凭证 + 刷新 bug** | Settings Tab 配 Jira baseUrl/Email/Token → 详情抽屉刷新 bug 数 → 200 正确返回                                                                        |
| V8  | **多 IDE 并发**          | 同时打开 Cursor + Claude Code，跑两轮对话 → daemon 单实例，两轮 iteration 都正确落盘                                                                 |
| V9  | **daemon kill 自恢复**   | `kill -9 $(daemon pid)` → 下一次 mcp 启动自动检测并重新 spawn → MCP 连接恢复                                                                         |
| V10 | **migrate 老数据**       | 拷贝 `~/.truesight-local-agent/ai-productivity` 到测试机 → `migrate` → 看板出现原所有需求                                                            |
| V11 | **hook 兼容**            | 老 hooks.json 残留 `~/Downloads/...mjs` 路径 → `install` 命令覆盖为 npm 路径，marker 不变                                                            |
| V12 | **CORS 切换**            | 浏览器从 `http://localhost:17350` 访问全功能 OK；从外部域访问 → 403（不在白名单）                                                                    |
| V13 | **doctor**               | `ai-productivity-tracker doctor` 输出 9 项 ✓/✗ 自检结果，包含 daemon / hook / skill / migrate 提示                                                   |
| V14 | **npm 包体积**           | `npm pack` 产物 ≤ 3MB（tarball）；解压后 `dist/` 总大小 ≤ 5MB                                                                                        |

---

## 9. 风险与缓解

| #   | 风险                                                            | 影响                                      | 缓解                                                                                                                                            |
| --- | --------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | daemon spawn-detached 在 Windows 下 stdio 行为差异              | Windows 用户首次 MCP 启动失败             | 首期可只支持 macOS/Linux，Windows 单独里程碑；spawn 时显式 `windowsHide`、`detached: true`、`stdio: ['ignore','ignore','ignore']`               |
| R2  | npx 冷启动慢导致 IDE MCP 启动超时                               | 用户启动 IDE 后第一次 LLM 调用 5-10s 卡顿 | 文档强烈推荐 `npm i -g`；`npx` 缺省加 `-y` 避免交互卡死；`ensureDaemon` 5s 超时给出明确错误                                                     |
| R3  | 17350 端口与用户其他工具冲突                                    | daemon 起不来                             | 端口扫描 fallback；用户可显式 `config.json.port` 锁端口；doctor 检测后给出建议                                                                  |
| R4  | runtime.json token 写权限问题                                   | 多用户 Mac 下权限混乱                     | `chmod 0600`；用户 home 目录归属正确即 OK                                                                                                       |
| R5  | esbuild bundle 单文件 size 增长失控                             | npm 包变大                                | 持续监控；如 > 2MB 单独把 chokidar / mcp-sdk 抽成可选 dependency                                                                                |
| R6  | 老 truesight-agent 与新 daemon 端口冲突（用户不卸载）           | 双 daemon 跑导致 hook/MCP 上报错乱        | 默认端口 17350 错开；`install` 命令检测 17280 端口在跑时打印迁移建议                                                                            |
| R7  | transcript-watcher 在 Linux 下 inotify 限制                     | 大量 jsonl 文件触发 ENOSPC                | 沿用现行 chokidar 实现；文档给出 `fs.inotify.max_user_watches` 调高建议                                                                         |
| R8  | 老 sentinel/stop-check 路径变化导致 IDE hook 断链               | 防伪造校验失效，看板出现双 iteration      | sentinel 文件路径迁到 `~/.ai-productivity-tracker/data/recent-attach-sentinel/`，但 hook-core/sentinel.ts 仅修改 `sentinelDir()` 一处，逻辑不变 |
| R9  | skill 文案版本号大跳（2.12 → 3.0），用户已装 skill 不会自动覆盖 | LLM 行为可能漂移                          | install 子命令检测版本不一致 → 主动覆盖；看板 MCP 配置 Tab 显著标红"模板已升级"                                                                 |
| R10 | npm 包名 `@ai-productivity-tracker/cli` 已被占用                | 无法发布                                  | 提前在 npm 搜索；备用名 `aipt-cli` / `ai-prod-tracker` / `@aipt/cli`                                                                            |

---

## 10. 配置项总览（最终用户视角）

### 10.1 主配置 `~/.ai-productivity-tracker/config.json`

```jsonc
{
  "$schema": "https://github.com/zhongleijian/ai-productivity-tracker/schema/config.v1.json",

  // daemon
  "port": 17350, // 显式锁定;不写则自动选
  "host": "127.0.0.1", // 仅允许 loopback
  "allowedOrigins": [], // 额外放行的 Origin(默认空,只放 loopback)

  // 数据
  "dataRoot": "~/.ai-productivity-tracker/data", // 可改;支持 ~

  // 业务参数(同源 jira-config / formula 兜底)
  "logLevel": "info", // debug | info | warn | error
  "logRotateDays": 7,

  // 行为开关
  "watcher": {
    "enabled": true,
    "claudeProjectsDir": "~/.claude/projects",
    "staleTurnFlushMs": 60000
  }
}
```

### 10.2 运行态 lockfile `~/.ai-productivity-tracker/runtime.json`

```jsonc
{
  "pid": 12345,
  "port": 17350,
  "host": "127.0.0.1",
  "token": "<64 hex>",
  "startedAt": "2026-05-22T07:35:00.000Z",
  "version": "1.0.0",
  "dataRoot": "/Users/foo/.ai-productivity-tracker/data"
}
```

文件权限：`0600`。

### 10.3 环境变量

| 变量                                                                   | 作用                                                 | 默认                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `AIPT_PORT`                                                            | 覆盖 daemon 端口                                     | `config.json.port` 或 17350       |
| `AIPT_HOST`                                                            | 仅允许 loopback                                      | 127.0.0.1                         |
| `AIPT_DATA_ROOT`                                                       | 覆盖数据根                                           | `~/.ai-productivity-tracker/data` |
| `AIPT_TOKEN`                                                           | 覆盖 token（CI 注入）                                | 自动生成                          |
| `AIPT_DAEMON_URL`                                                      | mcp / hook 显式指定 daemon 地址（测试 / 自定义部署） | 读 runtime.json                   |
| `AIPT_DAEMON_TOKEN`                                                    | 同上                                                 | 读 runtime.json                   |
| `TRUESIGHT_AIP_ROOT`                                                   | **向后兼容**老 env                                   | 优先级最低                        |
| `TRUESIGHT_AGENT_URL` / `TRUESIGHT_AGENT_TOKEN`                        | **向后兼容**老 mcp 启动方式                          | 优先级最低                        |
| `CLAUDE_PROJECT_DIR` / `CURSOR_PROJECT_DIR` / `WORKSPACE_FOLDER_PATHS` | MCP 客户端 cwd 解析（不变）                          | —                                 |

---

## 11. CLI 使用速查（终态文档草案）

```text
ai-productivity-tracker <command> [options]

Commands:
  mcp                启动 stdio MCP server(IDE 内部调用,自动 spawn daemon)
  daemon             前台启动 HTTP daemon(包含面板与 API)
  hook               处理 IDE afterAgentResponse hook(短 CLI)
  stop-check         处理 IDE stop hook 防伪造校验
  install            一键注入 hook + skill 到 IDE 配置
    --ide=cursor|claude|all   (默认 all)
    --hook-entry <path>       自定义 hook 绝对路径
    --debug                   注入 debug 前缀
  install-mcp        将本 cli 写到 ~/.cursor/mcp.json
  ui open            在浏览器打开看板
  migrate            把 ~/.truesight-local-agent 老数据搬到新根
  doctor             体检:daemon / hook / skill / 数据迁移 / 端口冲突
  version            打印版本
  --help

Examples:
  npm i -g @ai-productivity-tracker/cli
  ai-productivity-tracker install --ide=cursor
  ai-productivity-tracker daemon                     # 前台跑(可被 systemd 拉起)
  ai-productivity-tracker ui open                     # 打开浏览器
  ai-productivity-tracker doctor
  ai-productivity-tracker migrate                     # 从 truesight-agent 平迁
```

---

## 12. 后续演进（v1.x 路线图占位）

> 仅占位，本期不实施。

- **P1**: Windows 完整支持（systemd-equivalent 守护脚本生成器）。
- **P1**: 看板「全局复盘报告」一键导出 Markdown / HTML（roadmap.md §P1-3）。
- **P2**: skill / rule 版本管理面板（diff、回滚、自定义 fork）。
- **P2**: 多 dataRoot 切换（按"工作"/"个人"切档）。
- **P3**: 团队同步：daemon 加可选 push 到 git 仓库的"经验云"。
- **P3**: VS Code Extension 替代手动注入 mcp.json。

---

## 13. 验收 Definition of Done

迁移完成认定标准（全部 ✓ 方可 GA）：

- [ ] §8 的 V1-V14 全部通过
- [ ] `pnpm -r test` 全绿（≥ 当前 agent 364 + mcp 42 = 406 用例）
- [ ] `npm pack` 产物 < 3MB
- [ ] README + MIGRATION + CHANGELOG 完整
- [ ] 在 macOS / Linux 各一台机器灰度运行 7 天无 P0 故障
- [ ] 源仓库 `instant-web-tools` 同期标注「ai-productivity-tracker 已迁移至独立项目」，看板 Guide Tab 加跳转链接
- [ ] 源仓库保留只读 1 个版本（不再接受新需求），3 个月后退役

---

## 附录 A：数据/能力清单（迁移核对表）

| 类目          | 项                                                                                                                                                                                                                                                 | 迁移状态     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 数据 store    | `requirement-store / iteration-store / index-store / formula-store / jira-config-store / lessons-store / pending-summary / recent-attach-sentinel / subtask-event-store / numstat-snapshot / bindings`                                             | 全部 ☑       |
| 业务逻辑      | `metrics(boost 计算) / jira-bug-client(ensureBoundedJql, fetchJiraIssueSummary 10 种 reason 映射) / git-diff(numstat) / iteration-extras(thinkSeconds) / project-meta(package.json name) / hook-dedupe / claude-message(解析) / jsonl-incremental` | 全部 ☑       |
| Watcher       | `transcript-watcher(stop_hook_summary + stale_timeout flush) / watcher-state`                                                                                                                                                                      | ☑            |
| Hook 链路     | `runHook / runStopCheckCli / installCursorHookFile / inspectCursorHook / sentinel(90s window) / tracking-context`                                                                                                                                  | ☑            |
| Skill 安装    | `skill-sync(installAiTrackSkillBundle / inspectAiTrackSkillBundle, lessons-extract 同步, legacy cleanup)`                                                                                                                                          | ☑            |
| 模板          | `track-skill-templates(CLAUDE_TRACK / CURSOR_RULE / LESSONS_EXTRACT_* 字符串)`                                                                                                                                                                     | ☑ 同步升版本 |
| MCP Tool      | `ai_productivity_init / status / attach_summary / extract_bundle / save_lessons`                                                                                                                                                                   | ☑            |
| HTTP 端点     | §1.3 全表                                                                                                                                                                                                                                          | ☑            |
| 看板 Tab      | Workspace / Lessons / Settings(业务) / McpConfig / About / Guide                                                                                                                                                                                   | ☑            |
| Skill 文件    | `ai-productivity-init/SKILL.md` / `ai-productivity-track/{SKILL.md,CURSOR_RULE.md}` / `lessons-extract/{SKILL.md,CURSOR_RULE.md}` / `clarify-requirement/*`                                                                                        | ☑            |
| 公开产物      | `apps/web/public/downloads/*` → 不再需要(npm 替代)                                                                                                                                                                                                 | ☒ 下线       |
| launchd plist | `~/Library/LaunchAgents/com.truesight.local-agent.plist`                                                                                                                                                                                           | ☒ 下线       |
| 平台域名 CORS | `web-tool-platform.*` 等                                                                                                                                                                                                                           | ☒ 下线       |
| 模块注册      | `apps/web/src/modules/registry.ts`                                                                                                                                                                                                                 | ☒ 下线       |

---

## 附录 B：源仓库变更联动

迁移落地后，源仓库 `instant-web-tools` 需要：

1. `apps/local-agent-service/`：删除 `src/services/ai-productivity/` 与 `src/routes/ai-productivity.ts`、`src/services/skill-sync.ts`、相关 spec.ts。
2. `apps/web/src/modules/ai-productivity-tracker/`：整模块删除；从 `registry.ts` 移除注册项；`packages/db/src/default-platform-modules.ts` 移除条目。
3. `packages/ai-productivity-mcp/` / `packages/ai-productivity-hook-core/`：整包删除。
4. `apps/web/public/downloads/ai-productivity-mcp/` / `apps/web/public/downloads/skills/{ai-productivity-init,ai-productivity-track,lessons-extract}/`：删除。
5. `skills/{ai-productivity-init,ai-productivity-track,lessons-extract,clarify-requirement}/`：删除（迁到新仓库）。
6. `specs/modules/ai-productivity-tracker/`：归档（move 到 `specs/archived/` 并在 INDEX.yaml 标 status=archived，附跳转链接）。
7. `.cursor/rules/ai-productivity-track.mdc` 文案保留为引导：转告读者新工具地址。
8. 平台首页 / 工具卡片矩阵：移除"AI 提效面板"卡片。

> 这一步**单独立项**（"ai-productivity 旧体系下线"），与本 PRD 解耦实施。

---

**END OF PRD v1.0.0**
