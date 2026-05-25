# MIGRATION 从 `truesight-agent` 平迁到 `@ai-productivity-tracker/cli`

> 适用人群:之前在 `instant-web-tools` Web 平台 + 本机 `truesight-agent` 服务下使用 AI 提效面板的用户。
>
> 目标:5 ~ 10 分钟内完成切换,**老数据全部保留**,IDE / Hook / Skill 全部重新指向新的独立工具。

---

## TL;DR

```bash
npm install -g @ai-productivity-tracker/cli
aipt migrate          # 把 ~/.truesight-local-agent 老数据搬到新目录
aipt install          # 覆盖式更新 hooks.json / mcp.json / skill / rule
aipt doctor           # 9 项体检,确认无遗漏
launchctl unload ~/Library/LaunchAgents/com.truesight.local-agent.plist  # 可选:卸载老 agent
```

完成。重启 IDE 让新 MCP 配置生效,浏览器访问 `http://127.0.0.1:17350` 看新看板。

---

## 1. 背景:为什么要迁?

新独立项目对老 Web 平台版做了以下改进:

| 维度     | 老版本(`truesight-agent` + Web 平台)                       | 新版本(`@ai-productivity-tracker/cli`) |
| -------- | ---------------------------------------------------------- | -------------------------------------- |
| 依赖     | 必须装 Web 平台 + launchd 后台服务 + MCP .mjs 手动下载     | 一个 npm 包                            |
| 分发     | 手动 `curl` 下载 `~/Downloads/ai-productivity-mcp.mjs`     | `npm i -g`                             |
| 看板     | 必须从 web-tool-platform 域名访问(跨域 fetch)              | daemon 同源托管,浏览器直连本机         |
| 守护     | macOS launchd plist                                        | npm 包自带 detached daemon             |
| 端口     | 17280                                                      | 17350(主动错开方便共存)                |
| 数据     | `~/.truesight-local-agent/ai-productivity/`                | `~/.ai-productivity-tracker/data/`     |
| MCP 配置 | 需手填 `TRUESIGHT_AGENT_URL` / `TRUESIGHT_AGENT_TOKEN` env | 零 env,自动通过 lockfile 协调          |
| 跨平台   | 主要 macOS                                                 | macOS / Linux 均测,Windows 可用        |

老版本仍可正常工作,**迁移期可双跑**(两个端口错开,互不干扰)。

---

## 2. 完整迁移流程

### 2.1 安装新工具

```bash
npm install -g @ai-productivity-tracker/cli
aipt version
# → ai-productivity-tracker v1.0.0
```

也可以不全局装,直接用 `npx -y @ai-productivity-tracker/cli ...`,但 hook 性能敏感场景推荐全局装(避免每次 hook 触发 npx 冷启动开销)。

### 2.2 平迁老数据(可选但推荐)

```bash
aipt migrate
```

行为:

- 检测 `~/.truesight-local-agent/ai-productivity/` 是否存在
- 不存在 → 跳过(全新机器无需迁移)
- 存在 + 新目录空 → 全量 `cp -r` 到 `~/.ai-productivity-tracker/data/`
- 存在 + 新目录已有数据 → 默认拒绝,需要 `aipt migrate --force` 走"增量合并"模式(新文件追加,同名文件保留新版本)

**老数据保留不动**。确认新版本工作正常后再手动删除 `~/.truesight-local-agent/`。

### 2.3 一键安装 IDE 配置

```bash
aipt install                    # 默认 --ide=all
# 或
aipt install --ide=cursor       # 只装 Cursor
aipt install --ide=claude       # 只装 Claude Code
```

`aipt install` 做 3 件事:

1. **`~/.cursor/mcp.json`**:删除老 `ai-productivity` key,新增 `ai-productivity-tracker` key
2. **`~/.cursor/hooks.json`**:写入 `afterAgentResponse` hook 与 Cursor stop-check hook,marker 不变(`# ai-productivity-hook` / `# ai-productivity-stop-check`)。老的 `~/Downloads/ai-productivity-mcp.mjs` 路径会被自动替换为 npm 全局路径
3. **`~/.claude/skills/`** / **`~/.cursor/rules/`**:覆盖式注入 `ai-productivity-track.mdc` + `lessons-extract` 双 skill

注入完成后命令行会打印每一步状态。

### 2.4 启动 daemon + 看板

```bash
aipt ui open
# → 浏览器自动打开 http://127.0.0.1:17350
```

或前台跑(看日志):

```bash
aipt daemon
```

第一次启动 daemon 会生成 `~/.ai-productivity-tracker/runtime.json` 含 `{pid, port, token, ...}`,后续 MCP / Hook 子进程通过它发现 daemon。

### 2.5 体检

```bash
aipt doctor
```

输出形如:

```
[ ✓ ]  Node version: v22.18.0
[ ✓ ]  Home dir: /Users/foo/.ai-productivity-tracker
[ · ]  User config: 未配置(使用默认值)
[ ✓ ]  Daemon: http://127.0.0.1:17350 (pid=12345, v1.0.0)
[ ✓ ]  Data root: /Users/foo/.ai-productivity-tracker/data (3 个 jiraKey 目录)
[ ✓ ]  Cursor mcp.json: 已含 ai-productivity-tracker
[ ✓ ]  Cursor hooks.json: 已注入 afterAgentResponse hook
[ ✓ ]  Claude skill: ~/.claude/skills/ai-productivity-track/SKILL.md
[ ✓ ]  Cursor rule: ~/.cursor/rules/ai-productivity-track.mdc
[ · ]  Legacy data: 无老 truesight-agent 数据(无需迁移)
```

