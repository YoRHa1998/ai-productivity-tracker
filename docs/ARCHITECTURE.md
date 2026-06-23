# ARCHITECTURE

> 详细架构与时序图。本文档补充 [`PRD.md`](./PRD.md) §3-§5 中"为什么这么设计"的细节。

---

## 1. 进程拓扑

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              用户机器                                       │
│                                                                            │
│  ┌──────────┐   stdio   ┌────────────┐                                     │
│  │ Cursor   │ ─────────▶│ aipt mcp   │ ─┐                                  │
│  └──────────┘           │ (子进程)    │  │                                  │
│  ┌──────────┐   stdio   ├────────────┤  │   HTTP + Bearer token            │
│  │ Claude C │ ─────────▶│ aipt mcp   │ ─┼─────────────┐                    │
│  └──────────┘           └────────────┘  │             │                    │
│                                          │             ▼                    │
│  ┌──────────────┐  exec    ┌────────────┐│   ┌──────────────────────┐      │
│  │ Cursor hook  │ ────────▶│ aipt hook  │┼──▶│  aipt daemon          │      │
│  │ Claude hook  │          └────────────┘│   │  (单例后台进程)         │      │
│  └──────────────┘                        │   │  127.0.0.1:17350      │      │
│                                          │   │  ┌─────────────────┐   │      │
│  ┌──────────────┐                        │   │  │ http.createServer│  │      │
│  │ 浏览器        │  same-origin HTTP     │   │  │ + transcript-    │  │      │
│  │ 看板 SPA      │ ──────────────────────┴──▶│  │   watcher        │  │      │
│  └──────────────┘                            │  └─────────────────┘  │      │
│                                              └─────┬────────────────┘      │
│                                                    │ tmp+rename atomic     │
│                                                    ▼                       │
│                                  ┌─────────────────────────────────┐        │
│                                  │ ~/.ai-productivity-tracker/     │        │
│                                  │ ├── runtime.json (pid/port/token)│       │
│                                  │ ├── config.json (用户偏好)        │        │
│                                  │ ├── logs/                       │        │
│                                  │ ├── hook-state/                 │        │
│                                  │ │   └── <jiraKey>.recent-attach │        │
│                                  │ └── data/                       │        │
│                                  │     ├── <JIRA-KEY>/             │        │
│                                  │     │   ├── requirement.json    │        │
│                                  │     │   ├── iterations.jsonl    │        │
│                                  │     │   ├── numstat-snapshot.json│       │
│                                  │     │   └── raw/<seq>.json      │        │
│                                  │     ├── lessons/                │        │
│                                  │     ├── bindings.json           │        │
│                                  │     ├── pending-summary.json    │        │
│                                  │     ├── transcript-state.json   │        │
│                                  │     ├── formula.json            │        │
│                                  │     └── jira.json               │        │
│                                  └─────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.1 进程角色

| 角色              | 拉起方                                                                                           | 生命周期                    | 进程数                              |
| ----------------- | ------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------- |
| `aipt daemon`     | 首个 mcp / ui / install 子命令通过 `ensureDaemon()` spawn-detached;也可手动 `aipt daemon` 前台跑 | 后台常驻直到 SIGTERM        | **全局唯一**(runtime.json 单实例锁) |
| `aipt mcp`        | IDE 通过 mcp.json 拉起                                                                           | 与 IDE 同生命周期           | 每个 IDE 实例 1 个                  |
| `aipt hook`       | Cursor hooks.json / Claude settings.json `command` 行                                            | 一次性,每轮 hook 触发起一次 | 即起即退                            |
| `aipt stop-check` | Cursor stop / Claude Stop hook                                                                   | 一次性                      | 即起即退                            |

### 1.2 数据流

