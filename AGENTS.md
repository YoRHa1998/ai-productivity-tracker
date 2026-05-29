# AGENTS — AI 开发上下文交接

> **给接手本仓库的 AI 助手看**(Cursor / Claude Code / Codex 等 IDE 工具会优先加载本文件作为
> 系统级上下文)。5 分钟读完即可上手开发,人类开发者也可作为 onboarding 入口。
>
> 文件位置:仓库根目录 `AGENTS.md`(社区约定)。
> 最后更新:**2026-05-25**(`@ai-productivity-tracker/cli@1.0.0-rc.8` 已 publish)。

---

## 0. TL;DR(30 秒读完)

- 项目名:`@ai-productivity-tracker/cli`,**独立 npm 包**,GitHub 仓库 YoRHa1998`/ai-productivity-tracker`
- 能力:跨 IDE(Cursor / Claude Code / 任意 MCP 客户端)采集 AI 编码会话数据,按 Jira 需求维度可视化提效
- 当前状态:**rc.8 已 publish 到 npm,端到端可用**(rc.1-rc.6 已全部 deprecate;rc.7 / rc.8 仍可用,rc 链上发布工程坑全部入档 `docs/CHANGELOG.md`)
- 由来:从 `instant-web-tools` 平台模块迁出,代码 1:1 行为继承自该仓库 v2.18.0
- 包结构:pnpm monorepo,7 个子包(core / hook-core / mcp / server / ui / cli + 不发布的 ui)
- 默认端口:17350;数据根:`~/.ai-productivity-tracker/data/`

**进入开发前必读 3 份文档**(按优先级):

1. `[docs/PRD.md](./docs/PRD.md)` — 完整设计:为什么这么搭、各 phase 拆分、14 个验收用例、18 条风险矩阵
2. `[docs/CHANGELOG.md](./docs/CHANGELOG.md)` — 8+ 条发布工程经验 + rc.1→rc.6 deprecation 链 + rc.7/rc.8 release notes
3. `[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)` — 进程拓扑 / 状态机 / sentinel 时序

---

## 1. 项目背景(为什么会有这个仓库?)

### 1.1 工具本身做什么

在任意业务仓库内,把 IDE(Cursor / Claude Code 等任意 MCP 客户端)与 AI 模型的对话过程,
按 **Jira 需求**(`feature/INSTANT-1234-xxx` 分支识别)收集成结构化指标:

- **需求级**:提效倍数(boost) / 关联 Bug 数 / token 成本 / 累计思考时长 / numstat diff
- **每轮对话**:一句话总结 / 改动范围 / 讨论摘要 / 思考时长 / 触发 stop_reason
- **跨需求**:可复用的复盘经验(lessons-learned),按 type / scope 二级分类自动合并

数据全部落用户本机 `~/.ai-productivity-tracker/data/`,不上云,不联网。
浏览器看板默认 `http://127.0.0.1:17350` 实时展示。

### 1.2 这是个迁移项目,不是从零做

源代码完全继承自 `[instant-web-tools](../../truesight/instant-web-tools)` 仓库的
`AI 提效面板`模块(spec 版本 v2.18.0):

| 来源                                                                                       | 现位置                                          |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `apps/local-agent-service/src/services/ai-productivity/`                                   | `packages/core/src/`                            |
| `apps/local-agent-service/src/routes/ai-productivity.ts`                                   | `packages/server/src/routes/ai-productivity.ts` |
| `apps/local-agent-service/src/services/skill-sync.ts`                                      | `packages/server/src/skill-sync.ts`             |
| `packages/ai-productivity-hook-core/`                                                      | `packages/hook-core/`                           |
| `packages/ai-productivity-mcp/`                                                            | `packages/mcp/`                                 |
| `apps/web/src/modules/ai-productivity-tracker/`                                            | `packages/ui/`                                  |
| `skills/{ai-productivity-init,ai-productivity-track,lessons-extract,clarify-requirement}/` | `skills/`                                       |

