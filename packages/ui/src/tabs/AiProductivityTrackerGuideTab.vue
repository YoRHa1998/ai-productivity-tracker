<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import '../styles/aip-shared.css'

/**
 * 使用说明 Tab(@ai-productivity-tracker/cli 独立 npm 包 · v1.0+)
 *
 * 主路径:`npm i -g @ai-productivity-tracker/cli` → `aipt install` → 重启 IDE。
 * 看板由 daemon 同源托管在 http://127.0.0.1:17350,本页面所有引用都对齐当前架构。
 */

const dashboardOrigin = computed(() =>
  typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:17350'
)

const installCommand = 'npm install -g @ai-productivity-tracker/cli'
const aiptInstallCommand = 'aipt install'
const aiptDoctorCommand = 'aipt doctor'
const aiptDaemonCommand = 'aipt daemon'
const aiptUiCommand = 'aipt ui open'

const branchSample = 'git checkout -b feature/INSTANT-1234-add-oauth'
const aiPromptSample =
  '帮我开始这个需求,jira 链接:https://yourorg.atlassian.net/browse/INSTANT-1234'

const dataInspectSample =
  'ls ~/.ai-productivity-tracker/data/\n# 应该能看到 index.json / formula.json / jira.json 以及对应的 <JIRA-KEY>/ 目录'
const iterationInspectSample =
  'tail -f ~/.ai-productivity-tracker/data/INSTANT-1234/iterations.jsonl'
const requirementInspectSample =
  'cat ~/.ai-productivity-tracker/data/INSTANT-1234/requirement.json | jq .title,.status,.startedAt'
const bindingsInspectSample = 'cat <repo>/.ai-productivity/bindings.json | jq'

const daemonStatusCurl = computed(() => `curl -s ${dashboardOrigin.value}/status | jq`)
const summaryCurl = computed(() => `curl -s ${dashboardOrigin.value}/ai-productivity/summary | jq`)
const watcherCurl = computed(
  () => `curl -s ${dashboardOrigin.value}/ai-productivity/watcher-status | jq`
)

const lessonsTriggerSample = '经验提取 当前需求 INSTANT-1234'

function copy(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => ElMessage.success('已复制'))
  }
}
</script>