```
hook (every turn)
   │
   ├─ stdin payload ─▶ aipt hook ─POST /ai-productivity/hook─▶ daemon
   │                                                            │
   │                                                            ├─▶ appendIteration (per JiraKey)
   │                                                            └─▶ appendTokenUsage to bindings.json
   │
   └─ Cursor stop / Claude Stop ─▶ aipt stop-check ─读 sentinel─▶ decision

LLM (per turn)
   └─ ai_productivity_attach_summary tool ─▶ mcp ─POST /attach-summary─▶ daemon
                                                                          │
                                                                          ├─▶ writePendingSummary <jiraKey>
                                                                          └─▶ writeRecentAttachSentinel(90s window)

Claude Code transcript jsonl (background)
   └─ chokidar watch ~/.claude/projects/**/*.jsonl ─▶ transcript-watcher ─▶ appendIteration

Codex CLI rollout jsonl (background)
   └─ watch ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ─▶ codex-watcher ─▶ appendIteration (source=codex)
```

---

## 2. daemon 启动状态机

```
                ┌───────────────────────────┐
                │ aipt mcp / install / ui   │
                └─────────────┬─────────────┘
                              │ ensureDaemon()
                              ▼
                ┌─────────────────────────────┐
                │ readRuntimeLock()           │
                └─────────────┬───────────────┘
                              │
                  ┌───────────┴────────────┐
                  │                        │
            lock 存在?                  lock 不存在
                  │                        │
                  ▼                        ▼
        ┌────────────────────┐   ┌──────────────────┐
        │ isPidAlive(lock.pid)│   │ spawnDaemon()   │
        │ + ping /status     │   │ (detached+unref) │
        └──────┬─────────────┘   └────────┬─────────┘
               │                          │
       ┌───────┴──────┐                   ▼
       │              │              ┌──────────────────────┐
   healthy        unhealthy           │ poll runtime.json 直到│
       │              │              │ pid + /status 就绪    │
       ▼              ▼              └──────┬───────────────┘
   return         spawnDaemon()             ▼
   { reused }                         return { spawned }
```

### 2.1 daemon 本体启动序列

```
1. resolveServerConfig(args)
   ├─ port:  CLI > AIPT_PORT env > config.json.port > runtime.json (上次) > pickPort()
   ├─ host:  CLI > AIPT_HOST env > config.json.host > '127.0.0.1'
   ├─ token: CLI > AIPT_TOKEN env > runtime.json (上次) > generateToken(32 bytes hex)
   └─ webRoot: <bundle dir>/web/ 若存在,否则 undefined(API-only 模式)

2. startDaemon(config)
   ├─ new TranscriptWatcher() → start()(扫 ~/.claude/projects)
   ├─ new CodexWatcher() → start()(递归扫 ~/.codex/sessions,受同一 AIPT_DISABLE_TRANSCRIPT_WATCHER 开关)
   ├─ createServer(handleRequest)
   │  └─ listen(port, host)  ──▶ 失败回到 pickPort 重选
   └─ resolve DaemonHandle { port, host, server, stop }

3. writeRuntimeLock({ pid, port, host, token, startedAt, version, dataRoot })
   └─ tmp + rename atomic write, mode 0600

4. process.on(SIGTERM | SIGINT, async () => {
     await handle.stop()         // stop watcher + close server
     removeRuntimeLock()         // 清孤儿
     process.exit(0)
   })

5. 主循环阻塞(返回 Promise<never>)
```

---

## 3. sentinel + stop-check 防伪造时序

LLM 在 IDE 内每轮答复结束前应当调用 `ai_productivity_attach_summary` MCP tool。
但 LLM 偶尔会"想象"已经调过却没真调。stop-check 通过 sentinel 文件做事实校验:

```
LLM ─call─▶ mcp:ai_productivity_attach_summary
              │
              └─POST /ai-productivity/attach-summary
                                │
                ┌───────────────┴───────────────────────┐
                ▼                                       ▼
        writePendingSummary <jiraKey>      writeRecentAttachSentinel <jiraKey>
        (主数据落盘)                       (90s 时间窗 sentinel)

(随后)IDE 触发 Stop / afterAgentResponse hook
              │
              ▼
       aipt stop-check (stdin: cursor/claude payload)
              │
              ├─ resolveTrackingContext → cwd → branch → jiraKey
              │
              ├─ readRecentAttachSentinel(jiraKey)
              │   ├─ 文件存在 + calledAt 在 90s 窗内 → allowed_recent_attach
              │   └─ 否则 → inject_followup (block + followup_message,逼 LLM 在下一轮重调)
              │
              └─ 输出 JSON / exit code 给 IDE 处理
```

