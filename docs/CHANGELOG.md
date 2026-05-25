# Changelog

本文件记录 `@ai-productivity-tracker/cli` 独立项目的所有版本变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/);格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 源项目 `instant-web-tools` 内 AI 提效面板模块的历史变更(v2.0 ~ v2.18.x)归档在
> `specs/modules/ai-productivity-tracker/change_log.md`,本仓库 v1.x 从那里继承全部行为契约。

---

## [Unreleased]

### Fixed

**Cursor `stop` hook 在用户手动中断时仍误触 followup_message,LLM 被强制重答**

实测现象:用户在 Cursor 里按 ESC / Cancel 中断当前对话后,几秒内 Cursor
会自动 submit 一条 `[ai-productivity 防伪造校验] ...` 文案,LLM 被强制重新答复,
完全违背用户中断意图,体验极差。

根因:Cursor 官方 [Hooks 文档](https://cursor.com/docs/hooks.md) 明确 stop hook
payload 含 `status: "completed" | "aborted" | "error"` 字段;但我们的
`runStopCheck()` 完全没读 `status`,任何状态下都跑 sentinel 校验,
sentinel 缺失就 `inject_followup`,Cursor 把 followup_message 当作下一轮 user prompt
自动 submit。

对照:Claude Code Stop hook 文档明确 "do not fire on user interrupts",中断时根本不调
Stop hook,所以同 IDE 装的 evolution 等 skill 天然不被中断打扰 —— **Cursor 行为不同,
必须在 stop-check 内主动过滤**。

修复:[`packages/hook-core/src/stop-check.ts`](../packages/hook-core/src/stop-check.ts) 内 `detectDialect()` 之后
立即调 `isAbortedStop(parsed, dialect)`,Cursor `status ∈ {aborted, error}` →
立即返回新 outcome `skipped_aborted`(`output: null`),不再跑 git / sentinel / agent ping
任何后续逻辑,零开销零打扰。

向后兼容:`status` 字段缺失(老 Cursor / 测试 fixture)按 `'completed'` 处理,
**不**判定为 abort,原有 sentinel 校验逻辑全保留,不会让"中断"和"老版本"混淆。

新增 4 例单元测试覆盖 aborted / error / 优先级 / 老 payload 兼容,612 → 616 例全绿。

---

## [1.0.0-rc.7] - 2026-05-25

> 首个**端到端可用**的 RC 版本(MCP 真能连上 Cursor / Claude Code)。
>
> 之前 rc.1 ~ rc.6 因不同的安装期 / 启动期 bug 全部 npm deprecate,
> **请直接用 rc.7+**。详见下方各 rc 版本的 deprecation 说明。

### Fixed(rc.6 → rc.7 关键修复)

**MCP 子进程缺 event-loop hang,startMcpServer 后立即 exit 导致 stdio 关闭**

实测 Cursor MCP 连接报"MCP error -32000: Connection closed":

- `[ai-productivity-mcp] running ...` 启动日志正常
- 紧接着 `Connection failed`,Cursor 前端红色 Error

根因:`@modelcontextprotocol/sdk` 的 `await server.connect(transport)` 只是把
stdio transport 注册到事件循环,**立刻 resolve(不阻塞)**。我们的 `runMcp()`
resolve 后,`main().then(code => process.exit(code))` 立即调用 process.exit,
mcp 子进程立即退出 → stdio JSON-RPC channel 断开。

修复:`runMcp()` 末尾 `return new Promise<number>(() => {})` 阻塞 event loop,
让 stdio transport 处理 JSON-RPC 直到外部 SIGTERM(IDE 关闭 MCP 子进程时自然杀掉)。
daemon 子命令早就用了相同模式,mcp 子命令漏改。

---

## [1.0.0-rc.3] - 2026-05-25(被 rc.4+ 修复迭代取代)

### Added(首版核心能力)

- **`@ai-productivity-tracker/cli`** 单包发布:
  - bin: `ai-productivity-tracker` / `aipt`(别名)
  - argv-router 13 个子命令(`mcp` / `daemon` / `hook` / `stop-check` / `install` / `install-mcp` / `migrate` / `ui open` / `doctor` / `version` / `help` 等)
  - esbuild 单文件 bundle 内联 5 个内部子包,产物 ~1MB(gzip ~300KB)
- **内部 6 个子包**(esbuild bundle 内联,用户不感知):
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
- **跨平台支持**:macOS / Linux 完整测试,Windows 路径处理已就绪(detached spawn / pid 探活 / 进程组信号待 Windows 实机验证)
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

### Fixed(相对 rc.1 / rc.2 的修复)

- **rc.1 → rc.2**:`cli/package.json` dependencies 含 `workspace:*` 协议,用户
  `npm i -g` 直接 `EUNSUPPORTEDPROTOCOL` 失败。修复:把所有 workspace 子包 +
  已 bundle 的 deps 全部下移到 devDependencies;新增 release.mjs
  `withPublishableManifest()` 包装,publish 前临时移除 devDependencies + scripts,
  publish 完恢复。tarball 内 package.json 从 1.7KB 缩到 866B,完全 0 个外部依赖
- **rc.2 → rc.3**:cli 入口 `isDirectRun` 在 npm 全局 symlink 启动场景下永远 false
  (`import.meta.url` 是 realpath,`process.argv[1]` 是 symlink 路径,两者不等),
  导致 main() 不跑,`aipt version` / `aipt doctor` 全部静默 exit 0。修复:删除
  isDirectRun 判断,cli.mjs 作为唯一 entry 直接调 main();单测/import 场景用
  `process.env.AIPT_SKIP_AUTOSTART` 守卫

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

590 例自动化测试,40 个 spec 文件覆盖:

- core(22 spec, 442 例):全部 store / metrics / transcript-watcher / hook-dedupe / jira-bug-client
- hook-core(6 spec, 83 例):hook / stop-check / install-cursor-hook / sentinel / agent-client
- mcp(3 spec, ~30 例):agent-client / tools / argv-router
- server(2 spec, 83 例):routes/ai-productivity + skill-sync
- cli(7 spec, 64 例):paths / pick-port / runtime-lock / config / install-mcp / migrate + daemon e2e(spawn 真 daemon,含 crash 重启 + 端口冲突场景)

### 发布产物指标(rc.7)

- npm tarball: **633 KB**(阈值 3 MB,PRD §V14 达标)
- unpacked dist: **2.6 MB**(阈值 5 MB,PRD §V14 达标)
- 运行时外部依赖: **0**(全部 esbuild bundle 内联)
- 文件清单:`dist/cli.mjs`(1.0 MB)+ `dist/web/`(SPA assets)+ `dist/version.json` + `package.json`(866 B 精简版)

---

## DEPRECATED 版本汇总

> 以下 6 个 rc 版本都因不同的 packaging / 启动期 bug 在 npm registry 上做了 `npm deprecate` 标记。
> 用户安装时 npm 会打印 deprecation warning + 推荐升级到 rc.7。

### [1.0.0-rc.6] - 2026-05-25 — DEPRECATED ⚠️

> mcp 子命令在 `startMcpServer()` 后立即 process.exit,stdio 关闭 → Cursor MCP
> 报 `MCP error -32000: Connection closed`。日志显示 server 启动成功但连接立刻失败。

deprecate 原因:`stop-check hook command still points to ~/Downloads/ai-productivity-mcp.mjs (legacy v2.x death path, file not exist after install). Please use 1.0.0-rc.6 or later.` (注:rc.5 → rc.6 修了路径,rc.6 → rc.7 修了 mcp hang。每次 rc 暴露的新问题都不同)

### [1.0.0-rc.5] - 2026-05-25 — DEPRECATED ⚠️

> `skill-sync.ts` 的 `defaultMcpBinPath()` 仍硬编码 `~/Downloads/ai-productivity-mcp.mjs`,
> 导致 hooks.json 中 stop-check hook 命令指向已删除的文件,Cursor stop hook 触发时 ENOENT 静默失败。

### [1.0.0-rc.4] - 2026-05-25 — DEPRECATED ⚠️

> mcp.json / hooks.json 内的 `node` 是相对命令,依赖 PATH 解析。macOS GUI 应用
> (Cursor / Claude Code)从 launchd 启动子进程时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`,
> nvm/volta/fnm 装的 node 全部不在里面,触发 ENOENT 静默失败。

### [1.0.0-rc.3] - 2026-05-25 — DEPRECATED ⚠️

> `aipt install` 调 daemon `/install-cursor-hook` 端点时,daemon handler 硬检查
> `~/Downloads/ai-productivity-mcp.mjs` 文件存在性,不存在 → HTTP 412。
> cli 早已通过 body.hookEntry 传了正确的全局 cli.mjs 路径,但 handler 完全没接住。
> 同时 install-mcp 默认 command 是 `npx -y ...`,macOS GUI 应用启 MCP 子进程时拉包易超时。

### [1.0.0-rc.2] - 2026-05-25 — DEPRECATED ⚠️

> cli 入口 main() 在 npm 全局 symlink 启动场景下不触发(`isDirectRun` 判断失效),
> 所有命令静默 exit 0,完全不可用。

deprecate 原因:`installs cleanly but cli entry never runs main() on symlinked bin. Please use 1.0.0-rc.3 or later.`

### [1.0.0-rc.1] - 2026-05-25 — DEPRECATED ⚠️

> `cli/package.json` `dependencies` 含 `workspace:*` 协议,用户 `npm install -g` 直接报
> `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"` 安装失败,完全装不上。

deprecate 原因:`packaging bug: dependencies contain workspace:* protocol, fails to install. Please use 1.0.0-rc.3 or later.`

---

## 📚 发布工程经验(踩坑笔记)

本仓库首次走完"独立 npm 包"完整发布流程,从 rc.1 走到 rc.7 才真正端到端可用。
**每个 rc 暴露不同维度的非显然问题**——这是新 OSS 包正常发布节奏,关键是
deprecate 老版本 + CHANGELOG 透明记录,让后来者一次就跑通。

记录 9 条经验供后续 release 或同类 OSS 项目参考。

### 1. pnpm `<script>` 会把全局 `~/.npmrc` 注入为 `npm_config_*` env

**现象**:`release.mjs` 通过 `execSync('npm whoami --userconfig=./.npmrc.publish')`
查身份时持续报 ENEEDAUTH,但手动在 shell 里跑完全相同的命令成功。

**根因**:`pnpm release` 跑 script 时,pnpm 会读全局 `~/.npmrc` 的所有配置,
作为 `npm_config_*` env 注入给子进程。`npm config list` 在子进程中显示:

```
; "user" config from /Users/.../.npmrc.publish
; registry = "https://registry.npmjs.org/" ; overridden by env  ← 被 env 覆盖!

; "env" config from environment
registry = "http://npm.truesightai.com/"                          ← 这才生效
```

token 在 .npmrc.publish 里,但 registry 被 env 顶到公司私有源,token 不匹配 → 401 / ENEEDAUTH。

**修复**:CLI flag 优先级最高,显式同时带 `--userconfig=<abs> --registry=<official>`,
碾压 pnpm 注入的 env。详见 `scripts/release.mjs` `userConfigFlag` 常量与 JSDoc 注释。

### 2. `workspace:*` 协议不能进 publish 的 `dependencies`

**现象**:rc.1 发布后,任何用户跑 `npm i -g @ai-productivity-tracker/cli@1.0.0-rc.1` 立即
报 `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`,根本装不上。

**根因**:pnpm workspace 用 `workspace:*` 协议链接 monorepo 子包,这是 pnpm-only
语义。`npm publish` 不识别也不重写它,把含 `workspace:*` 的 package.json 原样塞进
tarball。用户端 npm 看到 `workspace:*` 直接拒绝(npm 7+ 才识别它,但仅在 pnpm
workspace 上下文里)。

**修复(双层防御)**:

1. cli/package.json 把所有 workspace 子包从 `dependencies` 下移到
   `devDependencies`(运行时由 esbuild bundle 保证,无需声明)
2. release.mjs 新增 `withPublishableManifest()` 包装:publish 前临时改 package.json
   删除 devDependencies + scripts,publish 完恢复。tarball 内 package.json 缩到 866B

### 3. ESM 入口 `isDirectRun` 检测在 npm bin symlink 启动场景下失效

**现象**:rc.2 装上后,`aipt version` / `aipt doctor` 等所有命令静默 exit 0,没有
任何输出。

**根因**:cli/src/index.ts 末尾有经典 ESM "entry 检测":

```js
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main()
}
```

但 npm 全局装 bin 是 symlink:

- `process.argv[1]` = `/usr/local/bin/aipt`(symlink 路径)
- `import.meta.url` = `file:///usr/local/lib/.../cli.mjs`(realpath)

两者永远不相等 → `isDirectRun=false` → `main()` 不跑 → 静默 exit。

**修复**:cli.mjs 作为单一 entry 文件,删掉 `isDirectRun` 判断直接调 `main()`;
单测/import 场景用 `process.env.AIPT_SKIP_AUTOSTART` 守卫(默认值未设,自动启动)。

### 4. npm 2FA 强制策略 + Granular Access Token (GAT) 是 OSS 最佳实践

**现象**:首次 `npm publish` 报 403:

> Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.

**根因**:npm 自 2022 起对所有 public package 强制要求 2FA(或带 bypass 2fa 的
GAT)。这是 npm 平台侧策略,非代码问题。

**最佳实践组合**:

1. **账号开 2FA**(Security Key 或 TOTP 任一):保护账号本身
2. **Granular Access Token 给 publish 用**:
   - Permissions: Read and write
   - Packages: 只选 `@<scope>`(限定 scope,降低泄露面)
   - **Bypass 2FA enabled: YES**(让 CI / 脚本不卡 OTP)
   - Allow login: NO(GAT 只 publish,不 login)
   - Expiration: 90-365 天
3. token 写到项目级 `.npmrc.publish`(gitignored)+ release.mjs 自动通过
   `--userconfig` 注入

效果:`pnpm release --publish` 完全静默通过 2FA 校验,token 限定在单一 scope,
即便文件泄露最大破坏面也仅限于 publish 这一个 scope 的包。

### 5. macOS GUI 应用启子进程时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`

**现象**:rc.4 把 mcp.json 配置改成 `{ command: "node", args: ["<abs cli.mjs>", "mcp"] }`,
shell 终端跑完全 OK,但 Cursor 启 MCP 子进程时静默 ENOENT 失败。

**根因**:Cursor / Claude Code 等 GUI 应用从 macOS launchd 启动,继承的 PATH **不是**
你 shell rc 文件里的 PATH,而是 macOS 系统默认 `/usr/bin:/bin:/usr/sbin:/sbin`。
nvm / volta / fnm / asdf 等 Node 版本管理器装的 node 全部不在这个 PATH 里,
`exec node ...` 直接 ENOENT。

**修复**:**所有写到 IDE 配置的命令必须用 `process.execPath` 绝对路径**,
不依赖 PATH 解析:

```ts
// install-mcp.ts / install-cursor-hook / skill-sync stop-check 三处都这么写
const command = process.execPath // /Users/.../bin/node 绝对路径
const args = [process.argv[1] /* cli.mjs 绝对路径 */, 'mcp']
```

同样适用于 Linux 用户用 nvm/volta 时,以及未来 Windows 的 nvs/nvm-windows。

### 6. stdio MCP server 启动后必须显式 hang event loop

**现象**:rc.6 实测 Cursor 报 `MCP error -32000: Connection closed`,但日志
显示 mcp 启动成功(`[ai-productivity-mcp] running ...`)。

**根因**:`@modelcontextprotocol/sdk` 的 `await server.connect(transport)` 接受
一个 transport,底层做的事:

1. 把 process.stdin 注册成 readable 监听
2. 把 process.stdout 注册成 writable
3. resolve Promise

它**不阻塞**——只是把回调挂到 Node event loop。但 cli `runMcp()` resolve 后
`main().then(code => process.exit(code))` 立即调 `process.exit(0)`,**就算 stdio
监听器还在,process.exit 也会强制杀进程** → Cursor stdio JSON-RPC channel 断开。

**修复**:子命令显式 hang event loop:

```ts
export async function runMcp(): Promise<number> {
  await ensureDaemon()
  await startMcpServer() // 注册 stdio 监听后立刻 resolve
  // 永不 resolve,event loop keep alive,直到外部 SIGTERM
  return new Promise<number>(() => {})
}
```

`daemon` 子命令早就用了相同模式(SIGTERM/SIGINT handler 内调 process.exit),
**mcp 子命令是漏改**。所有"长期运行的 stdio / HTTP server 子命令"都需要这个模式。

### 7. 大型项目迁移时的"死代码 fallback"陷阱

**现象**:从 rc.3 到 rc.6,陆续在 4 个地方发现源仓库 v2.x 留下的死代码,
全部默认指向 `~/Downloads/ai-productivity-mcp.mjs`(老的"用户手动 curl 下载"位置):

1. `server/routes/ai-productivity.ts` `defaultHookEntryPath()` + 412 错误文案
2. `server/routes/ai-productivity.ts` `handleAiProductivityInstallCursorHook` 硬检查
3. `server/routes/ai-productivity.ts` hook command 拼装中的 `node ${path}`
4. `server/skill-sync.ts` `defaultMcpBinPath()` 用于 stop-check command

**根因**:这些函数都被单测覆盖,但**测试用例只验证"接口契约"**(传入参数 → 输出
结果),没有覆盖"默认值是否合理"。`existsSync(~/Downloads/...)` 在源仓库
测试机上可能存在(因为用户机器上有),迁移到新仓库后用户没装老工具,这些死路径
就一个一个炸出来。

**修复方法论(供后续大型迁移参考)**:

1. **grep 老路径关键字做一次 sweep**:`grep -rn "Downloads/ai-productivity-mcp\|truesight\|17280" packages/` —— 任何命中都要 case-by-case 评估保留还是清理
2. **写"全新机器端到端 e2e"**:模拟刚装完 npm 包的纯净环境跑完整流程,catch
   所有"假设用户机器上有 XX"的隐式依赖。本仓库后续可以加 vitest e2e:
   起一个 mkdtempSync 模拟 HOME → npm i → aipt install → aipt mcp → 解析 JSON-RPC
3. **rc 阶段就是用来 catch 这些坑的**:7 个 rc 看似多,实际是 OSS 发布前正常节奏;
   每次 deprecate 老版本 + CHANGELOG 透明记录,让后来者跳过坑

### 8. Cursor MCP 客户端的 stderr UI 显示约定

**现象**:cli 通过 `console.error('[ai-productivity-tracker] reusing daemon ...')` 输出
诊断日志,Cursor 端 MCP Output 面板里这些行被标 `[error]`,看着像"启动报错"。

**根因**:stdio MCP 协议规定:

- **stdout** 是 JSON-RPC 通道,只能有合法 JSON-RPC 帧
- **stderr** 可以任意输出,通常作为子进程的诊断日志

Cursor 把子进程 stderr 每行都标记成 `[error]` 是 UI 约定(不是真错误)。
Claude Code 等其它 IDE 不会这样标。

**处理**:`console.error` 写诊断日志是 stdio MCP server 标准做法,保留。
用户看到 `[error] running v1.0.0-rc.7` 不要慌,真正的错误会有
"Connection closed" / "JSON parse error" 等 MCP 级别报错伴随。

### 9. Cursor `stop` hook 在用户手动中断时**也会触发**,必须读 `status` 字段过滤

**现象**:用户在 Cursor 里按 ESC / Cancel 中断对话后,几秒内 Cursor 自动 submit
一条 `[ai-productivity 防伪造校验] ...` 文案当作新一轮 prompt,LLM 被迫重新答复,
完全违背中断意图,用户体验极差。

**根因**:不能假设"stop hook = 正常完成才触发"。两个 IDE 行为**截然不同**:

| IDE         | 用户中断时 stop hook 是否触发         | 行为依据                                  |
| ----------- | ------------------------------------- | ----------------------------------------- |
| Claude Code | **不触发**                            | 文档原文 "do not fire on user interrupts" |
| Cursor      | **会触发**,payload `status='aborted'` | 文档显式定义 `status` 三态                |

我们的 `runStopCheck()` 只看了 `loop_count` / `stop_hook_active`(死循环防御),
完全没读 Cursor payload 的 `status` 字段,中断/出错都走 sentinel 校验 → inject_followup
路径,Cursor 把 followup_message 当作下一轮 user prompt 自动 submit。

参考对照:`.claude/skills/evolution` skill 也有 Stop hook(`session-end.sh`),
但它装的是 Claude Code 端 → 用户 ESC 时根本不触发,**evolution 自身没做任何
过滤**,只是天然受益于 Claude Code 的设计。这就是为什么用户感觉"evolution 中断不会
打扰,我们的 stop-check 会打扰"。

**修复**(`packages/hook-core/src/stop-check.ts`):

```ts
function isAbortedStop(parsed: Record<string, unknown>, dialect: StopDialect): boolean {
  const status = typeof parsed.status === 'string' ? parsed.status : ''
  return status === 'aborted' || status === 'error'
}

// runStopCheck() 内 detectDialect() 之后立即:
if (isAbortedStop(parsed, dialect)) {
  return { kind: 'skipped_aborted', dialect, output: null }
}
```

放在最前面的好处:中断时连 git resolveTrackingContext / fetch ping / sentinel read
都不跑,零开销零副作用。

**方法论**:任何"借用 IDE hook 注入 followup"的设计都必须先调研 hook 在 IDE
**异常/中断/失败**路径下的行为,不能只盯着 happy path 写代码。同样的 hook 名,
不同 IDE 行为可能完全相反(Claude `Stop` vs Cursor `stop` 就是典型反例)。
新增 outcome 维度 `skipped_aborted`,与 `skipped_*` 系列对齐,便于事后日志统计
"被打扰的中断次数 → 应该为 0"。

---

## 未来路线图(v1.x)

- **v1.1**:Windows 完整支持(systemd-equivalent 守护脚本生成器)
- **v1.1**:看板「全局复盘报告」一键导出 Markdown / HTML
- **v1.2**:skill / rule 版本管理面板(diff / 回滚 / 自定义 fork)
- **v1.2**:多 dataRoot 切换(按"工作"/"个人"切档)
- **v1.3**:团队同步 — daemon 可选 push 经验到 git 仓库
- **v1.3**:VS Code Extension 替代手动注入 mcp.json

详见 [`PRD.md` §12](./PRD.md)。