<template>
  <section class="aip-guide">
    <!-- Hero(渐变大标题 + 副标题) -->
    <header class="aip-guide__hero aipt-glass aipt-glass--accent">
      <div class="aip-guide__hero-glow"></div>
      <div class="aip-guide__hero-icon aipt-aurora-bg">
        <i class="i-lucide-rocket"></i>
      </div>
      <div class="aip-guide__hero-info">
        <span class="aip-guide__hero-badge aipt-chip-v2 aipt-chip-v2--accent">本地优先</span>
        <h1 class="aip-guide__hero-title aipt-aurora-text">使用说明</h1>
        <p class="aip-guide__hero-sub">
          npm 全局安装 <code class="aip-inline-code">@ai-productivity-tracker/cli</code> 后,
          <code class="aip-inline-code">aipt mcp</code> 自动拉起 daemon。数据全部落
          <code class="aip-inline-code">~/.ai-productivity-tracker/data/</code>,看板由 daemon 同源
          托管在 <code class="aip-inline-code">{{ dashboardOrigin }}</code
          >,不依赖任何远端 API。
        </p>
      </div>
    </header>

    <!-- 接入 3 步 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="m4 7 6-4 6 4 4 2v6l-4 2-6 4-6-4-4-2V9l4-2Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          MCP / Hook / Skill 一键接入(推荐)
        </h3>
        <span class="aip-chip aip-chip--success">主路径</span>
      </header>
      <p class="aip-card__caption">
        通过 npm 全局安装 + `aipt install` 一键完成,适用于 Cursor 与 Claude
        Code。后续每个新需求只需在 IDE 内跟 AI 自然语言对话即可。
      </p>

      <ol class="aip-flow">
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 1 · 全局安装 CLI</h4>
            <pre class="aip-code aip-code--dark" @click="copy(installCommand)">{{
              installCommand
            }}</pre>
            <p>
              安装一个独立 npm 包 <code class="aip-inline-code">@ai-productivity-tracker/cli</code>,
              产物 <code class="aip-inline-code">dist/cli.mjs</code> 同时承担 MCP server / Hook /
              daemon / 看板托管多个角色,默认提供 <code class="aip-inline-code">aipt</code> 与
              <code class="aip-inline-code">ai-productivity-tracker</code> 两个等价命令。
            </p>
            <p class="aip-guide__tip">
              要求本机已装 Node ≥ 20.10。如果是 nvm / volta / fnm 管理的 Node,跑
              <code class="aip-inline-code">aipt install</code> 时会自动用 cli 当前 node 的绝对路径
              (<code class="aip-inline-code">process.execPath</code>)拼装 hooks 命令,避免 IDE GUI
              子进程因 PATH 缺失启动失败。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 2 · 一键注入 IDE 配置</h4>
            <pre class="aip-code" @click="copy(aiptInstallCommand)">{{ aiptInstallCommand }}</pre>
            <p>这条命令一次性完成 3 件事(全部幂等,可多次重复执行):</p>
            <ul>
              <li>
                <strong>Cursor + Claude Code MCP server</strong> —— 把
                <code class="aip-inline-code">ai-productivity-tracker</code> 同时写入
                <code class="aip-inline-code">~/.cursor/mcp.json</code> 与
                <code class="aip-inline-code">~/.claude.json</code>
                顶层的
                <code class="aip-inline-code">mcpServers</code> 段(Claude entry 会附带
                <code class="aip-inline-code">type: 'stdio'</code> 字段),命令统一为
                <code class="aip-inline-code">node &lt;cli.mjs&gt; mcp</code>(绝对路径,不破坏其他
                MCP 条目,也不会污染 Claude Code 自身的 numStartups / theme / projects 等字段)。
              </li>
              <li>
                <strong>Cursor afterAgentResponse + stop hook</strong> —— 写入
                <code class="aip-inline-code">~/.cursor/hooks.json</code>,Cursor 每次回答后自动累计
                token,stop hook 还会防伪造校验对话总结。
              </li>
              <li>
                <strong>Claude Skill / Cursor Rule</strong> —— 同步落盘
                <code class="aip-inline-code">~/.claude/skills/ai-productivity-track/SKILL.md</code>
                与 <code class="aip-inline-code">~/.cursor/rules/ai-productivity-track.mdc</code>,
                AI 在每轮回答前自动调
                <code class="aip-inline-code">ai_productivity_attach_summary</code> 回填一句话总结。
                同时注入「经验提取」skill(<code class="aip-inline-code">lessons-extract</code>),
                后续在 IDE 内说「经验提取」即可触发当前需求的多维度复盘。
              </li>
            </ul>
            <p class="aip-guide__tip">
              命令执行时会自动启动 daemon(若未运行),并打印
              <code class="aip-inline-code">{{ dashboardOrigin }}</code
              >。打开该地址即是当前看板。
            </p>
            <p class="aip-guide__tip">
              不想注入 Claude / Cursor 全部?用
              <code class="aip-inline-code">aipt install --ide=cursor</code> 或
              <code class="aip-inline-code">--ide=claude</code> 精准选择;排查 Hook 是否真触发可加
              <code class="aip-inline-code">--debug</code> 以注入调试前缀。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 3 · 重启 IDE 让 MCP / Hook / Skill 生效</h4>
            <p>
              <strong>完全退出</strong> 一次 Cursor / Claude Code(<code class="aip-inline-code"
                >Cmd + Q</code
              >,不只是关窗),重新打开。IDE 启动时会从
              <code class="aip-inline-code">mcp.json</code> 启
              <code class="aip-inline-code">aipt mcp</code> 子进程作为 stdio MCP server;该子进程会
              <code class="aip-inline-code">ensureDaemon()</code> 检测 / 拉起单例 daemon。
            </p>
            <p class="aip-guide__tip">
              想验证 daemon 是否正常工作,跑
              <code class="aip-inline-code">{{ aiptDoctorCommand }}</code> 看体检报告(Node 版本 /
              home 目录 / 用户配置 / runtime.json + daemon /status / data 根 / cursor mcp.json /
              claude.json / hooks.json / skill / rule),逐项 ✓/⚠/✗ 三态彩色输出。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 4 · 切到含 Jira issue key 的分支,跟 AI 自然语言开启需求</h4>
            <pre class="aip-code" @click="copy(branchSample)">{{ branchSample }}</pre>
            <p>
              分支名需要包含形如 <code class="aip-inline-code">INSTANT-1234</code> 的 issue key,否则
              MCP / Hook / Watcher 会静默跳过(不污染指标)。
            </p>
            <p>然后跟 AI 说一句:</p>
            <pre class="aip-code" @click="copy(aiPromptSample)">{{ aiPromptSample }}</pre>
            <p>
              AI 会调用 <code class="aip-inline-code">ai_productivity_init</code> MCP tool,daemon
              立即在本机创建需求文件夹
              <code class="aip-inline-code">~/.ai-productivity-tracker/data/&lt;JIRA-KEY&gt;/</code
              >,并把当前分支绑定到该 jiraKey。后续每一轮对话:
            </p>
            <ul>
              <li>
                Cursor 通过 <code class="aip-inline-code">afterAgentResponse</code> hook 调
                <code class="aip-inline-code">aipt hook</code> 子进程 → POST 给 daemon → 追加
                <code class="aip-inline-code">iterations.jsonl</code> 一行。
              </li>
              <li>
                Claude Code 由 daemon 内置
                <code class="aip-inline-code">TranscriptWatcher</code> 监听
                <code class="aip-inline-code">~/.claude/projects/**/*.jsonl</code> 文件增量 →
                路由到对应 jiraKey → 同样追加 iteration。
              </li>
              <li>
                AI 在每轮答复前调用 MCP tool
                <code class="aip-inline-code">ai_productivity_attach_summary</code>,把一句话总结 +
                改动范围回填到当前 iteration。
              </li>
            </ul>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 5(可选)· 经验提取:把踩坑沉淀成可复用 lesson</h4>
            <p>需求结束或里程碑节点,在 IDE 内直接对 AI 说一句包含触发词的话:</p>
            <pre class="aip-code" @click="copy(lessonsTriggerSample)">{{
              lessonsTriggerSample
            }}</pre>
            <p>
              AI 会按 <code class="aip-inline-code">~/.cursor/rules/lessons-extract.mdc</code>
              中的协议拉取当前需求的全部 iteration / 客观信号,推理出多维度可复用经验 (踩的坑 /
              沉淀的规则 / 最佳实践 / 拆分建议 / 工具改进),自动按 scope 落盘到
              <code class="aip-inline-code">~/.ai-productivity-tracker/data/lessons/INDEX.json</code
              >, 在本看板「复盘经验」Tab 即时可见。
            </p>
            <p class="aip-guide__tip">
              老需求无价值时 AI 会走空数组路径(不凑数),看板返回「本轮未沉淀新经验」是正常预期。
            </p>
          </div>
        </li>
      </ol>
    </article>

    <!-- 常用 MCP 工具 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M14.7 6.3a4 4 0 1 0 3 3l5 5-3 3-5-5a4 4 0 0 0-3-3l3-3Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          常用 MCP 工具(IDE 内 AI 自动调用)
        </h3>
      </header>
      <ul class="aip-guide__bullet-list">
        <li>
          <code class="aip-inline-code">ai_productivity_init</code> —— 基于 Jira URL / 裸 issue key
          创建需求并绑定当前分支;接受 <code class="aip-inline-code">jira</code>、<code
            class="aip-inline-code"
            >title</code
          >、<code class="aip-inline-code">projectRoot</code>、<code class="aip-inline-code"
            >summary</code
          >、<code class="aip-inline-code">manualEstimateMinutes</code>、<code
            class="aip-inline-code"
            >complexity</code
          >
          等参数。
        </li>
        <li>
          <code class="aip-inline-code">ai_productivity_status</code> ——
          查询当前分支的绑定状态、累计 token、对应 jiraKey。
        </li>
        <li>
          <code class="aip-inline-code">ai_productivity_attach_summary</code> ——
          每轮答复前自动注入,把一句话总结 / 改动范围 / 讨论内容回填到当前 iteration。
        </li>
        <li>
          <code class="aip-inline-code">ai_productivity_extract_bundle</code> +
          <code class="aip-inline-code">ai_productivity_save_lessons</code> —— 经验提取链路 2 个 MCP
          tool;由 lessons-extract skill 自动编排,LLM 无需手工记忆调用顺序。
        </li>
      </ul>
      <p class="aip-guide__tip">
        AI 在开始新对话时若识别到分支含 issue key 但 daemon 返回「未绑定」,会主动建议跑一次 init。
      </p>
    </article>

    <!-- 自动采集 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" />
              <path
                d="M12 7v5l3 2"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          Token / 耗时自动采集
        </h3>
        <span class="aip-chip aip-chip--success">自动采集</span>
      </header>
      <p class="aip-card__caption">
        Cursor 端 / Claude Code 端都由 daemon 直接写本机文件,无需任何额外服务:
      </p>
      <ul class="aip-guide__bullet-list">
        <li>
          <strong>Cursor</strong>:<code class="aip-inline-code">~/.cursor/hooks.json</code>
          的 afterAgentResponse 在每次回答后执行
          <code class="aip-inline-code">node &lt;cli.mjs&gt; hook</code>(同一份 cli.mjs 在
          <code class="aip-inline-code">argv[2]==='hook'</code> 时跳过 MCP loop,直接跑 hook-core 的
          runHook),把 token usage POST 给 daemon。
        </li>
        <li>
          <strong>Claude Code</strong>:daemon 进程内置
          <code class="aip-inline-code">TranscriptWatcher</code> 监听
          <code class="aip-inline-code">~/.claude/projects/**/*.jsonl</code>,每条 assistant 消息按
          cwd → git root → branch → Jira Key 路由,命中已绑定需求时即 <strong>直接写</strong>
          <code class="aip-inline-code"
            >~/.ai-productivity-tracker/data/&lt;KEY&gt;/iterations.jsonl</code
          >。
        </li>
        <li>
          Token 计量 =
          <code class="aip-inline-code">input + output + cache_creation + cache_read</code
          >(与官方计费一致);daemon 重启不会重复计数(<code class="aip-inline-code"
            >~/.ai-productivity-tracker/data/transcript-state.json</code
          >
          与 <code class="aip-inline-code">hook-dedupe.json</code> 持久化)。
        </li>
        <li>
          未绑定分支(含 issue key 但还没 init)的 token 会被攒到
          <code class="aip-inline-code">pending[ISSUE-KEY]</code>,init 时自动合并;不含 issue key
          的分支静默跳过,不污染指标。
        </li>
        <li>
          切分支 / 多 worktree → 下次 watcher / hook 触发即从
          <code class="aip-inline-code">bindings.json</code> 恢复上下文,无需重新绑定。
        </li>
      </ul>
    </article>

    <!-- 端到端验证 -->
    <article class="aip-card aip-card--accent">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="m9 12 2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          端到端冒烟测试
        </h3>
        <span class="aip-chip aip-chip--success">5 步</span>
      </header>
      <p class="aip-card__caption">
        按下面 5 步走一遍,确认整条链(cli → daemon → IDE)完全通畅。任何一步异常都说明这条链没接好。
      </p>

      <ol class="aip-flow">
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 1 · 看板侧自检</h4>
            <ul>
              <li>
                打开浏览器
                <code class="aip-inline-code">{{ dashboardOrigin }}</code> —— 本看板能正常显示就说明
                daemon 已在线。
              </li>
              <li>
                切到本工具「业务配置」/「MCP 配置」Tab:顶部「本地 Agent」卡片应显示绿色
                <strong>在线 · vX.Y.Z</strong>,并显示存储目录
                <code class="aip-inline-code">~/.ai-productivity-tracker/data</code>。
              </li>
              <li>
                「MCP 配置」Tab「Cursor 自动追踪」绿色「已注入」表示 hook 已就绪; 「AI 对话总结
                Skill」绿色「已注入」表示 skill / rule 已落盘; 「Claude Code
                自动追踪」绿色「运行中」表示 transcript-watcher 已启动 (Claude Code
                至少跑过一次会话后追踪文件数才会 &gt; 0)。
              </li>
            </ul>
            <p>命令行核对 daemon:</p>
            <pre class="aip-code aip-code--dark" @click="copy(aiptDoctorCommand)">{{
              aiptDoctorCommand
            }}</pre>
            <pre class="aip-code aip-code--dark" @click="copy(daemonStatusCurl)">{{
              daemonStatusCurl
            }}</pre>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 2 · 跑一次 MCP init,看板列表立即出现需求</h4>
            <p>
              在 IDE 中,切到形如 <code class="aip-inline-code">feature/DEMO-1-smoke</code> 的分支,跟
              AI 说:
            </p>
            <pre class="aip-code" @click="copy(aiPromptSample)">{{ aiPromptSample }}</pre>
            <p>AI 调用 <code class="aip-inline-code">ai_productivity_init</code> 后:</p>
            <ul>
              <li>
                Workspace Tab 列表应立刻出现 <code class="aip-inline-code">DEMO-1</code> 的需求行
              </li>
              <li>
                本机文件系统应该新增
                <code class="aip-inline-code"
                  >~/.ai-productivity-tracker/data/DEMO-1/requirement.json</code
                >
              </li>
              <li>
                对应 git 仓库下应该多了
                <code class="aip-inline-code">.ai-productivity/bindings.json</code>,里面
                <code class="aip-inline-code">DEMO-1.branch</code> 指向当前分支
              </li>
            </ul>
            <p>命令行直接核对:</p>
            <pre class="aip-code aip-code--dark" @click="copy(dataInspectSample)">{{
              dataInspectSample
            }}</pre>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 3 · 自动累加验证</h4>
            <p>
              在同一分支跟 AI 多聊几轮代码改动(任何会
              <code class="aip-inline-code">Write</code>/<code class="aip-inline-code"
                >StrReplace</code
              >
              的对话都可以)。每一轮回答结束的几秒内:
            </p>
            <ul>
              <li>
                Cursor → hook 调 daemon
                <code class="aip-inline-code">POST /ai-productivity/hook</code> → 写
                bindings.cumulativeToken + 追加
                <code class="aip-inline-code">iterations.jsonl</code> 一行
              </li>
              <li>
                Claude Code → daemon 内置 watcher 监听到 jsonl 增量 → 写 bindings.cumulativeToken +
                追加 <code class="aip-inline-code">iterations.jsonl</code> 一行
              </li>
              <li>
                看板 Workspace 列表「累计 Token /
                对话次数」实时增长(<strong>无需刷新</strong>:抽屉详情时间线会出现新 iteration 卡片)
              </li>
            </ul>
            <p>命令行旁观写入:</p>
            <pre class="aip-code aip-code--dark" @click="copy(iterationInspectSample)">{{
              iterationInspectSample
            }}</pre>
            <p class="aip-guide__tip">
              手动核对 bindings:<code class="aip-inline-code">{{ bindingsInspectSample }}</code
              >;<code class="aip-inline-code">cumulativeToken</code> 应该单调递增。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 4 · 看板交互验证</h4>
            <ul>
              <li>
                Workspace 列表点开抽屉:Iteration 时间线应该显示完整的 init + 多条 coding
                记录,每条带模型 chip / 本轮思考时间 / 改动文件折叠 chips
              </li>
              <li>
                若已注入「对话总结 Skill」,每条非 init iteration 卡片下方应该出现「AI
                对话总结」段落;还没注入或前置不满足时显示「本轮无 AI 对话总结」灰色占位
              </li>
              <li>
                抽屉右上「刷新 Bug 数」按钮 → 若「业务配置」已配置 Jira 凭证,daemon 会直接调 Jira
                REST 把 <code class="aip-inline-code">linkedBugCount</code> 与
                <code class="aip-inline-code">bugsRefreshedAt</code> 写回 requirement.json
              </li>
              <li>
                「业务配置」Tab 调整公式系数并保存 → 提效倍数会用新公式重新计算(本身不需要刷新)
              </li>
              <li>在 IDE 内说「经验提取 当前需求 DEMO-1」 → 看板「复盘经验」Tab 出现新条目</li>
            </ul>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 5 · daemon 重启 + 数据持久性</h4>
            <p>(可选)验证数据完全落在本机:</p>
            <ol class="aip-guide__nested">
              <li>
                找到 daemon pid:
                <code class="aip-inline-code"
                  >cat ~/.ai-productivity-tracker/runtime.json | jq .pid</code
                >
              </li>
              <li>
                优雅关停:<code class="aip-inline-code">kill -TERM &lt;pid&gt;</code>
                (daemon 监听 SIGTERM,自动清 runtime.json)
              </li>
              <li>看板刷新:本地 daemon 卡应该显示「离线」;Workspace 列表为空且报错(预期行为)</li>
              <li>
                让 IDE 重新触发一次对话 → <code class="aip-inline-code">aipt mcp</code> 子进程会
                <code class="aip-inline-code">ensureDaemon()</code> 自动 spawn-detached 拉起 daemon
                (也可手动 <code class="aip-inline-code">{{ aiptDaemonCommand }}</code> 前台启动)
              </li>
              <li>看板刷新:DEMO-1 应该立刻回来,iteration 计数与重启前完全一致</li>
              <li>
                清理:抽屉「状态」改成「已放弃」即可让该测试需求从默认筛选里消失;或者直接
                <code class="aip-inline-code">rm -rf ~/.ai-productivity-tracker/data/DEMO-1</code>
              </li>
            </ol>
            <p class="aip-guide__tip">
              同样可以验证「数据不出本机」:断网情况下整个流程(MCP / hook / watcher /
              看板抽屉)都应该照常工作。
            </p>
          </div>
        </li>
      </ol>
    </article>

    <!-- 排错 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 9v4M12 17h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          排错
        </h3>
        <span class="aip-chip aip-chip--warning">FAQ</span>
      </header>
      <ul class="aip-guide__bullet-list aip-guide__bullet-list--troubleshoot">
        <li>
          看板「本地 Agent」显示离线 → 终端跑
          <code class="aip-inline-code">{{ aiptDaemonCommand }}</code>
          前台启动(看启动日志确认端口与数据根);也可直接
          <code class="aip-inline-code">{{ aiptUiCommand }}</code> 一键启 daemon + 打开看板。
        </li>
        <li>
          浏览器报「无法连接 daemon」/网络错误 → 是否被代理/插件拦截了 127.0.0.1 请求(常见于公司代理
          PAC);daemon 对同源 / 127.0.0.1 / localhost Origin 自动放行, 无需任何 token。
        </li>
        <li>
          IDE 内 MCP 显示红色 / 启动失败 → 在终端模拟 IDE 启 MCP 子进程:
          <code class="aip-inline-code">node $(which aipt) mcp &lt; /dev/null</code>, stderr 应出现
          <code class="aip-inline-code">reusing daemon</code> 或
          <code class="aip-inline-code">daemon spawned</code>。
        </li>
        <li>
          init 报「分支不含 issue key」→ 切到形如
          <code class="aip-inline-code">feature/ABC-123-xxx</code> 的分支后重试(正则
          <code class="aip-inline-code">[A-Z][A-Z0-9]+-\d+</code>)。
        </li>
        <li>
          升级到最新版:<code class="aip-inline-code"
            >npm i -g @ai-productivity-tracker/cli@latest</code
          >,然后重跑 <code class="aip-inline-code">{{ aiptInstallCommand }}</code> 更新 hooks.json /
          skill 内容,最后完全重启 IDE。
        </li>
        <li>
          Claude watcher 显示「未运行」/「追踪文件数 0」→ 确认
          <code class="aip-inline-code">~/.claude/projects/</code> 存在(只在 Claude Code
          至少跑过一次会话后才会生成);如果存在仍未运行,查
          <code class="aip-inline-code">tail -f ~/.ai-productivity-tracker/logs/*.log</code>。
        </li>
        <li>
          iteration 不增长:
          <ol class="aip-guide__nested">
            <li>
              确认分支名含 issue key:<code class="aip-inline-code">git branch --show-current</code>
            </li>
            <li>
              确认该 issue key 已 init 过:<code class="aip-inline-code"
                >ls ~/.ai-productivity-tracker/data/&lt;KEY&gt;/requirement.json</code
              >(未 init 的 token 会暂存在 bindings 的
              <code class="aip-inline-code">pending</code> 字段)
            </li>
            <li>
              Claude 用户:确认 jsonl 在写:<code class="aip-inline-code"
                >tail -f ~/.claude/projects/&lt;encoded-cwd&gt;/&lt;session&gt;.jsonl</code
              >
            </li>
            <li>
              Cursor 用户:确认 Hook 注入了(「MCP 配置」Tab 「Cursor
              自动追踪」卡片绿色「已注入」);如果异常,点「+ DEBUG 重装」,然后
              <code class="aip-inline-code">tail -f ~/.ai-productivity-hook-fired.log</code> 看
              stdin 是否到 cli hook 入口
            </li>
            <li>
              查 daemon 日志:
              <code class="aip-inline-code">tail -f ~/.ai-productivity-tracker/logs/*.log</code>
            </li>
          </ol>
        </li>
        <li>
          Jira Bug 刷新失败 → 检查「业务配置」Tab「Jira 查询凭证」的 Base URL / Email / API Token /
          JQL 模板;daemon <strong>直接调</strong> Jira REST,不经任何中转。
        </li>
        <li>
          命令行汇总自检:
          <pre class="aip-code aip-code--dark" @click="copy(summaryCurl)">{{ summaryCurl }}</pre>
          <pre class="aip-code aip-code--dark" @click="copy(watcherCurl)">{{ watcherCurl }}</pre>
          <pre class="aip-code aip-code--dark" @click="copy(requirementInspectSample)">{{
            requirementInspectSample
          }}</pre>
        </li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.aip-guide {
  display: grid;
  gap: var(--aipt-space-4);
  max-width: var(--aipt-content-max-w);
  margin: 0 auto;
}

/* ===== Hero ===== */
.aip-guide__hero {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: var(--aipt-space-5);
  padding: var(--aipt-space-6) var(--aipt-space-6);
}

