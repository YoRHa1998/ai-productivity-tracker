# ai-productivity-tracker

> 独立、自包含、可通过 npm 分发的 AI 编码会话提效追踪工具。
> 一个 npm 包同时承载:stdio MCP server + HTTP daemon + 浏览器看板 + Cursor/Claude IDE Hook,无需任何外部平台或后端服务。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 它能做什么

- 在任意业务仓库(Jira 工作流)内,把 IDE(Cursor / Claude Code 等任意 MCP 客户端)与 AI 模型的对话过程,按 Jira 需求维度收集成结构化指标:
  - **提效倍数(boost)** / 关联 Bug 数 / token 成本 / 真实思考时长 / numstat diff
  - **每轮对话**的一句话总结 / 改动范围 / 讨论摘要
  - **跨需求复用**的复盘经验(lessons-learned)
- 全部数据落用户本机 `~/.ai-productivity-tracker/data/`,不上云,不联网。
- 浏览器看板默认 `http://127.0.0.1:17350` 实时展示,支持 6 个 Tab(需求看板 / 复盘经验 / 业务配置 / MCP 配置 / 工具说明 / 使用说明)。
- 兼容 Cursor `afterAgentResponse` + `stop` hook、Claude Code `Stop` + `UserPromptSubmit` hook。

---

## 30 秒上手

```bash
# 1. 全局安装
npm install -g @ai-productivity-tracker/cli

# 2. 一键安装 IDE 配置(MCP + hooks.json + skill)
aipt install

# 3. 打开看板
aipt ui open
# → 浏览器自动打开 http://127.0.0.1:17350
```

完成。在 IDE 内开始正常工作,提效数据会自动落到看板。

### IDE 内 MCP 配置示例

`aipt install` 会自动写入 `~/.cursor/mcp.json`(Cursor)与 `~/.claude.json`(Claude Code),
效果分别等价于:

```json
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "ai-productivity-tracker": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/cli.mjs", "mcp"]
    }
  }
}
```

```json
// ~/.claude.json (顶层会保留 Claude Code 自身的 numStartups / theme / projects 等字段)
{
  "mcpServers": {
    "ai-productivity-tracker": {
      "type": "stdio",
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/cli.mjs", "mcp"]
    }
  }
}
```

无需配置任何环境变量或 token —— daemon 启动时自动生成,MCP 子进程通过 lockfile 拿。

> `aipt install --ide=cursor` / `aipt install --ide=claude` 可单独只装某一侧。

---

## 常用命令

| 命令                        | 作用                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `aipt install`              | 一键完整安装(写 cursor + claude mcp 配置 + 注入 hook + 装 skill)      |
| `aipt install --ide=cursor` | 仅装 Cursor(~/.cursor/mcp.json + hooks.json + rule)                   |
| `aipt install --ide=claude` | 仅装 Claude Code(~/.claude.json + skill)                              |
| `aipt daemon`               | 前台启动 HTTP daemon(看 daemon 日志时用)                              |
| `aipt ui open`              | 浏览器打开看板                                                        |
| `aipt doctor`               | 体检:Node 版本 / runtime / hook / skill / mcp.json / 老数据迁移 10 项 |
| `aipt migrate`              | 从 `truesight-agent` 平迁老数据                                       |
| `aipt version`              | 打印版本                                                              |
| `aipt --help`               | 完整帮助                                                              |

> 短别名 `aipt` 与全名 `ai-productivity-tracker` 等价。

---

## 工作原理(一张图)

```
┌──────────────────────────────────────────────────────────────────────┐
│  用户机器                                                              │
│                                                                        │
│  IDE(Cursor/Claude Code) ──stdio──▶ npx aipt mcp                     │
│                                            │                           │
│                                            ▼                           │
│                                  ensureDaemon() ◄──singleton lock──┐   │
│                                            │                       │   │
│                                            ▼                       │   │
│                                  HTTP+Bearer  ─────────────────────┘   │
│                                            │                           │
│                                            ▼                           │
│  Cursor hooks.json ──HTTP──▶ aipt daemon (127.0.0.1:17350)            │
│  Claude settings.json hook ─────────────────────────│                  │
│                                                     ▼                  │
│  浏览器  ──fetch http://127.0.0.1:17350──▶ daemon API + 看板 SPA      │
│                                                     │                  │
│                                                     ▼                  │
│                                       ~/.ai-productivity-tracker/      │
│                                       ├── runtime.json (pid/port/token)│
│                                       ├── config.json (用户偏好)        │
│                                       └── data/                        │
│                                           ├── <JIRA-KEY>/              │
│                                           │   ├── requirement.json     │
│                                           │   └── iterations.jsonl     │
│                                           ├── lessons/                 │
│                                           ├── bindings.json            │
│                                           └── ...                      │
└──────────────────────────────────────────────────────────────────────┘
```

