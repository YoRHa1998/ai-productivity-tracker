# Changelog

本文件记录 `@ai-productivity-tracker/cli` 独立项目的所有版本变更。
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/);格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 源项目 `instant-web-tools` 内 AI 提效面板模块的历史变更(v2.0 ~ v2.18.x)归档在
> `specs/modules/ai-productivity-tracker/change_log.md`,本仓库 v1.x 从那里继承全部行为契约。

---

## [Unreleased]

> 占位。下次有可发版改动后补充。

---

## [1.0.0-rc.3] - 2026-05-25

> 首个**实际可用**的 RC 版本。从 `instant-web-tools / web-tool-platform AI 提效面板`
> (v2.18.0)完整迁出成独立 npm 包,以 1:1 行为保留为约束。
>
> 之前 rc.1 / rc.2 因安装期 packaging bug 已 npm deprecate,**请直接用 rc.3+**。

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

### 发布产物指标(rc.3)

- npm tarball: **633 KB**(阈值 3 MB,PRD §V14 达标)
- unpacked dist: **2.6 MB**(阈值 5 MB,PRD §V14 达标)
- 运行时外部依赖: **0**(全部 esbuild bundle 内联)
- 文件清单:`dist/cli.mjs`(1.0 MB)+ `dist/web/`(SPA assets)+ `dist/version.json` + `package.json`(866 B 精简版)

---

## [1.0.0-rc.2] - 2026-05-25 — DEPRECATED ⚠️

> **npm deprecated**。修了 rc.1 的 `workspace:*` 协议问题,`npm install -g` 能装上,
> 但 cli 入口 main() 在 npm 全局 symlink 启动场景下不触发(`isDirectRun` 判断失效),
> 所有命令静默 exit 0,完全不可用。请直接用 [1.0.0-rc.3](#100-rc3---2026-05-25) 或更新。

deprecate 原因发布到 npm registry:

> "installs cleanly but cli entry never runs main() on symlinked bin. Please use 1.0.0-rc.3 or later."

---

## [1.0.0-rc.1] - 2026-05-25 — DEPRECATED ⚠️

> **npm deprecated**。`cli/package.json` `dependencies` 含 `workspace:*` 协议,
> 用户 `npm install -g @ai-productivity-tracker/cli@1.0.0-rc.1` 直接报
> `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"` 安装失败,完全装不上。
> 请直接用 [1.0.0-rc.3](#100-rc3---2026-05-25) 或更新。

deprecate 原因发布到 npm registry:

> "packaging bug: dependencies contain workspace:\* protocol, fails to install. Please use 1.0.0-rc.3 or later."

---

## 📚 发布工程经验(踩坑笔记)

本仓库首次走完"独立 npm 包"完整发布流程时遇到 4 个非显然的坑。记录在此供后续 release 或同类 OSS 项目参考。

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

---

## 未来路线图(v1.x)

- **v1.1**:Windows 完整支持(systemd-equivalent 守护脚本生成器)
- **v1.1**:看板「全局复盘报告」一键导出 Markdown / HTML
- **v1.2**:skill / rule 版本管理面板(diff / 回滚 / 自定义 fork)
- **v1.2**:多 dataRoot 切换(按"工作"/"个人"切档)
- **v1.3**:团队同步 — daemon 可选 push 经验到 git 仓库
- **v1.3**:VS Code Extension 替代手动注入 mcp.json

详见 [`PRD.md` §12](./PRD.md)。
