/**
 * AI 提效面板 v2.5.0:对话总结软数据采集 skill / cursor rule 内嵌模板。
 *
 * 这两份内容被「一键注入 Skill」按钮直接写到用户机器:
 * - Claude:  ~/.claude/skills/ai-productivity-track/SKILL.md
 * - Cursor:  ~/.cursor/rules/ai-productivity-track.mdc
 *
 * v2.4 设计原则:
 * - 极简提示词,不试图教 AI 解读触发条件,而是「每轮答复前都跑一次」
 * - 工具入参从单字符串升级为结构化对象(oneLine/type/changeScope/discussion)
 * - 完成态在答复末尾仅追加一行 `> 总结已上报 (#N)`,失败/跳过完全静默,不污染正文
 *
 * v2.5 新增:
 * - 每份模板硬编码 `source` 参数(Claude 模板传 `claude-code`、Cursor 模板传 `cursor`),
 *   Agent 端仅在 target iteration 缺少 source 时回填,不覆盖 Hook/Watcher 已写入的真值。
 *
 * v2.6.0 新增:
 * - Claude Code skill 是 LLM auto-invoke,触发率低于 Cursor 的强制注入 rule。
 *   配套在 ~/.claude/settings.json 注入 UserPromptSubmit Hook(marker
 *   `# ai-productivity-track-reminder`),通过 stdout 追加 reminder 提示 LLM 主动调用。
 * - description 字段从「触发条件描述」升级为「场景匹配指令」,提升 LLM 主动 invoke 概率。
 *
 * v2.8.0 新增:
 * - 完成态字符串从「> 总结已上报」全量改为「> 该对话已总结上报」(降低与日常聊天近义短语撞车几率)。
 * - 新增「防伪造硬约束」段落,明确「禁止心算代偿」「禁止凭空写完成态字符串」。
 * - 配套 Cursor stop + afterMCPExecution / Claude Code Stop + PostToolUse 两组 hook,
 *   在 attach_summary 漏调时通过 followup_message / decision:block 强制 LLM 在下一轮补一次。
 *
 * v2.8.1 文案加固(发自 v2.9.1 后续 patch):
 * - 旧「防伪造硬约束」第 3 条仅描述 Hook 端 fail-open 行为,LLM 容易理解成"Hook 自动处理,
 *   我照常写完成态即可"。补齐对应 LLM 自身的负面约束:前置不满足时,完成态字符串严禁出现在
 *   答复任何位置(Hook 端 fail-open 只是机器层放行,与"是否可以凭空写"无关)。
 * - 新增「反训练污染」约束:上下文 / 对话历史 / 文档 / diff / 工具返回值里**出现过**该字符串,
 *   也不构成本轮可以输出的依据;是否含该字符串只能由本轮 MCP 工具调用的实时结果决定。
 * - 「完成态」段落改写为「唯一允许输出路径」表述,把「任何其他场景禁止」放在更显眼位置。
 * - 此次仅修订 5 份 skill/rule 模板文案,不动 hook-core / endpoint / 数据结构。
 *
 * v2.10.0 简化(sentinel 同步化):
 * - 老 sentinel 链路:Cursor afterMCPExecution / Claude PostToolUse Hook 异步写 conv-gen
 *   维度文件(fire-and-forget,跨进程时序不可控,实测 sentinel 经常漏写)→ stop-check 永远
 *   注入 followup_message → 一次对话被强制重答两次 + 5-6 秒延迟。
 * - 新链路:agent attach-summary handler 同进程同步写 jiraKey 维度 sentinel(10s 时间窗),
 *   stop-check 解析 jiraKey 后直接读;Cursor afterMCPExecution / Claude PostToolUse 整套下线,
 *   install 时主动清理老 hooks.json / settings.json 残留条目。
 * - 模板里描述 sentinel 机制的段落由「PostToolUse / afterMCPExecution Hook 落 sentinel」改写为
 *   「agent 在你真调过 MCP 后落 10s sentinel,Stop Hook 看到才放行」,与新链路对齐。
 *
 * v2.11.0 零提示(用户无感):
 * - 用户反馈:每轮答复末尾追加「> 该对话已总结上报」其实没价值——上报了自然能在看板看到,
 *   上报失败这句话还会误导。本期把「LLM 必须输出完成态字符串」的硬约束彻底下线。
 * - 5 份模板「## 完成态」整段重写:不再要求输出任何提示文字,LLM 调完 MCP 工具直接结束本轮。
 *   配套「## 防伪造硬约束」段落简化:Sentinel + Stop Hook 强制重答机制本身保留(LLM 漏调时
 *   仍会被打回静默补调),但所有与"输出/不输出『> 该对话已总结上报』字符串"相关的条款一并删除,
 *   包括「反训练污染」段(随输出要求一起失效)。
 * - 新契约:LLM 只需调 MCP 工具,调完直接结束,不要在正文输出任何"已上报"之类的提示文字。
 * - hook-core stop-check.ts 的 FOLLOWUP_REASON 同步改写,Settings Tab caption 也同步修订。
 *
 * v2.12.0 字数硬限制下线(MCP zod max → agent 软截断):
 * - 用户反馈:Claude Code / Cursor 双 IDE 都会出现「第一次写超 → MCP `-32602 too_big` → 强制
 *   重试」的链式问题。Claude Code 表现为看板双 iteration(Stop Hook decision:block 把 reason
 *   注入为新一轮 user 行,watcher 按新 turn 再 flush 一条),Cursor 表现为同轮内 stop-check
 *   loop_count 二次跑 + LLM 内部重答,虽然只产一条 iteration 但白白多花 token + 卡顿。
 * - MCP zod schema 删 `.max(120/300)`,agent `resolveAttachSummary` 改 soft trim,落盘时
 *   `normalizeConversationSummary` 仍按 120/300 二次截断,数据完整性不变。
 * - 5 份模板文案对应改写:`oneLine: "<目标 ≤120 字(超出会被 agent 静默截断,不会失败)>"`
 *   类似措辞,让 LLM 明确"字数是建议不是硬限"并放心调用。
 *
 * v2.14.0 提升 Cursor attach_summary 主动调用率(用户反馈:每个提问被拆成 #N 漏调 + #N+1
 * stop-hook 补刀,主动率不到 50%):
 * - 根因 1(架构):Cursor 没有 UserPromptSubmit 等价 hook,长会话过半 alwaysApply rule
 *   在大上下文里沉底;Claude Code 用 UserPromptSubmit 每轮注入 reminder 是有效经验。
 * - 根因 2(文案):v2.13.0 rule 开头是 200+ 字连串否定句,3 条前置 LLM 在 prompt 上无法
 *   自我验证,模型保守倾向于"不调"。
 * - 根因 3(反馈):stop hook 兜底变相纵容漏调 — 漏调对 LLM 零成本,反而催生"等被打回
 *   再静默补一次"的偷懒路径。
 * - 改动:
 *   a) 新增 `CURSOR_SESSION_REMINDER_MARKER` / `CURSOR_SESSION_REMINDER_COMMAND` 常量,
 *      `aipt install` 把这条命令写到 `~/.cursor/hooks.json` 的 `hooks.sessionStart` 数组。
 *      命令在 shell 层用 `git -C "${CURSOR_PROJECT_DIR:-$PWD}" symbolic-ref` 探当前分支,
 *      命中 `[A-Z][A-Z0-9]+-\d+` → 输出 JSON `{"additional_context":"...本会话工作在 Jira
 *      分支 <KEY>...attach_summary 每轮必须调一次..."}`,Cursor 把 additional_context
 *      字符串拼到 conversation 的 initial system context;非 Jira 分支输出 `{}`,等价不注入,
 *      与 Claude `CLAUDE_TRACK_HOOK_REMINDER_COMMAND` 的 v2.13.0 设计完全对称。
 *   b) `CURSOR_TRACK_RULE_CONTENT` / `CLAUDE_TRACK_SKILL_CONTENT` 双方言同步重写:正向
 *      "## 触发(每轮必须)"段放最前,明确"看到 reminder = 前置已满足,不需要再自我验证";
 *      否定句压缩到末尾 `## 边界` 段 3 行内;**删除「防伪造硬约束 → sentinel + Stop Hook
 *      强制重答」整段**,让 LLM 心智里"无兜底",主动率自然提高。
 *   c) stop hook / sentinel / 90s 窗口全部保留作为安全网。预期 inject_followup 频率从
 *      ~50% 降到 <5%;若实测仍偏高,下一期再讨论是否拆 stop-check。
 *   d) HTTP 端点 / MCP tool / 文件 schema 全部冻结,仅动 prompt 文案与 hooks.json 安装逻辑。
 *
 * v2.13.0 收紧非 Jira 分支触发(用户反馈:在没有 Jira key 的分支也频繁触发,污染体验):
 * - 根因 1:Cursor rule frontmatter `alwaysApply: true`,**每轮系统 prompt 无条件注入**;且正文
 *   开篇就是「每轮**最终答复前**都触发,不区分是否改代码」+「**禁止凭'心里总结清楚了'就跳过**」
 *   这种**反向倒逼**句,LLM 偏向"先调一次再说",非 Jira 分支命中 daemon HTTP 400 留下工具
 *   面板红色失败。
 * - 根因 2:Claude `UserPromptSubmit` Hook 是无条件 `printf`,shell 层不判分支,reminder 100%
 *   注入对话上下文,Claude Code 同样会误调。
 * - 本期改动:
 *   a) `CURSOR_TRACK_RULE_CONTENT` / `CLAUDE_TRACK_SKILL_CONTENT` 整体重排:把「前置」改写为
 *      首段「## 强约束」,**非 Jira 分支严禁调用 + 严禁在答复中提及上报相关内容**;删/改"不
 *      区分是否改代码"" 禁止凭心里总结清楚就跳过 "等反向倒逼句,改成「**前置满足时**必须真
 *      调,**前置不满足时**严禁调用」双向对称表述。
 *   b) `CLAUDE_TRACK_HOOK_REMINDER_COMMAND` 从无条件 `printf` 改为 `bash -c` 包的条件 shell:
 *      先 `git symbolic-ref --short -q HEAD` 探当前分支,**不含 Jira key 时直接静默 0 输出**,
 *      Claude 端非 Jira 分支真正做到零污染。marker 保留外层确保 install 覆盖路径不变。
 *   c) MCP `ai_productivity_attach_summary` tool description 也补一句"仅当 cwd 分支含 Jira
 *      issue key 时调用",`tools/list` 阶段就有威慑(配套改在 packages/mcp/src/tools.ts)。
 *   d) daemon `handleAiProductivityAttachSummary` 的「无法推断当前追踪需求」从 HTTP 400 改为
 *      HTTP 200 `{ ok:true, skipped:true, reason:'no_jira_key' }`,即便 LLM 仍误调,工具面板
 *      也是绿色 skipped 而非红色 4xx(配套改在 packages/server/src/routes/ai-productivity.ts)。
 * - Cursor rule 仍保持 `alwaysApply: true`(用户 trade-off:Jira 分支触发率不变),靠 prompt
 *   文案 + Claude shell + MCP description + daemon 兜底 4 层防线把非 Jira 分支 noise 压到极低。
 */

