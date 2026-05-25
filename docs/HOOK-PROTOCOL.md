# HOOK PROTOCOL

> Cursor `afterAgentResponse` / `stop` Hook 与 Claude Code `Stop` / `UserPromptSubmit` Hook 的输入输出协议描述。
> 实现位于 `@ai-productivity-tracker/hook-core`(`hook.ts` / `stop-check.ts` / `install-cursor-hook.ts`)。

---

## 1. 协议概览

```
IDE event  ─────▶  aipt hook        ─POST /ai-productivity/hook────▶ daemon
                   (stdin: payload)                                  appendIteration + appendTokenUsage

IDE Stop   ─────▶  aipt stop-check  ─读 sentinel + check init──────▶ stdout: JSON decision
                   (stdin: payload)
```

两类入口都是"短 CLI":每次事件触发起一次 Node 进程,从 stdin 读 IDE 注入的 JSON payload,然后退出。

---

## 2. Cursor `afterAgentResponse` Hook

### 2.1 安装位置

`~/.cursor/hooks.json` 内 `hooks.afterAgentResponse` 数组:

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      {
        "command": "node /usr/local/lib/node_modules/@ai-productivity-tracker/cli/dist/cli.mjs hook # ai-productivity-hook"
      }
    ]
  }
}
```

marker `# ai-productivity-hook` 用于识别同源条目,`aipt install` 时按 marker 覆盖式更新。

### 2.2 stdin payload

```jsonc
{
  "hook_event_name": "afterAgentResponse",
  "cursor_version": "1.7.x",
  "conversation_id": "conv-xxxx",
  "generation_id": "gen-yyyy",
  "workspace_roots": ["/Users/foo/my-repo"],
  "model_name": "claude-sonnet-4.5",
  "tokens": {
    "input": 12345,
    "output": 678,
    "cache_creation": 90,
    "cache_read": 4321
  },
  "stop_reason": "end_turn",
  "tool_calls": [...]
}
```

### 2.3 hook 内部处理

```
1. parseHookTokens(payload) → { input, output, cacheCreation, cacheRead, effectiveTokens }
2. buildDedupeKey(conversation_id + generation_id)
3. resolveProjectRoot(workspace_roots[0])
4. POST agent /ai-productivity/hook { projectRoot, branch, tokens: effectiveTokens, source: 'cursor-hook', dedupeKey, rawHookPayload }
5. exit 0(成功) / exit 0(失败 fail-open,但 stderr 记日志)
```

### 2.4 fail-open

任何错误(daemon 不可达 / 鉴权失败 / 解析失败)都返回 exit 0,**不阻塞 IDE 主流程**。错误信息写 stderr 供事后排查。

---

## 3. Cursor `stop` Hook

### 3.1 安装位置

`~/.cursor/hooks.json` 内 `hooks.stop` 数组:

```json
{
  "hooks": {
    "stop": [
      {
        "command": "node /usr/local/lib/.../cli.mjs stop-check # ai-productivity-stop-check"
      }
    ]
  }
}
```

### 3.2 stdin payload

```jsonc
{
  "status": "completed",
  "loop_count": 0,
  "stop_hook_active": false,
  "hook_event_name": "Stop",
  "conversation_id": "conv-xxxx",
  "generation_id": "gen-yyyy",
  "workspace_roots": ["/Users/foo/my-repo"],
  "cursor_version": "1.7.x"
}
```

### 3.3 stop-check 内部决策树

```
1. parsePayload(stdin) → 提取 workspace_roots[0] / loop_count / status
2. (v1.0.0-rc.11) Cursor status ∈ {aborted, error} → skipped_aborted
   用户手动 ESC / Cancel / API 失败时,Cursor 仍会触发 stop hook,
   必须在最前面静默放行,绝不输出 followup_message
3. resolveTrackingContext(cwd) → { projectRoot, branch, issueKey }
4. issueKey 不存在 → skipped_no_issue_key
5. isRequirementInitialized(issueKey) === false → skipped_requirement_missing
6. agent 不可达(skipAgentReachability=false 时)→ skipped_agent_unavailable
7. loop_count >= 1(Cursor)/ stop_hook_active===true(Claude) → skipped_loop_guard
8. readRecentAttachSentinel(issueKey):
   - 文件存在 + calledAt 在 90s 窗内 → allowed_recent_attach (stdout 空,exit 0)
   - 否则 → inject_followup:
     stdout {
       "decision": "block",
       "reason": "<FOLLOWUP_REASON 字符串,详见 stop-check.ts>"
     }
```

> 注:`status` 字段为 Cursor stop hook payload 独有(`'completed' | 'aborted' | 'error'`),
> Claude Code Stop hook 文档明确 "do not fire on user interrupts",中断时根本不会进入
> stop-check;但 stop-check 内 `isAbortedStop()` 仍按方言对称处理,future-proof 防回归.