**1:1 行为契约**:5 个 MCP tool 名/入参/出参、30+ HTTP 端点、文件 schema、Hook 协议、
sentinel 时间窗、transcript-watcher 解析、boost 公式、经验沉淀闭环——**字面保留**,
迁移过程不改任何业务行为。

### 1.3 迁移动机

老 `web-tool-platform AI 提效面板`架构问题:

- 必须装 `truesight-agent` 后台服务(macOS launchd plist)+ 手动 curl 下载 `~/Downloads/ai-productivity-mcp.mjs`
- 看板必须从 web-tool-platform 域名访问(跨域 fetch + CORS preflight)
- IDE MCP 配置要手填 4 个 env(TRUESIGHT_AGENT_URL / TOKEN 等)
- 端口、数据根目录、品牌名都带 `truesight` 前缀,无法对外发布

新独立架构:

- 一个 npm 包 `@ai-productivity-tracker/cli`(全局 install 即可)
- daemon + stdio MCP + Hook + 看板 SPA 全部 esbuild bundle 成单个 `dist/cli.mjs`(1MB / gzip 300KB)
- 看板由 daemon 同源托管,浏览器直连 `127.0.0.1:17350`
- 零环境变量配置(token 通过 `~/.ai-productivity-tracker/runtime.json` 协调)

---

## 2. 当前状态(截至 2026-05-25)

### 2.1 已交付

- ✅ Phase 0-5 全部完成(详见 `docs/PRD.md` §7 实施计划)
- ✅ npm 包 `@ai-productivity-tracker/cli` 已发到 npm registry,**rc.8 是当前可用最新版**
- ✅ rc.1 ~ rc.6 因不同 packaging / 启动期 bug 全部 `npm deprecate`(详 `docs/CHANGELOG.md`)
- ✅ rc.7 解决 mcp 进程立退;rc.8 修复 daemon 同源 GET 无 Origin 头时的 panel 路由放行(Referer / Sec-Fetch-Site 兜底)
- ✅ 9 条发布工程经验 + 18 条风险矩阵入档(参见 `docs/CHANGELOG.md` 末尾段 + `docs/PRD.md` §9)
- ✅ 612 例自动化测试,41 spec 文件覆盖 6 子包 + daemon e2e
- ✅ 端到端 dogfood 跑通:本机 npm i -g 安装 + aipt install + Cursor 实际连上 MCP

### 2.2 git 历史关键节点

```
da9436d 【Release】@ai-productivity-tracker/cli v1.0.0-rc.8   ← 最新
e35d009 【Fix】daemon 同源 GET 无 Origin 头时通过 Referer / Sec-Fetch-Site 兜底放行 panel 路由
9bb48f9 【Docs】更新 CHANGELOG / PRD:rc.4-rc.7 全部 deprecation 链 + 8 条经验
d5e0912 【Release】@ai-productivity-tracker/cli v1.0.0-rc.7   ✅ 端到端可用
... (rc.1 ~ rc.6 全部 npm deprecated)
26b0009 【Feature】项目初始化                                  ← Phase 0
a269cae Initial commit
```

完整 commit 链可 `git log --oneline` 查看。

### 2.3 npm 包已发布版本

```
@ai-productivity-tracker/cli@1.0.0-rc.1 ⚠️ deprecated (workspace:* 协议)
@ai-productivity-tracker/cli@1.0.0-rc.2 ⚠️ deprecated (cli main 不启动)
@ai-productivity-tracker/cli@1.0.0-rc.3 ⚠️ deprecated (~/Downloads 死代码)
@ai-productivity-tracker/cli@1.0.0-rc.4 ⚠️ deprecated (GUI PATH 不含 nvm node)
@ai-productivity-tracker/cli@1.0.0-rc.5 ⚠️ deprecated (skill-sync 死代码)
@ai-productivity-tracker/cli@1.0.0-rc.6 ⚠️ deprecated (mcp 进程立退)
@ai-productivity-tracker/cli@1.0.0-rc.7 ✅ 端到端可用
@ai-productivity-tracker/cli@1.0.0-rc.8 ✅ 当前可用(latest tag)
```