export const TRACK_SKILL_VERSION = '2.14.0'

export const CLAUDE_TRACK_SKILL_FILENAME = 'SKILL.md'
export const CURSOR_TRACK_RULE_FILENAME = 'ai-productivity-track.mdc'

/**
 * v2.6.0 注入到 ~/.claude/settings.json hooks.UserPromptSubmit 的 reminder 文案.
 * 每次用户提示提交时由 Claude Code 通过 stdout 注入到对话上下文,主动 reminder LLM 调用
 * ai_productivity_attach_summary,不依赖 skill auto-invoke.前置不满足时 LLM 自动静默.
 *
 * 通过 marker `# ai-productivity-track-reminder` 在 settings.json 中识别同源 hook 条目,
 * 用于安装时覆盖旧版本而不重复追加.
 */
export const CLAUDE_TRACK_HOOK_REMINDER_MARKER = '# ai-productivity-track-reminder'
/**
 * v2.13.0 收紧:
 *   - 老版本是无条件 `printf`,无论当前分支是否含 Jira issue key,reminder 100% 注入 Claude
 *     对话上下文,导致非 Jira 分支同样有 ~150 token 上下文污染 + LLM 误调 attach_summary。
 *   - 新版本用 `bash -c` 包一段条件 shell:先用 `git symbolic-ref --short -q HEAD` 探当前
 *     分支(`CLAUDE_PROJECT_DIR` 兜底,否则 `$PWD`),正则匹配到 `[A-Z][A-Z0-9]+-\d+` 才 printf,
 *     否则直接静默退出,Claude 那侧非 Jira 分支零污染。
 *   - 任何 git 失败(非 git 仓库 / detached HEAD / git 不存在等)一律 fail-open(不输出),
 *     `|| true` 兜底保证 exit code 始终 0,不影响 Claude 主流程。
 *   - marker `# ai-productivity-track-reminder` 保留在 `bash -c '...'` 之外,确保
 *     `findTrackReminderEntry` 仍能命中老条目,`installAiTrackClaudeHook` 走覆盖路径而非追加。
 *   - 依赖:bash + git,macOS / Linux 默认都有,与本仓库 `process.execPath` + Hook 等其他模块
 *     的隐式依赖一致。
 */
