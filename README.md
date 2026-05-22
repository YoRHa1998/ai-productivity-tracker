# ai-productivity-tracker

> 一个独立、自包含、可通过 npm 分发的 AI 编码会话提效追踪工具。
> 单进程承载 MCP server / HTTP daemon / Web 看板 / Hook 入口,无需任何外部平台或后端服务。

---

## 状态

🚧 **早期开发中(Phase 0)**。完整迁移规划见 [`docs/PRD.md`](./docs/PRD.md)。

## 能做什么

- 在任意业务仓库内,把 IDE(Cursor / Claude Code 等 MCP 客户端)与 AI 模型的对话过程,按 Jira 需求维度收集成结构化指标:
  - 提效倍数(boost) / 关联 Bug 数 / token 成本 / 真实思考时长 / numstat diff
  - 每轮对话的一句话总结 / 改动范围 / 讨论摘要
  - 跨需求复用的"复盘经验"沉淀
- 全部数据落用户本机 `~/.ai-productivity-tracker/data/`,不上云,不联网。
- 浏览器看板 `http://127.0.0.1:17350` 实时展示。

## 安装与使用(目标态)

```bash
# 安装(推荐全局)
npm i -g @ai-productivity-tracker/cli

# 一键注入 IDE 配置(Cursor / Claude Code)
ai-productivity-tracker install

# 打开看板
ai-productivity-tracker ui open
# → 浏览器自动打开 http://127.0.0.1:17350
```

IDE 内只需在 MCP 配置里加一条:

```json
{
  "mcpServers": {
    "ai-productivity": {
      "command": "npx",
      "args": ["-y", "@ai-productivity-tracker/cli", "mcp"]
    }
  }
}
```

完整接入指引见 `docs/PRD.md` §11 与 `docs/MIGRATION.md`。

## 开发

```bash
# 安装依赖
pnpm install

# 类型检查 / 测试 / 构建
pnpm typecheck
pnpm test
pnpm build

# 代码风格
pnpm lint
pnpm format
```

## 项目结构(Phase 0)

```
ai-productivity-tracker/
├── docs/                 # 设计文档
│   └── PRD.md
├── packages/             # 子包(Phase 1 起逐步落地)
├── package.json          # pnpm workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── …
```

完整目录设计见 [`docs/PRD.md` §4](./docs/PRD.md)。

## 许可证

[MIT](./LICENSE)