.aip-guide__hero-glow {
  position: absolute;
  inset: -1px;
  background:
    radial-gradient(ellipse at 12% 0%, rgba(110, 167, 245, 0.3) 0%, transparent 55%),
    radial-gradient(ellipse at 90% 100%, rgba(159, 229, 212, 0.2) 0%, transparent 50%);
  filter: blur(30px);
  pointer-events: none;
  opacity: 0.9;
}

.aip-guide__hero-icon {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: var(--aipt-radius-lg);
  color: var(--aipt-text-on-accent);
  flex-shrink: 0;
  box-shadow: var(--aipt-shadow-glow-strong);
}

.aip-guide__hero-icon i {
  font-size: 28px;
}

.aip-guide__hero-info {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: var(--aipt-space-2);
  min-width: 0;
}

.aip-guide__hero-badge {
  align-self: flex-start;
}

.aip-guide__hero-title {
  margin: 0;
  font-size: 32px;
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.aip-guide__hero-sub {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
}

/* ===== Tip ===== */
.aip-guide__tip {
  margin: 0;
  padding: var(--aipt-space-2) var(--aipt-space-3);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-state-warning-soft);
  border: 1px solid rgba(245, 196, 137, 0.3);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
}

/* ===== Bullets ===== */
.aip-guide__bullet-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--aipt-space-2);
}

.aip-guide__bullet-list li {
  padding: var(--aipt-space-3) var(--aipt-space-3) var(--aipt-space-3) 32px;
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  font-size: 13px;
  line-height: 1.7;
  color: var(--aipt-text-secondary);
  position: relative;
}

.aip-guide__bullet-list li::before {
  content: '';
  position: absolute;
  left: 14px;
  top: 19px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aipt-aurora-1);
  box-shadow: 0 0 8px rgba(110, 167, 245, 0.55);
}

.aip-guide__bullet-list--troubleshoot li::before {
  background: var(--aipt-state-warning);
  box-shadow: 0 0 8px rgba(245, 196, 137, 0.5);
}

.aip-guide__nested {
  margin: var(--aipt-space-2) 0 0 var(--aipt-space-4);
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--aipt-text-secondary);
}

@media (max-width: 720px) {
  .aip-guide__hero {
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
  }
  .aip-guide__hero-title {
    font-size: 24px;
  }
}

@media (max-width: 640px) {
  .aip-guide {
    gap: var(--aipt-space-3);
  }
}
</style>