export const CLAUDE_TRACK_HOOK_REMINDER_COMMAND =
  `bash -c 'b=$(git -C "\${CLAUDE_PROJECT_DIR:-$PWD}" symbolic-ref --short -q HEAD 2>/dev/null || true); ` +
  `[[ "$b" =~ [A-Z][A-Z0-9]+-[0-9]+ ]] && ` +
  `printf %s "即将开始本轮对话。当前 git 分支含 Jira issue key,请在最终答复前调用 ai_productivity_attach_summary MCP tool 上报本轮结构化总结(oneLine + type + changeScope/discussion,source=claude-code);daemon 不可达 / 需求未初始化 等其它前置不满足时,静默跳过本次调用,详见 ~/.claude/skills/ai-productivity-track/SKILL.md。" ` +
  `|| true' ` +
  CLAUDE_TRACK_HOOK_REMINDER_MARKER

/**
 * v2.14.0 Cursor `sessionStart` hook 命令的等价 reminder,注入到 `~/.cursor/hooks.json`
 * `hooks.sessionStart` 数组.
 *
 * 设计动机:
 *   - Claude Code 用 `UserPromptSubmit` Hook **每轮**给 LLM 注入一句 reminder,触发率显著
 *     高于纯 alwaysApply rule.Cursor 没有等价的 `UserPromptSubmit` hook,但 `sessionStart`
 *     支持 `additional_context` 字段把字符串拼到 conversation 的 initial system context,
 *     是 Cursor 端最接近的 reminder 注入位.缺点是**只在新会话创建时触发一次**,长会话
 *     过半后失效,但配合 alwaysApply rule 两者叠加足以把主动调用率拉到 ≥95%.
 *
 * 命令结构(与 `CLAUDE_TRACK_HOOK_REMINDER_COMMAND` 完全对称):
 *   - `bash -c '...'` 外层单引号包整段,内部 `\"` 在 bash 双引号 quoting 上下文里被解
 *     释为字面 `"`,可拼合法 JSON 字符串.
 *   - `git -C "${CURSOR_PROJECT_DIR:-$PWD}" symbolic-ref --short -q HEAD` 探当前分支;
 *     `CURSOR_PROJECT_DIR` 是 Cursor 给所有 hook 子进程统一注入的 workspace 根目录
 *     (与 Claude 的 `CLAUDE_PROJECT_DIR` 互为别名,见 Cursor hooks 文档 §Environment
 *     Variables),不依赖 stdin payload(sessionStart payload 里无 workspace_roots).
 *   - 命中正则 `[A-Z][A-Z0-9]+-[0-9]+` 时输出
 *     `{"additional_context":"[ai-productivity] 本会话工作在 Jira 分支 <KEY>..."}`,
 *     Cursor 把该字符串拼到 conversation 初始系统上下文.
 *   - 未命中(普通分支 / detached HEAD / 非 git 仓库 / git 不存在)输出 `{}`,等价不注入,
 *     **非 Jira 分支零污染**,与 v2.13.0 收紧策略一致.
 *   - `|| printf %s "{}"` 兜底:任何 bash / git 失败都返合法 JSON,不让 Cursor hook
 *     设置面板因 stdout 不可 JSON 解析而报错.
 *
 * marker `# ai-productivity-session-reminder` 保留在 `bash -c '...'` 之外,
 * `findCursorEntryByMarker` 仍能命中老条目,`installAiTrackCursorHook` 走覆盖路径而非追加.
 *
 * 依赖:bash + git,macOS / Linux 默认都有(与 `CLAUDE_TRACK_HOOK_REMINDER_COMMAND`
 * 一致).bash 3.2(macOS 系统默认版本)已支持 `BASH_REMATCH`,无需更高版本.
 */