### 2.4 用户机器现状

- 已通过 `npm install -g @ai-productivity-tracker/cli@1.0.0-rc.8` 全局安装
- 老 `truesight-agent` 已完整卸载(launchd plist / 二进制 / `~/.truesight-local-agent/`)
- 用户 npm 账号:`yorha1998`(独立账号,token 在 `.npmrc.publish` 项目级配置,gitignore)
- npm scope `@ai-productivity-tracker` org 已注册(Free plan,public packages)
- 已开 2FA(Security Key 方式)+ Granular Access Token (Bypass 2FA enabled)

---

## 3. 架构对比:旧版 vs 新版

```
旧版 (instant-web-tools 内 AI 提效面板模块)
┌─────────────────────────────────────────────────────────┐
│ IDE ──stdio──▶ ~/Downloads/ai-productivity-mcp.mjs     │
│  (用户手动下载)            │                              │
│                            ▼ HTTP+Bearer (4 个 env)     │
│ Web 平台 ──fetch http://127.0.0.1:17280──▶ truesight-agent
│  (跨域 + CORS)              │ launchd plist 守护        │
│                              ▼                          │
│  ~/.truesight-local-agent/  (~17280 端口固定)            │
└─────────────────────────────────────────────────────────┘

新版 (@ai-productivity-tracker/cli)
┌─────────────────────────────────────────────────────────┐
│ IDE ──stdio──▶ aipt mcp ──spawn-detached──▶ aipt daemon │
│                          (单实例锁,自动起)  127.0.0.1:17350
│                                                ▼        │
│ 浏览器 ──同源 fetch──▶ daemon:                          │
│                       ├─ 静态 SPA (/)                   │
│                       ├─ JSON API (/ai-productivity/*)  │
│                       └─ transcript-watcher             │
│                                                ▼        │
│  ~/.ai-productivity-tracker/                            │
│  ├─ runtime.json (pid/port/token,自动生成)             │
│  └─ data/                                              │
└─────────────────────────────────────────────────────────┘

关键变化:
- truesight-agent (独立守护进程) → daemon (cli 内嵌,detached spawn)
- mcp.mjs 手动下载 → cli npm 全局 bin 软链
- launchd plist → 进程内事件循环 keep-alive
- web-tool-platform 跨域 → 同源 127.0.0.1:17350
- 4 个 TRUESIGHT_* env → 0 env(runtime.json 协调)
- ~/.truesight-local-agent/ → ~/.ai-productivity-tracker/
```

详细架构图见 `[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)`。

---

## 4. 仓库代码结构

```
ai-productivity-tracker/                  # pnpm workspace 根
├── AGENTS.md                              # 本文件(AI onboarding 入口)
├── README.md                              # 用户视角 quickstart
├── docs/
│   ├── PRD.md                             # 完整设计文档(必读)
│   ├── CHANGELOG.md                       # 版本历史 + 8 条发布工程经验
│   ├── ARCHITECTURE.md                    # 详细架构 / 时序图 / 状态机
│   ├── HOOK-PROTOCOL.md                   # Cursor / Claude hook 双方言协议
│   └── DATA-MODEL.md                      # 14 个本地文件 schema 详细字段
│
├── packages/
│   ├── cli/                              # @ai-productivity-tracker/cli (publish 主体)
│   │   ├── src/
│   │   │   ├── index.ts                  # argv-router 主入口(13 子命令)
│   │   │   ├── commands/                 # mcp / daemon / hook / install / migrate / doctor 等
│   │   │   └── lib/                      # paths / runtime-lock / ensure-daemon 等工具
│   │   ├── build.mjs                     # esbuild 单文件 bundle
│   │   └── .npmignore                    # 排除 src / *.map
│   ├── core/                             # 数据 store + watcher + metrics(从源仓库 1:1 迁)
│   ├── hook-core/                        # Cursor / Claude hook 入口逻辑
│   ├── mcp/                              # stdio MCP bridge(5 个 tool)
│   ├── server/                           # HTTP daemon(30+ /ai-productivity/* 端点)
│   └── ui/                               # Vue 3 SPA 看板(vite build → cli/dist/web/)
│
├── skills/                                # 4 个 skill 模板(随 cli 包发布)
│   ├── ai-productivity-init/
│   ├── ai-productivity-track/
│   ├── lessons-extract/
│   └── clarify-requirement/
│
├── scripts/
│   └── release.mjs                       # 发版自动化脚本
│
├── .npmrc.publish                        # 项目级 npm 登录态(gitignored,prod publish 用)
└── package.json                          # workspace 根
```