理想状态全 ✓ 或 ·。出现 ⚠ / ✗ 时根据提示修。

### 2.6 重启 IDE

让 IDE 重新加载 MCP / Hook 配置。Cursor 与 Claude Code 都需要完全退出后重启(不是 reload window)。

### 2.7 卸载老 `truesight-agent`(可选)

确认新版本无问题后再卸:

```bash
# 1. 停老 agent 服务(macOS)
launchctl unload ~/Library/LaunchAgents/com.truesight.local-agent.plist

# 2. 删 plist
rm ~/Library/LaunchAgents/com.truesight.local-agent.plist

# 3. 删老二进制
rm -f ~/Downloads/truesight-agent
rm -f ~/Downloads/ai-productivity-mcp.mjs

# 4. (确认无误后)删老数据
rm -rf ~/.truesight-local-agent/
```

---

## 3. 行为一致性保证

| 项                                                                                                          | 是否变化                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| MCP tool 名称(`ai_productivity_init` / `_status` / `_attach_summary` / `_extract_bundle` / `_save_lessons`) | **完全不变**                                                             |
| MCP tool 入参 schema(zod 字段名 / 必填项 / 描述)                                                            | **完全不变**                                                             |
| HTTP 端点路径(`/ai-productivity/*` 30+ 条)                                                                  | **完全不变**                                                             |
| 文件 schema(`requirement.json` / `iterations.jsonl` / `lessons/*` / `bindings.json`)                        | **完全不变**                                                             |
| `ai-productivity-track` skill / Cursor rule 文案                                                            | 路径文案小幅更新(`truesight-agent` → `ai-productivity-tracker`),逻辑等价 |
| Cursor `afterAgentResponse` hook 协议                                                                       | 不变                                                                     |
| Cursor stop / Claude Stop sentinel 防伪造校验                                                               | 不变(90s 时间窗保留)                                                     |
| transcript-watcher Claude Code jsonl 监听                                                                   | 不变                                                                     |

---

## 4. 双跑期(可选)

如果对新版本仍有疑虑,可以两个版本并行跑一段时间:

| 资源       | 老版本                                      | 新版本                             |
| ---------- | ------------------------------------------- | ---------------------------------- |
| 端口       | 17280                                       | 17350(默认错开)                    |
| 数据根     | `~/.truesight-local-agent/ai-productivity/` | `~/.ai-productivity-tracker/data/` |
| 浏览器看板 | web-tool-platform 上的 AI 提效面板模块      | `http://127.0.0.1:17350`           |
| 守护       | launchd                                     | npm 包 daemon                      |

唯一冲突点是 IDE MCP / Hook 配置只能指向一个,需要二选一。建议双跑期间 hooks.json / mcp.json 指向新版本,看着没问题再卸载老 agent。

---

## 5. 常见问题

### 5.1 npm 全局装失败 / 权限错

macOS / Linux 默认 npm 全局目录可能需要 sudo。推荐用 nvm / fnm / volta 管理 Node + 全局包,避免 sudo。

或者直接用 npx,缺点是 hook 触发慢:

```bash
# 不全局装,改用 npx
aipt() { npx -y @ai-productivity-tracker/cli "$@"; }
```

### 5.2 老 hook 路径(`~/Downloads/ai-productivity-mcp.mjs`)仍残留

`aipt install` 会自动识别并覆盖。如果想手动确认:

```bash
grep ai-productivity-hook ~/.cursor/hooks.json
# 应当输出 npm 全局路径下的 cli.mjs,不是 ~/Downloads/
```

### 5.3 数据迁移后看板看不到老需求

检查 `aipt doctor` 中 `Data root` 一行的 jiraKey 计数。若为 0,说明 cp 没生效:

```bash
ls ~/.ai-productivity-tracker/data/
# 应该能看到 INSTANT-123 / index.json / lessons / formula.json 等
```

否则重跑 `aipt migrate --force`。

### 5.4 端口 17350 被占

```bash
# 用其它端口
echo '{"port":17888}' > ~/.ai-productivity-tracker/config.json
aipt daemon
```

或临时 env:

```bash
AIPT_PORT=17888 aipt ui open
```

### 5.5 想完全卸载新工具

```bash
npm uninstall -g @ai-productivity-tracker/cli
# 关停 daemon
lsof -ti :17350 | xargs -r kill -TERM
# 删数据(可选)
rm -rf ~/.ai-productivity-tracker/
# 删 IDE 配置中残留(可选,marker 仍保留就不会冲突)
```

---

## 6. 参考

- 完整设计文档:[`docs/PRD.md`](./PRD.md)
- 架构与时序图:[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- 数据 schema:[`docs/DATA-MODEL.md`](./DATA-MODEL.md)
- Hook 协议:[`docs/HOOK-PROTOCOL.md`](./HOOK-PROTOCOL.md)
- 变更记录:[`docs/CHANGELOG.md`](./CHANGELOG.md)