export const CURSOR_SESSION_REMINDER_MARKER = '# ai-productivity-session-reminder'
export const CURSOR_SESSION_REMINDER_COMMAND =
  `bash -c 'b=$(git -C "\${CURSOR_PROJECT_DIR:-$PWD}" symbolic-ref --short -q HEAD 2>/dev/null || true); ` +
  `if [[ "$b" =~ [A-Z][A-Z0-9]+-[0-9]+ ]]; then ` +
  `k="\${BASH_REMATCH[0]}"; ` +
  `printf "%s" "{\\"additional_context\\":\\"[ai-productivity] 本会话工作在 Jira 分支 $k,ai_productivity_attach_summary MCP 在每轮最终答复前必须调用一次(source=cursor,oneLine + type + changeScope/discussion)。看到本条 reminder = 前置已满足,无需再自我验证 3 条前置;调完工具直接结束本轮,不要在答复中输出任何「已上报」之类的提示文字。\\"}"; ` +
  `else printf "%s" "{}"; ` +
  `fi || printf "%s" "{}"' ` +
  CURSOR_SESSION_REMINDER_MARKER

export const CLAUDE_TRACK_SKILL_CONTENT = `---
name: ai-productivity-track
description: 当用户在 git 仓库内进行对话,且当前 git 分支名匹配正则 [A-Z][A-Z0-9]+-\\d+(含 Jira issue key)时,在最终答复前调用本 skill 上报结构化对话总结。分支不含 Jira issue key 时本 skill 完全不适用,严禁触发。本 skill 内部静默处理前置不满足场景,LLM 无需自行判断是否调用。配套 ~/.claude/settings.json UserPromptSubmit Hook(v2.13.0 起在 shell 层做 branch 探测,非 Jira 分支不再注入 reminder)。
---

# ai-productivity-track (v${TRACK_SKILL_VERSION})

## 触发(每轮必须)

每轮用户提示一开始如果出现由 \`UserPromptSubmit\` Hook 注入的 \`即将开始本轮对话。当前 git 分支含 Jira issue key...\` reminder,说明 3 条前置(分支含 Jira key + daemon 可达 + 需求已 init)**已全部满足**,你**无需自己再去验证**。此时每轮**最终答复前**必须调用一次 \`ai_productivity_attach_summary\`,**不区分本轮是否改代码**(改动用 \`type\` 字段区分)。

漏调的代价:看板本轮 \`conversationSummary\` 永久为 null;hint 通道是软数据,daemon 不可能"凭空"补全本轮总结。

## 调用

\`\`\`
ai_productivity_attach_summary({
  oneLine:     "<一句话总结,目标 ≤120 字(超出 agent 会静默截断,不会失败)>",
  type:        "coding" | "communication",
  changeScope: "<改动范围简述,目标 ≤120 字(超出会被静默截断)>",   // type=coding 必填
  discussion:  "<讨论内容简述,目标 ≤300 字(超出会被静默截断)>",   // type=communication 必填
  source:      "claude-code"               // v2.5.0 固定值,标记来源
})
\`\`\`

\`type\` 判定:本轮使用 Write/Edit/StrReplace/EditNotebook/Delete,或执行了 \`git commit\` / \`pnpm install\` / \`pnpm build\` 等改写工作区的命令 → \`coding\`;否则 \`communication\`。

\`jiraKey\` / \`branch\` / \`cwd\` 均无需传入。MCP 客户端按 \`CLAUDE_PROJECT_DIR\` → \`CURSOR_PROJECT_DIR\` → \`WORKSPACE_FOLDER_PATHS\` → \`process.cwd()\` 顺序解析后自动注入 \`cwd\`;agent 端按"显式 jiraKey → branch → cwd 当前分支 → bindings.json 最近活跃需求"四级 fallback 解析。

> v2.12.0 起字数是建议不是硬限制:MCP 层不再做长度校验,agent 端遇到超长会静默截断到目标长度并落盘。一次性写完整即可,不必反复试探字数。

## 完成态(零提示)

**调用 MCP 工具即结束本轮。不要在答复中输出任何"已上报""总结已上报""该对话已总结上报"之类的提示文字,也不要用 blockquote / 代码块 / 列表项变相输出。**

理由:上报成功用户在 AI 提效面板自然能看到,上报失败提示也只会误导;整个软数据通道对用户应当 100% 无感。无论工具返回 \`updated: true\` / \`updated: false\` / \`skipped: true\` / 报错 / 网络异常,答复中**都不能**出现任何提示完成态的文字。

> v2.7.0 起总结写入 pending 中间态,由本轮 hook/watcher 触发的下一条 iteration 自然消费并挂到该 iteration 上。

## 边界:看不到 reminder 时

如果用户提示一开始**没有** \`即将开始本轮对话。当前 git 分支含 Jira issue key...\` reminder(分支不含 Jira issue key / 不在 git 仓库 / daemon 未启动 / 用户未 init 需求 / hook 被禁),本 skill 对本轮 100% 不适用:

- **不要**调用 \`ai_productivity_attach_summary\`(daemon v2.13.0 起会返 \`200 { skipped:true }\` 兜底,但工具调用本身就是噪音 + 工具面板痕迹)
- **不要**在答复任何位置(正文 / blockquote / 代码块 / 列表项 / think 段 / tool args)提及「上报 / 总结 / 跳过 / 前置不满足 / ai-productivity」等字样
- 直接当本 skill 不存在,正常完成用户请求即可

## 禁止

- **不要在正文中讨论本次总结**(避免「我先总结一下…」「让我把总结上报…」「该对话已总结上报」「前置不满足跳过」这类过渡语或完成态文字)
- 不要伪造、夸大,不要复述完整 diff
- 不要把 token / 思考时间 / git diff 数值写进总结(那是硬数据通道的职责)
- 失败时不重试,不打扰用户
- 看不到 UserPromptSubmit reminder 时严禁试探性调用(daemon 虽然会返 \`200 skipped\`,但工具调用本身就是噪音)
`