### 3.1 sentinel 时间窗为什么是 90s

`packages/hook-core/src/lib/sentinel.ts`:

- 10s 太短(早期实测 LLM 调完 attach 后写大段总结 21-30s 才 end_turn,被误判为漏调)
- 90s 覆盖"调 attach + 长文输出 + Cursor stop hook 冷启动 + 安全余量"
- 同 jiraKey 同时存在多对话窗口极少,撞窗代价仅是"另一对话的 followup 被吞",远比"每轮强制重答"代价小

---

## 4. transcript-watcher 内部时序

监听 `~/.claude/projects/**/*.jsonl`(Claude Code 落盘的对话 transcript):

```
chokidar.watch(...)
       │
       ▼
对每个 .jsonl 维护 (offset, fileSize) → 增量 read
       │
       ▼
       parseJsonlLine → ParsedAssistantMessage
       │
       ▼ (按 sessionId 路由)
       PendingTurn buffer
       ├─ 累加 tokenSum / 修正 effectiveTokens
       ├─ 记 firstMessageTs / lastMessageTs
       └─ flush 触发:
          ├─ stop_reason ∈ TERMINAL_STOP_REASONS('end_turn' / 'max_tokens' / 'pause_turn' / 'stop_sequence') → flushTurn(assistant_terminal)
          ├─ jsonl 注入 system stop_hook_summary 行 → flushTurn(stop_hook_summary)
          └─ buffer 闲置 > 60s + 仍未 terminal → flushTurn(stale_timeout)
       │
       ▼
       flushTurn → appendIteration to <jiraKey>/iterations.jsonl
                   ↑
                consumePendingSummary
                (上一轮 attach_summary 的 conversationSummary 自然挂载到本 iteration)
```

### 4.1 关键去重

- **msg.id 主去重**(`seenApiMessageIds` LRU 5000):同一 message.id 重复 jsonl 行直接丢
- **fingerprintTokens 兜底**(`input|output|cacheCreation|cacheRead`):msg.id 缺失场景下用 usage 四元组兜底

### 4.2 codex-watcher 内部时序(Codex CLI)

独立类 `CodexWatcher`(`packages/core/src/codex-watcher.ts`),与 Claude watcher 隔离避免回归。
监听 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(**日期三层嵌套**,recursive watch + 30s 周期扫):

```
对每个 .jsonl 增量 read(复用 readJsonlIncremental,独立 codex-state.json offset)
       │
       ▼ 先读首行 session_meta → 缓存 sessionId→{cwd, gitBranch}(cwd/branch 仅首行出现)
       │
       ▼ 按所属文件 session 归属每行(token_count / turn_context 行内不带 sessionId)
       PendingTurn buffer:
       ├─ turn_context  → 记 model
       ├─ user_message  → 记 userPromptTs(本轮真实起点)
       ├─ token_count   → 取最新 total_token_usage 的累计有效值(input − cached_input + output)
       └─ task_complete → flushTurn
       │
       ▼ 本轮增量 = 当前累计有效 − 该 session 上次 flush 的累计(codex-state.json 持久化基线,跨重启不双算)
       │
       ▼ flushTurn → appendTokenUsage(..., 'codex') + appendIteration({ source:'codex' })
```

- 轮边界:`event_msg/task_complete`(Codex 的 terminal 等价物);兜底 stale flush 阈值同 30min。
- token 口径与 Claude effectiveTokens 对齐:`cached_input_tokens`(≈ cache_read)排除。
- 非 Jira 分支 / 非 git 仓库 / 需求未 init 的 session 静默放行,不落 iteration(与 Claude 一致)。

---

## 5. ensureDaemon 决策树

```ts
function ensureDaemon():
  lock ← readRuntimeLock()
  if lock && isPidAlive(lock.pid) && pingStatus(lock.host:lock.port, 800ms):
    return { kind: 'reused', endpoint: ... }
  else:
    token ← generateToken()       // 写到 spawn 子进程 AIPT_TOKEN env
    spawn(cli.mjs, ['daemon', '--auto'], {
      detached: true,
      stdio: ['ignore', logsDir/daemon-out.log, logsDir/daemon-err.log],
      env: { AIPT_TOKEN: token, ... }
    }).unref()
    // 轮询 runtime.json 直到新 pid 落齐 + /status OK
    while (now - start) < 5000ms:
      sleep(120ms)
      lock ← readRuntimeLock()
      if lock.pid === child.pid && pingStatus(...):
        return { kind: 'spawned', endpoint: ... }
      if child.exitCode !== null:
        throw `daemon 启动失败,见 logs/daemon-err.log`
    throw `daemon 在 5s 内未就绪`
```