### 子包依赖关系

```
@ai-productivity-tracker/cli ─┬─▶ core
                              ├─▶ hook-core
                              ├─▶ mcp ─▶ core, hook-core
                              └─▶ server ─▶ core, hook-core

(esbuild bundle 时把上面 5 个 workspace 包全部内联到 cli/dist/cli.mjs)
ui 单独 vite build → 产物落到 cli/dist/web/(daemon 静态托管)
```

---

## 5. 开发常用命令

```bash
# 一次性环境就绪
pnpm install                                       # 装全部 workspace 依赖

# 日常开发
pnpm typecheck                                     # 全包 tsc 检查
pnpm test                                          # 全包 vitest(当前 590 例)
pnpm lint                                          # ESLint 9 flat config
pnpm format                                        # Prettier 3 自动格式化
pnpm format:check                                  # 仅检查不写

# 单个子包
pnpm --filter @ai-productivity-tracker/core typecheck
pnpm --filter @ai-productivity-tracker/cli build       # 链式 ui vite + cli esbuild

# 调试 cli(不需要 build)
node --loader tsx packages/cli/src/index.ts version
node --loader tsx packages/cli/src/index.ts doctor
node --loader tsx packages/cli/src/index.ts daemon     # 前台跑 daemon

# 跑 cli 产物(需要先 build)
node packages/cli/dist/cli.mjs version
node packages/cli/dist/cli.mjs daemon

# 发版(详 §6)
pnpm release prerelease           # → 1.0.0-rc.N+1 dry-run
pnpm release prerelease --publish # → 真发
pnpm release 1.0.0 --publish      # → 显式版本
```

---

## 6. 发布流程

详见 `[docs/CHANGELOG.md](./docs/CHANGELOG.md)` 末尾「发布工程经验」段(共 9 条经验)。
3 个高频要点:

### 6.1 npm 账号隔离(.npmrc.publish)

仓库根的 `.npmrc.publish`(已 gitignore)含项目专用 GAT token,
release.mjs 自动通过 `--userconfig=.npmrc.publish --registry=https://registry.npmjs.org/`
注入,**完全不动开发者全局 ~/.npmrc**。

如果该文件丢失或 token 过期,重新跑:

```bash
npm login --userconfig=./.npmrc.publish --auth-type=web --scope=@ai-productivity-tracker
```

或登 npmjs.com 重新生成 GAT 写到该文件。

### 6.2 dry-run 是真"只读"

`pnpm release prerelease`(无 `--publish`)默认 dry-run,**完全不动 git / package.json**:

- 临时 bump version 跑 build + 体积校验 + npm publish --dry-run
- finally 块恢复 package.json 到原版本号
- 多次跑 dry-run 不会留垃圾 commit/tag

只有加 `--publish` 才真发 + commit + tag。

### 6.3 体积校验自动门禁

release.mjs 跑 `npm pack --dry-run --json` 解析 size,**> 3MB 拒绝发版**(PRD §V14 验收阈值)。
当前 rc.8 tarball ~640KB / unpacked ~2.6MB(每次 release 自动校验)。

---

## 7. 8 条发布工程经验(摘要,全文见 CHANGELOG)