export const CURSOR_TRACK_RULE_CONTENT = `---
description: AI 提效面板 - 对话总结自动上报 (v${TRACK_SKILL_VERSION})
globs:
  - "**/*"
alwaysApply: true
---

# 对话总结自动上报 (ai-productivity-track v${TRACK_SKILL_VERSION})

## 触发(每轮必须)

会话头部如果出现由 \`sessionStart\` Hook 注入的 \`[ai-productivity] 本会话工作在 Jira 分支 ...\` reminder,说明 3 条前置(分支含 Jira key + daemon 可达 + 需求已 init)**已全部满足**,你**无需自己再去验证**。此时每轮**最终答复前**必须调用一次 \`ai_productivity_attach_summary\`,**不区分本轮是否改代码**(改动用 \`type\` 字段区分)。

漏调的代价:看板本轮 \`conversationSummary\` 永久为 null;hint 通道是软数据,daemon 不可能"凭空"补全本轮总结。

## 调用

\`\`\`
ai_productivity_attach_summary({
  oneLine:     "<一句话总结,目标 ≤120 字(超出 agent 会静默截断,不会失败)>",
  type:        "coding" | "communication",
  changeScope: "<改动范围简述,目标 ≤120 字(超出会被静默截断)>",   // coding 必填
  discussion:  "<讨论内容简述,目标 ≤300 字(超出会被静默截断)>",   // communication 必填
  source:      "cursor"                    // v2.5.0 固定值,标记来源
})
\`\`\`

\`type\` 判定:本轮修改了任何文件 / 执行了改写工作区的 shell 命令 → \`coding\`;否则 \`communication\`。

\`jiraKey\` / \`branch\` / \`cwd\` 均无需传入,agent 会基于 MCP 客户端自动注入的 \`cwd\` 解析当前活跃需求(v2.7.3 起 Cursor 下读取 \`WORKSPACE_FOLDER_PATHS\`)。

> v2.12.0 起字数是建议不是硬限制:MCP 层不再做长度校验,agent 端遇到超长会静默截断到目标长度并落盘。一次性写完整即可,不必反复试探字数。

## 完成态(零提示)

**调用 MCP 工具即结束本轮。不要在答复中输出任何"已上报""总结已上报""该对话已总结上报"之类的提示文字,也不要用 blockquote / 代码块 / 列表项变相输出。**

理由:上报成功用户在 AI 提效面板自然能看到,上报失败提示也只会误导;整个软数据通道对用户应当 100% 无感。无论工具返回 \`updated: true\` / \`updated: false\` / \`skipped: true\` / 报错 / 网络异常,答复中**都不能**出现任何提示完成态的文字。

> v2.7.0 起总结写入 pending 中间态,由本轮 Cursor afterAgentResponse hook 触发的新 iteration 自然消费。

## 边界:看不到 reminder 时

如果会话头部**没有** \`[ai-productivity] 本会话工作在 Jira 分支 ...\` reminder(分支不含 Jira issue key / 不在 git 仓库 / daemon 未启动 / 用户未 init 需求),本规则对本轮 100% 不适用:

- **不要**调用 \`ai_productivity_attach_summary\`(daemon v2.13.0 起会返 \`200 { skipped:true }\` 兜底,但工具调用本身就是噪音 + 工具面板痕迹)
- **不要**在答复任何位置(正文 / blockquote / 代码块 / 列表项 / think 段 / tool args)提及「上报 / 总结 / 跳过 / 前置不满足 / ai-productivity」等字样
- 直接当本规则不存在,正常完成用户请求即可

特别地,\`main\` / \`master\` / \`develop\` / \`bugfix-*\` / \`chore/*\` 等不含 Jira issue key 的分支,sessionStart Hook 输出空 JSON \`{}\`,Cursor 不会注入任何 reminder。

## 禁止

- 不要在正文中讨论总结过程(避免「我先总结一下…」「让我把总结上报…」「该对话已总结上报」「前置不满足跳过」这类过渡语或完成态文字)
- 不要伪造、夸大
- 不要复述完整 diff 或大量代码
- 不要把 token / 思考时间 / git diff 数值写进总结
- 看不到 sessionStart reminder 时严禁试探性调用(daemon 虽然会返 \`200 skipped\`,但工具调用本身就是噪音)
`

export interface TrackSkillTemplate {
  /** 文件最终落地后的绝对路径 */
  defaultPath: string
  /** 文件内容 */
  content: string
  /** 解析后的文件大小,用于 UI 展示 */
  size: number
}

/* ─────────────────────────────────────────────────────────────────────
 * v2.16.0 P0 经验沉淀(lessons-extract)skill 模板
 *
 * 该 skill 触发频率低(每个需求结束时手动一次),不需要每轮强制触发,
 * 因此 SKILL.md / CURSOR_RULE.md 与 ai-productivity-track 完全解耦,
 * 只复用「一键注入 Skill」按钮把它一并写到用户机器:
 *   - Claude:  ~/.claude/skills/lessons-extract/SKILL.md
 *   - Cursor:  ~/.cursor/rules/lessons-extract.mdc
 *
 * 不动 TRACK_SKILL_VERSION / 既有 track 模板字符串。
 * ────────────────────────────────────────────────────────────────────*/