**关键点**:

- `detached: true` + `unref()`:父进程(mcp 子进程)死了 daemon 也能继续跑
- `stdio: ['ignore', logFile, logFile]`:detach 后 stdout/stderr 不会丢
- 单实例锁通过 `runtime.json` + `isPidAlive` + http ping 三重确认,避免"lockfile 残留但进程已死"导致复用失败

---

## 6. skill-sync 写盘原子性

`@ai-productivity-tracker/server skill-sync.ts` 处理 `~/.claude/skills/` 与 `~/.cursor/rules/` 注入:

```
对每个 skill 文件:
  1. computeSha256(template content)
  2. computeSha256(existing file content)  // 若存在
  3. 若 sha256 相同 → 跳过(state=synced)
  4. 否则:
     ├─ write tmpfile = <target>.<pid>.tmp
     ├─ renameSync(tmpfile, target)        // 原子覆盖
     └─ state=outdated → synced(replaced)
```

对 hook 文件(`hooks.json` / `settings.json`)的注入采用 marker 识别:

- marker `# ai-productivity-hook` / `# ai-productivity-stop-check` / `# ai-productivity-track-reminder`
- 已有同 marker 条目 → 原地覆盖
- 不存在 → append 新条目
- 老 v2.x marker(`# ai-productivity-mark-tool-called` / `~/.local/bin/ai-productivity`)主动清理

---

## 7. 看板 SPA 同源策略

```
浏览器 → http://127.0.0.1:17350/
            │
            ▼
   daemon static route:
   ├─ exact match → file system serve
   ├─ dir match → /index.html
   └─ unknown path → /index.html (SPA history fallback)

浏览器 → http://127.0.0.1:17350/ai-productivity/storage-path
            │
            ▼
   daemon API route + cors.applyCors():
   ├─ origin = http://127.0.0.1:17350 ── isLocalOrigin? ─yes──▶ 放行
   └─ panel-bypass 路径 → 免 Bearer
```

**安全 implications**:

- daemon 强制 listen 127.0.0.1,任何非 loopback 请求 OS 层就拒
- 看板 SPA 因为同源,fetch 无需 token,也无需 CORS preflight(简化前端)
- IDE / Hook 走 Bearer token 鉴权;token 在 runtime.json 内,只有同用户进程才能读

---

## 8. 错误码与重试矩阵

| 端点                               | 状态码              | 含义                                  | 调用方处理                        |
| ---------------------------------- | ------------------- | ------------------------------------- | --------------------------------- |
| `/status`                          | 200                 | daemon 健康                           | —                                 |
| `/status`                          | 网络异常            | daemon 未起                           | ensureDaemon 触发 spawn           |
| `/ai-productivity/init`            | 400                 | jiraInput 缺失 / 解析失败             | MCP 透传错误,提示用户改 jira 参数 |
| `/ai-productivity/init`            | 409                 | 当前分支不含 issueKey / detached HEAD | MCP 透传                          |
| `/ai-productivity/attach-summary`  | 200                 | (软兜底)字段缺失自动用 oneLine 填充   | 静默                              |
| `/ai-productivity/attach-summary`  | 404                 | 需求未 init                           | MCP 透传                          |
| `/ai-productivity/refresh-bugs`    | 400                 | JQL 模板未配 / unbounded              | 引导用户去看板「业务配置」配 Jira |
| `/ai-productivity/sync-jira-title` | 401/403/404/422/502 | Jira 凭证 / 网络 / URL 问题           | 按 reason 细分文案                |

---

## 9. 待补章节(后续版本)

- 多 dataRoot 切换的 lockfile 设计(v1.2)
- 团队同步 git push 时的冲突合并策略(v1.3)
- VS Code Extension 与 cli 包共存策略(v1.3)
