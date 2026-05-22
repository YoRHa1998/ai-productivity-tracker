# MIGRATION

> 从 `truesight-agent` + `web-tool-platform AI 提效面板` 平滑迁移到独立 npm 包。
> **待 Phase 5 GA 前补齐**。

## 迁移路径概览(草案)

1. `npm i -g @ai-productivity-tracker/cli`
2. `ai-productivity-tracker migrate` — 把 `~/.truesight-local-agent/ai-productivity/` 平迁到 `~/.ai-productivity-tracker/data/`
3. `ai-productivity-tracker install` — 覆盖式更新 hooks.json / settings.json / skill / rule
4. 在 IDE MCP 配置里把 `ai-productivity` 这一项替换为 `{ command: 'npx', args: ['-y', '@ai-productivity-tracker/cli', 'mcp'] }`
5. 重启 IDE,看板访问 `http://127.0.0.1:17350`
6. (可选)双跑期结束后 `launchctl unload ~/Library/LaunchAgents/com.truesight.local-agent.plist` 卸载老 agent

完整设计见 [`PRD.md`](./PRD.md) §3.8 与 §6.5。