export const LESSONS_EXTRACT_SKILL_VERSION = '1.2.0'

export const LESSONS_EXTRACT_SKILL_KEY = 'lessons-extract'
export const LESSONS_EXTRACT_CLAUDE_FILENAME = 'SKILL.md'
export const LESSONS_EXTRACT_CURSOR_FILENAME = 'lessons-extract.mdc'

export const LESSONS_EXTRACT_CLAUDE_CONTENT = `---
name: lessons-extract
description: 经验提取 / 经验沉淀 / 复盘提取。当用户在「.ai-productivity-tracker/data」对应需求目录下或在含 Jira issue key 分支(正则 [A-Z][A-Z0-9]+-\\d+)的 git 仓库中,明确说出关键词「经验提取」「提取经验」「复盘经验」「沉淀经验」时,**必须**触发本 skill。skill 会拉取该需求的全部历史对话与 iteration 数据,在价值判定后推理出多维度可复用经验(踩的坑 / 沉淀的规则 / 最佳实践 / 对话拆分建议 / 工具改进),按 scope=通用/项目专属 落盘到本机统一经验库,看板「复盘经验」Tab 自动可见。无价值时静默走空数组路径,禁止凑数。
---

# lessons-extract (v${LESSONS_EXTRACT_SKILL_VERSION})

## 触发关键词

用户在对话中出现以下关键词之一时,主动触发本 skill:

- \`经验提取\`
- \`提取经验\`
- \`复盘经验\`
- \`沉淀经验\`
- \`lessons extract\`

## 前置(任一不满足 → 询问用户后停止,不静默吞)

1. 本地 daemon \`http://127.0.0.1:17350\` 可达
2. 能解析出当前需求 jiraKey,按以下优先级:
   - 当前 git 分支名匹配 \`[A-Z][A-Z0-9]+-\\d+\`
   - 当前 cwd 在 \`~/.ai-productivity-tracker/data/<JIRA-KEY>/\` 下,目录名命中正则
   - 用户在指令中显式指定(如「经验提取 INSTANT-5321」)
   以上都失败 → 提示用户在分支 / 目录下重试,或显式指定 jiraKey
3. 该 jiraKey 已通过 \`ai_productivity_init\` 创建过需求

## 执行流程

### Step 1:拉取历史数据包

\`\`\`
ai_productivity_extract_bundle({ jiraKey: "<解析出的 jiraKey>" })
\`\`\`

工具返回值在 \`BUNDLE_JSON_BEGIN\` 之前有一段「**=== 客观信号 ===**」可读摘要,后面跟 JSON 数据包。解析 JSON 后包含:

- \`requirement\`:需求元数据
- \`currentProjectSlug\`(v1.1.0):当前需求所属项目标识(=package.json name)。Step 2 给 \`scope='project'\` 经验填 \`projectSlug\` 时直接用此值
- \`iterations[]\`:全部对话轮次
- \`existingLessons[]\`:已落盘的经验(已被 agent 过滤为「通用 + 当前项目」),**必须**用来去重
- \`computedSignals\`(**v1.2.0 新增**):整需求维度的客观信号摘要,包含 \`boost / linkedBugCount / cumulativeEffectiveTokens / cumulativeThinkSeconds / fileChurnMap / abnormalStopReasons / topThinkSeqs\`,用于 Step 2.2.5 优先扫"难点 / churn / 异常"

### Step 2:LLM 推理多维度经验

#### 2.1 价值判定 checklist(v1.1.0 新增,先做这步)

完整扫一遍 bundle + computedSignals 后,**先**问自己以下 5 个问题。若全部为否,直接进入 Step 3 的「空数组路径」,**禁止凑数**:

1. 是否有「同一类坑反复 bugfix / fileChurnMap 中某文件触碰 ≥3 轮 / abnormalStopReasons 命中 max_tokens」→ **pitfall**?
2. 用户是否明确说过「以后必须 ...」/「这条要记住」→ **rule**?
3. 是否有「boost ≥ 5x / topThinkSeqs 对应轮次一气呵成 / changeScope 干净不漂移」→ **best-practice**?
4. 是否有「单轮跨多个无关模块 / 相邻轮 changeScope 高度相似」 → **split-suggestion**?
5. 是否踩过 watcher / sentinel / hook / 上游 API 端点废弃 → **tooling**?

#### 2.2 按维度推理(判定有价值后执行)

| type | 描述 | 关键信号 |
|---|---|---|
| \`pitfall\` | 踩的坑 | 反复 bugfix / 同款问题在多轮反复出现 / 高 churn 文件 |
| \`rule\` | 沉淀的规则 | 用户明确说「以后必须...」/ 多轮反复重申的硬约束 |
| \`best-practice\` | 最佳实践 | 高 boost / changeScope 干净 / 一气呵成的复杂改动 |
| \`split-suggestion\` | 对话拆分 / 合并建议 | 单轮跨多个无关模块 → 拆;相邻轮 changeScope 相似 → 合 |
| \`tooling\` | 工具 / skill / hook 改进 | watcher 漏抓 / sentinel 误判 / 上游 API 端点废弃 |

#### 2.2.5 客观信号扫描(v1.2.0 新增)

bundle 的 \`computedSignals\` 字段是 agent 端基于全需求 iterations 自动算出的硬数据。**先扫一遍再推理**,可以让 lesson 锚定客观证据,大幅减少"凭印象写"的偏差:

- \`topThinkSeqs\`(top 3 思考时长轮次):AI 在这几轮"想得最久",大概率是难点 / 决策点 / 卡壳点。**优先扫这几轮的 \`changeScope\` + \`discussion\`** 提取 lesson
- \`fileChurnMap\`(被触碰轮数 ≥ 2 的文件 top 5):同一文件被反复改是 pitfall 候选信号(反复推翻 / 设计不稳),lesson 的 \`affectedFiles\` 直接引用
- \`abnormalStopReasons\`(\`max_tokens\` / \`pause_turn\` / \`tool_use\` 等):AI 被"打断"的轮次,通常是任务过大或对话过长,可作 split-suggestion 信号
- \`boost\` / \`linkedBugCount\`:反映本需求的价值密度;**不要把数值写进 lesson \`content\`**(那是看板硬数据,agent 端会自动写到 \`trustReasons\`)

**硬约束**:lesson \`content\` 是知识陈述,不能出现 \`"本需求 boost=8.2x"\` / \`"消耗 234k token"\` / \`"思考 7 分钟"\` 之类临时性数值。把这些信号用于**判定 lesson 是否值得沉淀** + **指引扫描方向**,而不是塞进文本。

#### 2.3 scope 标注规则(v1.1.0 新增,每条必填)

- \`scope: 'general'\` = 通用知识(语言陷阱 / 外部 API 通用约束 / 跨项目可复用),\`projectSlug\` 留空
- \`scope: 'project'\` (默认) = 引用本项目模块 / 架构 / 命名 / 特有约束,\`projectSlug\` **必填** = Step 1 返回的 \`currentProjectSlug\`
- 判定不清时保守归 \`project\`,避免污染通用库

#### 2.4 字段约束

- \`title\`:短标题(≤80 字),独立可读,**禁止**引用 jiraKey 内部上下文
- \`content\`:主体(≤500 字),事实陈述,不带 emoji,**不写客观信号数值**
- \`rootCause\`(pitfall 强烈建议)、\`fix\`、\`reusableWhen\`、\`tags[]\`、\`affectedFiles[]\`、\`iterationSeqs[]\` 按维度补全
- \`scope\` + \`projectSlug\` 按 2.3 规则填
- 对 \`existingLessons[]\` 已有内容,**禁止**重复落盘语义相近的 lesson(v2.18.0 起 agent 会按 type+scope+tags+title 相似度自动合并到老条目并累加 hitCount,即使 LLM 漏识别)

### Step 3:批量落盘

\`\`\`
ai_productivity_save_lessons({
  jiraKey: "<解析出的 jiraKey>",
  source: "claude-code",
  lessons: [
    { type: "pitfall", scope: "general", title: "...", ... },
    { type: "rule", scope: "project", projectSlug: "<currentProjectSlug>", ... },
    /* 典型 1~5 条多维度经验 */
  ]
})
\`\`\`

#### 空数组路径(v1.1.0)

若 Step 2.1 价值判定结果为「无可沉淀经验」,**务必**走:

\`\`\`
ai_productivity_save_lessons({
  jiraKey: "<解析出的 jiraKey>",
  source: "claude-code",
  lessons: []
})
\`\`\`

agent 返回「本轮未沉淀新经验」,把这句话原样转述给用户。

如果 \`rejected[]\` 非空,把原因转述给用户,并按提示补全后重试。

### Step 4:回报结果

- 本次抽取了 N 条经验(按 type / scope 分类计数)或「本轮未沉淀新经验」
- 看板入口:\`http://127.0.0.1:5173/modules/ai-productivity-tracker/lessons\`(或本地 web 端口)
- 已合并 / 覆盖了 M 条同 id 老经验(如果有)

## 设计原则

- **价值优先**:宁可 0 条不沉淀,也不要 5 条流水账;空数组路径是 v1.1.0 的一等公民
- **可独立复用**:每条 lesson 必须脱离本需求上下文也能被人看懂
- **多维度并存**:不要只盯着 pitfall;rule / best-practice / split-suggestion 同等重要
- **通用 / 项目专属正确分类**:不确定时保守归 project,避免污染通用库
- **零云端 LLM**:本 skill 完全靠 IDE 内 LLM 推理,agent 不调任何外部 API
- **可重提取**:用户可多次触发,带 id 的 lesson 视为覆盖式更新

## 禁止

- 不要把 token / 思考时间 / boost / linkedBugCount / git diff 数值直接写进 lesson \`content\`(那是看板硬数据,agent 端会自动注入 \`trustReasons\`)
- 不要在 lesson 标题里写「本次」「这次」「INSTANT-XXXX 修复的 ...」之类临时性表达
- 不要复述完整 diff
- 不要伪造从未在 bundle 中出现过的事实
- 不要把 lesson 写成 git commit message;lesson 是知识沉淀,不是变更记录
- **不要为了凑数沉淀冗余经验**:无价值时直接 \`lessons:[]\` 走空路径
`