详细架构见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

## 配置 / 环境变量

最简部署不需要任何配置。如需调优:

| 配置项                                          | 默认                              | 说明                             |
| ----------------------------------------------- | --------------------------------- | -------------------------------- |
| `~/.ai-productivity-tracker/config.json` `port` | `17350`                           | 显式锁定 daemon 端口             |
| `AIPT_PORT` env                                 | —                                 | 等价 config 中的 port,优先级最高 |
| `AIPT_DATA_ROOT` env                            | `~/.ai-productivity-tracker/data` | 数据根目录                       |
| `AIPT_DAEMON_URL` env                           | —                                 | (mcp/hook)显式指定 daemon 地址   |
| `AIPT_DAEMON_TOKEN` env                         | —                                 | (mcp/hook)显式指定 token         |

完整配置项见 [`docs/PRD.md` §10](./docs/PRD.md)。

---

## 从 `truesight-agent` 迁移

如果你之前在使用旧版 `instant-web-tools / truesight-agent + Web 平台 AI 提效面板`,
按 [`docs/MIGRATION.md`](./docs/MIGRATION.md) 完整指引迁移,几分钟即可切到独立版本。

简版:

```bash
npm i -g @ai-productivity-tracker/cli
aipt migrate                # 把 ~/.truesight-local-agent 老数据搬到新目录
aipt install                # 覆盖式更新 hooks.json / mcp.json / skill / rule
launchctl unload ~/Library/LaunchAgents/com.truesight.local-agent.plist
```

---

## 故障排查

- **`aipt doctor`**:9 项体检,逐项 ✓⚠✗ 输出。是排错第一步。
- **看板打不开 / Daemon 不可达**:`aipt daemon` 前台跑,查日志输出
- **MCP / Hook 报 401**:`~/.ai-productivity-tracker/runtime.json` token 已变,关掉 IDE 后重启即可
- **端口被占**:`AIPT_PORT=17888 aipt daemon` 用其它端口

更多见 [`docs/MIGRATION.md`](./docs/MIGRATION.md) 与 [`docs/PRD.md` §9](./docs/PRD.md)。

---

## 项目结构 / 开发

```
ai-productivity-tracker/
├── docs/                        # 设计文档(PRD/ARCHITECTURE/MIGRATION/...)
├── packages/
│   ├── core/                    # 数据模型 / store / watcher / metrics
│   ├── hook-core/               # Cursor/Claude hook 入口逻辑
│   ├── mcp/                     # stdio MCP bridge(5 个 tool)
│   ├── server/                  # HTTP daemon(30+ endpoint)+ skill-sync
│   ├── ui/                      # Vue 3 看板 SPA
│   └── cli/                     # 单 npm 包发布主体,argv-router + 11 子命令
└── skills/                      # Skill / Cursor Rule 模板(随 cli 包发布)
```

开发命令:

```bash
pnpm install                                       # 安装全部 workspace 依赖
pnpm typecheck                                     # 全包 tsc 检查
pnpm test                                          # 全包 vitest(当前 590 例)
pnpm lint                                          # ESLint 9 flat config
pnpm format                                        # Prettier 3
pnpm --filter @ai-productivity-tracker/cli build   # 链式 ui build + esbuild bundle
pnpm --filter @ai-productivity-tracker/ui dev      # 开发态 SPA(自动 proxy /ai-productivity 到 daemon)
```

### 发布到 npm(维护者)

```bash
# 首次设置专用发布账号(token 落在项目级 .npmrc.publish,不污染 ~/.npmrc)
npm login --userconfig=./.npmrc.publish --auth-type=web --scope=@ai-productivity-tracker

# 干跑(不真发,验证产物 + 体积 + 登录态)
pnpm release prerelease

# 真发
pnpm release prerelease --publish     # → x.y.z-rc.N+1
pnpm release patch --publish           # → x.y.(z+1)
pnpm release 1.0.0 --publish           # → 显式版本
```

`scripts/release.mjs` 自动:typecheck → test → lint → bump → build →
体积校验(< 3MB tarball)→ npm whoami 验证 → publish → git commit + tag。

详见 [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) 内"发布工程经验"段。

---

## 许可证

[MIT](./LICENSE)

设计文档完整版:[`docs/PRD.md`](./docs/PRD.md)
