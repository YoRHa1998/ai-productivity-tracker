# Changelog

本文件记录 `@ai-productivity-tracker/cli` 独立项目的所有版本变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/);格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 源项目 `instant-web-tools` 内 AI 提效面板模块的历史变更(v2.0 ~ v2.18.x)归档在
> `specs/modules/ai-productivity-tracker/change_log.md`,本仓库 v1.x 从那里继承全部行为契约。

---

## [Unreleased]

### Phase 4-5 收尾(2026-05-25)

#### Added(新增)

- **daemon crash 端到端测试**:SIGKILL daemon 进程后,孤儿 lockfile 被新 daemon 覆盖
- **README quickstart 章节**:30 秒上手 + 工作原理图 + 配置项与开发命令
- **MIGRATION 完整手册**:从 `truesight-agent` 平迁到独立 npm 包的 6 步流程
- **`.npmignore`**:发布过滤器,排除 source map / 中间产物

#### Changed(变更)

- **build 默认不产 source map**:cli esbuild bundle + ui vite build 都改为
  `AIPT_BUILD_SOURCEMAP=1` 才输出 .map,npm tarball 体积减半
- **e2e spawn 改 detached 模式**:测试用 `process.kill(-pid, SIG)` 杀整个进程组,
  解决 tsx 双进程导致 SIGKILL 只杀 wrapper 的问题

---

## [1.0.0-rc.1] - 2026-05-22(计划首版)

> 首个 RC 版本。从 `instant-web-tools / web-tool-platform AI 提效面板`(v2.18.0)
> 完整迁出成独立 npm 包,以 1:1 行为保留为约束。

### Added

- **`@ai-productivity-tracker/cli`** 单包发布:
  - bin: `ai-productivity-tracker` / `aipt`(别名)
  - argv-router 13 个子命令(`mcp` / `daemon` / `hook` / `stop-check` / `install` / `install-mcp` / `migrate` / `ui open` / `doctor` / `version` / `help` 等)
  - esbuild 单文件 bundle 内联 5 个内部子包,产物 ~1MB(gzip ~300KB)
- **内部 6 个子包**:
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
- **跨平台支持**:macOS / Linux 完整测试,Windows 路径处理已就绪(detached spawn / pid 探活 / 进程组信号待 Windows 测)
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

590 例自动化测试,33 个 spec 文件覆盖:

- core(22 spec, 442 例):全部 store / metrics / transcript-watcher / hook-dedupe / jira-bug-client
- hook-core(6 spec, 83 例):hook / stop-check / install-cursor-hook / sentinel / agent-client
- mcp(3 spec, ~30 例):agent-client / tools / argv-router
- server(2 spec, 83 例):routes/ai-productivity + skill-sync
- cli(7 spec, 64 例):paths / pick-port / runtime-lock / config / install-mcp / migrate + daemon e2e(spawn 真 daemon)

---

## 未来路线图(v1.x)

- **v1.1**:Windows 完整支持(systemd-equivalent 守护脚本生成器)
- **v1.1**:看板「全局复盘报告」一键导出 Markdown / HTML
- **v1.2**:skill / rule 版本管理面板(diff / 回滚 / 自定义 fork)
- **v1.2**:多 dataRoot 切换(按"工作"/"个人"切档)
- **v1.3**:团队同步 — daemon 可选 push 经验到 git 仓库
- **v1.3**:VS Code Extension 替代手动注入 mcp.json

详见 [`PRD.md` §12](./PRD.md)。