发布过程中每个 rc 暴露不同维度的非显然问题。**新 AI 接手时务必先扫一遍这 8 条**,
后续任何"为什么这里要这样写"的疑问 90% 答案都在里面:

| #   | 经验摘要                                                                   | 影响 commit                                         |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | pnpm script 把 `~/.npmrc` 注入 `npm_config_*` env,覆盖 `--userconfig` 文件 | release.mjs 必须显式 `--registry=...` 碾压 env      |
| 2   | `workspace:*` 协议不能进 publish 的 `dependencies`                         | release.mjs `withPublishableManifest()`             |
| 3   | ESM `isDirectRun` 在 npm bin symlink 启动场景失效                          | cli.mjs 直接调 main(),env 守卫给单测                |
| 4   | npm 2FA + GAT bypass 2FA 是 OSS 最佳实践                                   | `.npmrc.publish` 项目级 token                       |
| 5   | **macOS GUI 应用启子进程时 PATH 只有 `/usr/bin:/bin`**,nvm node 不在       | 所有 IDE 配置命令必须用 `process.execPath` 绝对路径 |
| 6   | **stdio MCP server 启动后必须 hang event loop**(`server.connect()` 不阻塞) | runMcp 末尾 `return new Promise<number>(() => {})`  |
| 7   | **大型项目迁移时的"死代码 fallback"陷阱**(实测命中 4 处 `~/Downloads/...`) | grep sweep + 全新机器 e2e + rc deprecate 三层防御   |
| 8   | Cursor stderr UI 显示约定:每行标 `[error]` 是约定不是错                    | 日志理解,不需修代码                                 |

---

## 8. 未完成的事项 / 路线图

### 8.1 v1.0 GA 前(短期 TODO)

- 用 rc.8+ 在日常工作中真用一周(dogfood),无 P0 故障再发 1.0.0 正式版
- **撤销 `~/.cursor/rules/lessons-extract.mdc` 的写入**(目前 install 会装,但实际触发率不高,待评估保留与否)
- `git push origin main && git push --tags` 把 30+ 本地 commits + 7 个 tag 推到 GitHub(目前 main 领先 origin 多个 commit)
- 真实写一份 GitHub README badges + 截图(看板 UI 截图等)
- 评估 `npm uninstall` 用户体验(目前流程已有但未文档化)

### 8.2 v1.x 路线(已写入 CHANGELOG.md 末尾)

- v1.1: Windows 完整支持(systemd-equivalent 守护脚本)
- v1.1: 看板「全局复盘报告」一键导出 Markdown / HTML
- v1.2: skill / rule 版本管理面板(diff / 回滚 / 自定义 fork)
- v1.2: 多 dataRoot 切换(按"工作"/"个人"切档)
- v1.3: 团队同步 — daemon 可选 push 经验到 git 仓库
- v1.3: VS Code Extension 替代手动注入 mcp.json

---

## 9. 沟通与协作约定

### 9.1 给后续 AI 的硬约束

- **始终使用中文回复**(用户偏好,源自 instant-web-tools AGENTS.md 继承)
- **不要主动 commit**:除非用户明确说"提交",AI 不应主动跑 `git commit`(只在用户授权后)
- **不要主动 push**:更不应 push 远端
- **拆 commit**:大改动按"单一职责"拆多个 commit,commit message 用 `【tag】中文` 风格(如 `【Feature】xxx` / `【Fix】xxx` / `【Docs】xxx` / `【Chore】xxx` / `【Release】xxx`)
- **commit message 用 HEREDOC**:多行内容用 `git commit -m "$(cat <<'EOF' ... EOF)"`
- **不要乱删用户其它工具的配置**:精细操作 `~/.cursor/mcp.json` 等配置文件,只动 `ai-productivity-tracker` 相关 key,绝不破坏其它 MCP server 条目
- **改动后必跑回归**:`pnpm test && pnpm lint && pnpm format:check && pnpm typecheck`

### 9.2 不需要做 Doc-Check