### 3.4 决策语义

| outcome.kind            | stdout                           | IDE 行为                                                                   |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `allowed_recent_attach` | 空                               | 正常结束                                                                   |
| `skipped_aborted`       | 空                               | 用户中断 / 出错,正常结束,绝不打扰                                          |
| `skipped_*`             | 空                               | 正常结束(前置条件不满足,放行)                                              |
| `inject_followup`       | `{decision:"block", reason:...}` | Cursor 把 reason 当作新一轮 user 消息,LLM 被迫重新答复 + 调 attach_summary |

---

## 4. Claude Code `Stop` Hook

协议与 Cursor `stop` 大同小异,差异:

- stdin schema 字段名:`session_id` / `transcript_path` 替代 `conversation_id` / `generation_id`
- stop-check 实现共用 `runStopCheck()`,通过 `dialect: 'claude' | 'cursor'` 区分细节
- Claude Code 把 `{decision:"block", reason:...}` 注入为 system stop_hook_summary 行,transcript-watcher 会识别并触发 stop_hook_summary flush

---

## 5. Claude Code `UserPromptSubmit` Hook

### 5.1 用途

仅作为 **reminder**:每次用户提交 prompt 时,通过 stdout 输出一条提示文本,
Claude Code 把它注入上下文,主动提醒 LLM 调用 `ai_productivity_attach_summary`。

### 5.2 安装位置

`~/.claude/settings.json` `hooks.UserPromptSubmit`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "printf '%s\\n' '# ai-productivity-track-reminder ...'"
          }
        ]
      }
    ]
  }
}
```

marker `# ai-productivity-track-reminder` 用于识别。

### 5.3 行为

纯文本输出,不读 stdin,固定字符串。详细文案见 `@ai-productivity-tracker/core track-skill-templates.ts CLAUDE_TRACK_HOOK_REMINDER_COMMAND`。

---

## 6. agent HTTP 端点

Hook → daemon 的 HTTP 请求统一走 `POST /ai-productivity/hook`,body:

```jsonc
{
  "projectRoot": "/Users/foo/my-repo",
  "branch": "feature/ABC-1234-xxx",
  "tokens": 12345,
  "source": "cursor-hook" | "claude-hook",
  "dedupeKey": "conv-xxx_gen-yyy",
  "rawHookPayload": { /* 原始 IDE 注入数据 */ }
}
```

Authorization: `Bearer <token>` 头,token 来自 `~/.ai-productivity-tracker/runtime.json`。

响应 200:

```jsonc
{
  "code": "OK",
  "data": {
    "ok": true,
    "deduped": false, // 重复 dedupeKey 时 true
    "bound": true, // 该 cwd 已 init 过 requirement
    "accumulated": 12345, // 本次累加的 token
    "cumulativeToken": 234000, // 累计
    "jiraKey": "ABC-1234",
    "iterationSeq": 12,
    "reason": "ok"
  }
}
```

---

## 7. 失败兜底

| 情况                    | hook 行为                                                  | stop-check 行为                  |
| ----------------------- | ---------------------------------------------------------- | -------------------------------- |
| daemon 不可达           | exit 0,stderr 警告                                         | `skipped_agent_unavailable`,放行 |
| token 不一致(401)       | exit 0,stderr 警告                                         | 同上                             |
| jiraKey 解析失败        | 仍写 `bindings.json` 的 pending 区(本机直写),不依赖 daemon | `skipped_no_issue_key`,放行      |
| stdin payload JSON 损坏 | exit 0,stderr 警告                                         | `skipped_invalid_payload`,放行   |

设计原则:**hook 永远不阻塞 IDE 主流程**。stop-check 仅在"已 init 需求 + 老链路 hook 全就位 + sentinel 缺失"时才 inject_followup。

---

## 8. 兼容性 / 老条目识别

- `aipt install` 检测 `~/.cursor/hooks.json` 内的老路径模式:
  - `~/Downloads/ai-productivity-mcp.mjs hook`(v2.2.x 用户手动下载) → 替换
  - `~/.local/bin/ai-productivity hook`(v2.1.x 独立 CLI,已下线) → 替换
- `aipt install` 检测 `~/.claude/settings.json` 内的废弃 marker:
  - `# ai-productivity-mark-tool-called`(v2.10.0 起下线) → 清理
  - `~/.local/bin/ai-productivity.mjs hook`(v2.1.x install.sh 死代码) → 清理

详见 `@ai-productivity-tracker/hook-core install-cursor-hook.ts` 与 `@ai-productivity-tracker/server skill-sync.ts`。