export const LESSONS_EXTRACT_CURSOR_CONTENT = `---
description: AI 提效面板 - 经验提取 (lessons-extract v${LESSONS_EXTRACT_SKILL_VERSION})
globs:
  - "**/*"
alwaysApply: false
---

# 经验提取 (lessons-extract v${LESSONS_EXTRACT_SKILL_VERSION})

> alwaysApply: false:本规则只在用户出现「经验提取 / 提取经验 / 复盘经验 / 沉淀经验」等关键词时触发,不强制每轮注入。

## 触发关键词

- \`经验提取\`
- \`提取经验\`
- \`复盘经验\`
- \`沉淀经验\`
- \`lessons extract\`

## 前置

1. 本地 daemon \`http://127.0.0.1:17350\` 可达
2. 解析当前需求 jiraKey,顺序:
   - 当前 git 分支名匹配 \`[A-Z][A-Z0-9]+-\\d+\`
   - 当前 cwd 在 \`~/.ai-productivity-tracker/data/<JIRA-KEY>/\` 下
   - 用户显式给出
3. 该 jiraKey 已通过 \`ai_productivity_init\` 创建过需求

## Step 1:拉取数据包

\`\`\`
ai_productivity_extract_bundle({ jiraKey: "<解析出的 jiraKey>" })
\`\`\`

返回 \`BUNDLE_JSON_BEGIN\` 之前有「**=== 客观信号 ===**」可读摘要,后面跟 JSON,字段:
- \`requirement\`:需求元数据
- \`currentProjectSlug\`(v1.1.0):当前需求所属项目标识(=package.json name);scope='project' 经验直接填此值到 \`projectSlug\`
- \`iterations[]\`:全部对话轮次
- \`existingLessons[]\`:已落盘的经验(agent 已过滤为「通用 + 当前项目」),用于去重
- \`computedSignals\`(**v1.2.0 新增**):整需求维度的客观信号摘要(\`boost / linkedBugCount / cumulativeEffectiveTokens / cumulativeThinkSeconds / fileChurnMap / abnormalStopReasons / topThinkSeqs\`),用于 Step 2.2.5 指引扫描方向

## Step 2:价值判定 + 多维度推理

### 2.1 价值判定 checklist(v1.1.0 关键新增)

完整扫一遍 bundle + computedSignals 后,先判定是否值得沉淀。**5 个问题全部为否 → 直接走 Step 3 空数组路径,禁止凑数**:

1. 是否有「同一类坑反复 bugfix / fileChurnMap 某文件 ≥3 轮 / abnormalStopReasons 命中 max_tokens」→ **pitfall**?
2. 用户是否说过「以后必须 ...」→ **rule**?
3. 是否有「boost ≥ 5x / topThinkSeqs 对应轮次一气呵成」→ **best-practice**?
4. 是否有「单轮跨多模块 / 相邻轮相似」→ **split-suggestion**?
5. 是否踩过 watcher / sentinel / hook / 上游 API 坑 → **tooling**?

### 2.2 按维度推理

5 种 type:\`pitfall\` / \`rule\` / \`best-practice\` / \`split-suggestion\` / \`tooling\`。

### 2.2.5 客观信号扫描(v1.2.0 新增)

\`computedSignals\` 是 agent 自动算的硬数据,先扫一遍再推理,锚定客观证据:

- \`topThinkSeqs\`:AI 想得最久的 3 轮,优先扫这部分的 \`changeScope\` + \`discussion\` 提取 lesson(大概率是难点)
- \`fileChurnMap\`:被触碰 ≥2 轮的文件 top 5,反复改是 pitfall 候选;lesson \`affectedFiles\` 直接引用
- \`abnormalStopReasons\`:\`max_tokens\` 等非正常结束的轮次,可作 split-suggestion 信号
- \`boost\` / \`linkedBugCount\`:**不要写进 lesson \`content\`**(agent 端 \`trustReasons\` 自动注入)

### 2.3 scope 标注(v1.1.0 新增,每条必填)

- \`scope: 'general'\`:通用知识(语言陷阱 / 外部 API 通用约束),\`projectSlug\` 留空
- \`scope: 'project'\`(默认):引用本项目模块 / 架构 / 命名,\`projectSlug\` **必填** = Step 1 返回的 \`currentProjectSlug\`
- 判定不清时保守归 \`project\`

### 2.4 字段要求

\`title\`(≤80,独立可读) / \`content\`(≤500,事实陈述,**不写客观信号数值**) / \`rootCause?\` / \`fix?\` / \`reusableWhen?\` / \`tags[]?\` / \`affectedFiles[]?\` / \`iterationSeqs[]?\` / \`scope\`(必填) / \`projectSlug\`(scope=project 必填)。

对 \`existingLessons[]\` 中语义重合度高的内容,**禁止**重复落盘(v2.18.0 起 agent 会按 type+scope+tags+title 相似度自动合并并累加 hitCount,即使 LLM 漏识别)。

## Step 3:批量落盘

\`\`\`
ai_productivity_save_lessons({
  jiraKey: "<解析出的 jiraKey>",
  source: "cursor",
  lessons: [
    { type: "pitfall", scope: "general", ... },
    { type: "rule", scope: "project", projectSlug: "<currentProjectSlug>", ... },
    /* 典型 1~5 条 */
  ]
})
\`\`\`

### 空数组路径(v1.1.0)

无可沉淀经验时直接:

\`\`\`
ai_productivity_save_lessons({
  jiraKey: "<解析出的 jiraKey>",
  source: "cursor",
  lessons: []
})
\`\`\`

agent 返回「本轮未沉淀新经验」,原样转述给用户。

如果 \`rejected[]\` 非空,把原因如实告诉用户,补全后重试。

## Step 4:回报

简要告诉用户:抽取了 N 条经验(按 type / scope 分类计数)或「本轮未沉淀新经验」;看板入口 \`http://127.0.0.1:5173/modules/ai-productivity-tracker/lessons\`,有 M 条覆盖式更新。

## 禁止

- 不要把 token / 思考时间 / diff 数值写进 lesson
- 不要在标题里写「本次 / 这次 / INSTANT-XXXX」之类临时性表达
- 不要伪造未在 bundle 中出现的事实
- 不要复述完整 diff
- 不要写成 git commit message
- **不要凑数**:无价值时直接 \`lessons:[]\`,比硬抽更值钱
`