源仓库 `instant-web-tools` 内 `AGENTS.md` / `CLAUDE.md` 强制 doc-check 闭环。
**本仓库不继承这个约定** —— 本仓库是独立 npm 包,文档更新走标准 git commit + CHANGELOG 流程,
不需要 `Doc-Check: done/skipped` 模板。

### 9.3 与源仓库 instant-web-tools 的关系

- 行为契约 1:1 继承 v2.18.0,**对外协议字面冻结**(MCP tool / HTTP 端点 / 文件 schema)
- 源仓库不再迭代 AI 提效面板,新需求只在本仓库实现
- 源仓库的相关代码后续会被删除(本仓库 GA 后单独立项),目前用户机器装的是本独立版

---

## 10. FAQ(给后续 AI 的提示)

### Q1: 用户问"我现在能用了吗?"

A: 已经能用。rc.8 已在用户机器全局安装,daemon 跑 17350 端口,看板可访问。
让用户跑 `aipt doctor` 验证 9 项体检,或浏览器开 `http://127.0.0.1:17350` 看看板。

### Q2: 用户报"MCP 红色 / 启动失败"

A: 先看 `docs/CHANGELOG.md` rc.1-rc.6 deprecation 章节 + 9 条经验段,90% 概率是历史遗坑复现。
如果是新坑,按下面流程诊断:

1. `aipt doctor`(必跑,9 项体检)
2. `lsof -ti :17350` 看 daemon 是否在跑
3. 模拟 IDE 启 MCP:`/path/to/node /path/to/aipt mcp < /dev/null`,看 stderr
4. 看 Cursor "Show Output" 里的 MCP 客户端日志

### Q3: 用户问"如何加新功能"

A: 改对应 packages/ 子包 → `pnpm test` → `pnpm --filter cli build` 本地验证 →
满意再 `pnpm release prerelease --publish` 发新 rc → 用户 `npm i -g @latest` 升级。

### Q4: 用户说"看板缺 XX 字段"

A: 看板 SPA 在 `packages/ui/src/`,改完 `pnpm --filter ui build` 输出到 `packages/cli/dist/web/`。
**daemon 静态服务自动 serve 新产物**,刷新浏览器即可(不需重启 daemon)。

### Q5: 用户问"为什么版本号跳到 rc.8?"

A: 真实迁移过程中暴露的发布工程问题。详 `docs/CHANGELOG.md`,每个 deprecate 的 rc 都有
说明 + 修复 commit。rc.7 起端到端可用,rc.8 修复同源 panel 路由 fallback,以后小修都
继续叠 rc 直到无 P0 故障再切 1.0.0 GA。这是 OSS 新包发布的正常节奏,不是质量问题。

### Q6: 用户在源仓库 `instant-web-tools` 里问相关问题

A: 那是另一个仓库,本仓库代码已独立。源仓库相关代码即将删除(等本仓库 GA)。
如果用户在两个仓库间切换,需要明确他在问哪边。

### Q7: skill/rule 文件在哪修改?

A: 真实模板源在 `packages/core/src/track-skill-templates.ts`(字符串常量,
`CLAUDE_TRACK_SKILL_CONTENT` / `CURSOR_TRACK_RULE_CONTENT` 等),不是 `skills/` 目录里的 .md。
后者只是文档展示用,实际 `aipt install` 写盘内容来自前者。

---

## 附录:从这里开始你的第一步

1. 先 `git log --oneline -15` 看 commit 历史,理解最近改了什么
2. `pnpm test` 跑一遍确认现状(当前基线 612/612 全绿)
3. `aipt doctor` 看用户机器状态
4. 读 `[docs/PRD.md](./docs/PRD.md)` §0 TL;DR + §3 目标架构
5. 用户提需求 → 评估对应改动 packages/ 哪个子包 → 动手

**如果用户的需求超出本仓库范围**(例如改 instant-web-tools 老平台的代码),
明确告知"那是源仓库,本仓库已独立",让用户切到对应 cwd。
