<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { RouterLink } from 'vue-router'
import '../styles/aip-shared.css'
import { fetchCursorHookStatus, installMcpEntry } from '../api'

const platformOrigin = computed(() =>
  typeof window !== 'undefined' ? window.location.origin : '<platform>'
)

const agentInstallCommand = computed(
  () =>
    `curl -fsSL ${platformOrigin.value}/downloads/truesight-agent.tar.gz -o /tmp/truesight-agent.tar.gz`
)

const MCP_PLACEHOLDER_PATH = '/Users/<your-username>/Downloads/ai-productivity-mcp.mjs'

const hookEntryInstalled = ref(false)
const hookEntryPath = ref<string>('')
const installing = ref(false)
const installError = ref<string | null>(null)
const probing = ref(false)

const mcpAbsolutePath = computed(() =>
  hookEntryInstalled.value && hookEntryPath.value ? hookEntryPath.value : MCP_PLACEHOLDER_PATH
)

const mcpJsonSample = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        'ai-productivity': {
          command: 'node',
          args: [mcpAbsolutePath.value],
          env: {
            TRUESIGHT_AGENT_URL: 'http://127.0.0.1:17280',
            TRUESIGHT_AGENT_TOKEN: '<复制自 ~/.truesight-local-agent/config.json 的 token 字段>'
          }
        }
      }
    },
    null,
    2
  )
)

const branchSample = 'git checkout -b feature/INSTANT-1234-add-oauth'
const aiPromptSample =
  '帮我开始这个需求,jira 链接:https://yourorg.atlassian.net/browse/INSTANT-1234'

const storageInspectSample =
  'ls ~/.truesight-local-agent/ai-productivity/\n# 应该能看到 index.json / formula.json / jira.json 以及对应的 <JIRA-KEY>/ 目录'
const requirementInspectSample =
  'cat ~/.truesight-local-agent/ai-productivity/INSTANT-1234/requirement.json | jq .title,.status,.startedAt'
const iterationInspectSample =
  'tail -f ~/.truesight-local-agent/ai-productivity/INSTANT-1234/iterations.jsonl'
const bindingsInspectSample = 'cat <repo>/.ai-productivity/bindings.json | jq'

const agentStatusCurl = 'curl -s http://127.0.0.1:17280/status | jq'
const summaryCurl = 'curl -s http://127.0.0.1:17280/ai-productivity/summary | jq'
const watcherCurl = 'curl -s http://127.0.0.1:17280/ai-productivity/watcher-status | jq'

function copy(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => ElMessage.success('已复制'))
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

async function refreshMcpEntryStatus() {
  probing.value = true
  try {
    const status = await fetchCursorHookStatus()
    hookEntryInstalled.value = status.hookEntryInstalled
    hookEntryPath.value = status.hookEntryPath
  } catch {
    // agent 离线/不可达时静默,按钮仍可点击触发(失败时再显示明确错误)
    hookEntryInstalled.value = false
    hookEntryPath.value = ''
  } finally {
    probing.value = false
  }
}

async function downloadMcpEntry() {
  installing.value = true
  installError.value = null
  try {
    const url = `${platformOrigin.value}/downloads/ai-productivity-mcp/ai-productivity-mcp.mjs`
    const resp = await fetch(url, { cache: 'no-store' })
    if (!resp.ok) {
      throw new Error(`下载 .mjs 失败: HTTP ${resp.status}`)
    }
    const buf = await resp.arrayBuffer()
    const base64 = arrayBufferToBase64(buf)
    const result = await installMcpEntry(base64)
    hookEntryInstalled.value = true
    hookEntryPath.value = result.path
    ElMessage.success(result.replaced ? `已覆盖更新: ${result.path}` : `已安装: ${result.path}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    installError.value = msg
    ElMessage.error(`安装失败: ${msg}`)
  } finally {
    installing.value = false
  }
}

onMounted(() => {
  void refreshMcpEntryStatus()
})
</script>

<template>
  <section class="aip-guide">
    <!-- Hero -->
    <div class="aip-hero">
      <div class="aip-hero__left">
        <div class="aip-hero__icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 19V5a2 2 0 0 1 2-2h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              d="M14 3v4h4M8 12h8M8 16h6M8 8h4"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div class="aip-hero__info">
          <div class="aip-hero__title-row">
            <h3>使用说明</h3>
            <span class="aip-chip aip-chip--solid">本地优先</span>
          </div>
          <p>
            所有数据都存在本机
            <code class="aip-inline-code">~/.truesight-local-agent/ai-productivity/</code
            >,看板浏览器直接读写本地
            <code class="aip-inline-code">127.0.0.1:17280</code>,不依赖任何平台 API。
          </p>
        </div>
      </div>
    </div>

    <!-- 接入 5 步 -->
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
          MCP 接入(推荐)
        </h3>
        <span class="aip-chip aip-chip--success">主路径</span>
      </header>
      <p class="aip-card__caption">
        每个开发者一次性安装即可。后续每个新需求只需在 IDE 里跟 AI 自然语言对话触发。
      </p>

      <ol class="aip-flow">
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 1 · 安装本地代理 truesight-agent</h4>
            <p>
              到平台「<RouterLink to="/modules/local-agent" class="aip-guide__link"
                >本地脚本执行器</RouterLink
              >」模块下载并安装 truesight-agent。agent 是 launchd 自启动后台服务,只监听
              <code class="aip-inline-code">127.0.0.1:17280</code>,不会暴露公网。
            </p>
            <pre class="aip-code" @click="copy(agentInstallCommand)">{{ agentInstallCommand }}</pre>
            <p class="aip-guide__tip">
              安装完成后,<code class="aip-inline-code">~/.truesight-local-agent/config.json</code>
              里会自动生成一个 <code class="aip-inline-code">token</code>,这是供 IDE / Hook / CLI
              上报使用的 Bearer agent token,看板浏览器不需要它。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 2 · 在「业务配置」Tab 确认 agent 在线</h4>
            <p>
              切到本工具的「业务配置」Tab,顶部「本地 Agent」卡片应该显示绿色
              <strong>在线 · vX.Y.Z</strong>,并显示存储目录路径(可一键复制)。
            </p>
            <p>
              同卡片下方可调整提效公式、配置 Jira 查询凭证(配置后看板可一键刷 Bug 数,凭证只存本机
              <code class="aip-inline-code">jira.json</code>)。MCP / Hook / Skill
              注入相关入口集中在「MCP 配置」Tab,与业务配置区分。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 3 · 一键下载 MCP server</h4>
            <div class="aip-mcp-install">
              <div v-if="hookEntryInstalled && hookEntryPath" class="aip-mcp-install__row">
                <span class="aip-chip aip-chip--success">已安装</span>
                <code class="aip-mcp-install__path" @click="copy(hookEntryPath)">{{
                  hookEntryPath
                }}</code>
                <button
                  type="button"
                  class="aip-mcp-install__btn aip-mcp-install__btn--ghost"
                  :disabled="installing"
                  @click="downloadMcpEntry"
                >
                  {{ installing ? '正在覆盖…' : '重新下载并覆盖' }}
                </button>
              </div>
              <div v-else class="aip-mcp-install__row">
                <button
                  type="button"
                  class="aip-mcp-install__btn"
                  :disabled="installing || probing"
                  @click="downloadMcpEntry"
                >
                  {{ installing ? '正在下载…' : '一键下载到 ~/Downloads' }}
                </button>
                <span v-if="probing" class="aip-mcp-install__hint">检测本机安装状态…</span>
              </div>
              <p v-if="installError" class="aip-mcp-install__error">{{ installError }}</p>
            </div>
            <p>
              这是一个零依赖的单文件 <code class="aip-inline-code">.mjs</code>,由
              <code class="aip-inline-code">node</code> 直接执行。它只把 IDE 的 MCP tool
              调用转发到本机 agent,不会自己联网。
            </p>
            <p class="aip-guide__tip">
              点击按钮后,浏览器会从平台拉取最新 <code class="aip-inline-code">.mjs</code>,再经本地
              agent 落盘到
              <code class="aip-inline-code">~/Downloads/ai-productivity-mcp.mjs</code> 并
              <code class="aip-inline-code">chmod 755</code>;agent 自身不主动联网。 同一份
              <code class="aip-inline-code">.mjs</code> 也承担
              <strong>Cursor afterAgentResponse Hook 入口</strong>(<code class="aip-inline-code"
                >node ai-productivity-mcp.mjs hook</code
              >);Claude Code 用户走 agent 内置 transcript-watcher,这一步只为支持 Cursor 自动累计。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 4 · 把 MCP JSON 粘到 IDE</h4>
            <pre class="aip-code aip-code--dark" @click="copy(mcpJsonSample)">{{
              mcpJsonSample
            }}</pre>
            <ul>
              <li>
                Cursor → <code class="aip-inline-code">~/.cursor/mcp.json</code>(如已有
                <code class="aip-inline-code">mcpServers</code>,合并
                <code class="aip-inline-code">ai-productivity</code> 字段)
              </li>
              <li>
                Claude Code → <code class="aip-inline-code">~/.claude/settings.json</code> 的
                <code class="aip-inline-code">mcpServers</code> 段
              </li>
            </ul>
            <p v-if="hookEntryInstalled" class="aip-guide__tip">
              已用 Step 3「一键下载」按钮安装,上方 JSON 的
              <code class="aip-inline-code">args[0]</code>
              已自动填好本机真实绝对路径,直接复制粘贴即可。
            </p>
            <p class="aip-guide__tip aip-guide__tip--danger">
              <strong
                >注意:<code class="aip-inline-code">args</code> 必须用绝对路径,<code
                  class="aip-inline-code"
                  >~</code
                >
                不会被 IDE 的 MCP launcher 展开。</strong
              >
              若手抄此 JSON,请把
              <code class="aip-inline-code"
                >/Users/&lt;your-username&gt;/Downloads/ai-productivity-mcp.mjs</code
              >
              替换成你本机的完整路径, 终端运行
              <code class="aip-inline-code">echo $HOME</code> 即可拿到
              <code class="aip-inline-code">/Users/xxx</code> 前缀。 如果误写成
              <code class="aip-inline-code">~/Downloads/...</code>, MCP server 会启动失败,AI 调用
              <code class="aip-inline-code">ai_productivity_attach_summary</code> 时不会真正打到
              agent, 导致看板「本轮无 AI 对话总结」一直空着。
            </p>
            <p>
              <code class="aip-inline-code">TRUESIGHT_AGENT_TOKEN</code> 填 Step 1 中
              <code class="aip-inline-code">~/.truesight-local-agent/config.json</code> 里的
              <code class="aip-inline-code">token</code>。改完后重启 IDE 让 MCP 生效。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 5 · 切到含 Jira Key 的分支,跟 AI 自然语言开启需求</h4>
            <pre class="aip-code" @click="copy(branchSample)">{{ branchSample }}</pre>
            <p>
              分支名需要包含形如 <code class="aip-inline-code">INSTANT-1234</code> 的 issue key,否则
              agent 与后续 hook / watcher 会静默跳过(不污染指标)。
            </p>
            <p>然后跟 AI 说一句:</p>
            <pre class="aip-code" @click="copy(aiPromptSample)">{{ aiPromptSample }}</pre>
            <p>
              AI 会调用 <code class="aip-inline-code">ai_productivity_init</code> MCP tool,agent
              在本机创建需求文件夹
              <code class="aip-inline-code"
                >~/.truesight-local-agent/ai-productivity/&lt;JIRA-KEY&gt;/</code
              >,并把当前分支绑定到该 jiraKey。
            </p>
            <p class="aip-guide__tip">
              <strong>Cursor 用户额外一步</strong>:回到「MCP 配置」Tab → 「Cursor
              自动追踪」卡片点「一键注入 Hook」即可。 agent 会直接把
              <code class="aip-inline-code">node ~/Downloads/ai-productivity-mcp.mjs hook</code>
              写到 <code class="aip-inline-code">~/.cursor/hooks.json</code>,不再依赖独立
              CLI。Claude Code 用户不需要这一步。
            </p>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 6 · 注入对话总结 Skill(推荐)</h4>
            <p>
              回到「MCP 配置」Tab → 「AI 对话总结 Skill」卡片点「一键注入 Skill」。agent
              会自动落盘两份文件:
            </p>
            <ul>
              <li>
                Claude 端:<code class="aip-inline-code"
                  >~/.claude/skills/ai-productivity-track/SKILL.md</code
                >
              </li>
              <li>
                Cursor 端:<code class="aip-inline-code"
                  >~/.cursor/rules/ai-productivity-track.mdc</code
                >
              </li>
            </ul>
            <p>
              注入后,每次涉及代码改动(<code class="aip-inline-code">Write</code>/<code
                class="aip-inline-code"
                >Edit</code
              >/<code class="aip-inline-code">git commit</code> 等)的对话结束时,AI 会自动生成
              100-300 字的本轮总结,通过
              <code class="aip-inline-code">ai_productivity_attach_summary</code> MCP tool
              回填到最新一条 iteration,看板抽屉时间线即可看到这条软数据。
            </p>
            <p class="aip-guide__tip">
              纯问答 / 只读对话不会触发上报,不会污染指标。agent 离线或当前分支未绑定时 skill
              静默跳过。
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
          常用 MCP 工具
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
          参数。
        </li>
        <li>
          <code class="aip-inline-code">ai_productivity_status</code> ——
          查询当前分支的绑定状态、累计 token、对应 jiraKey。
        </li>
      </ul>
      <p class="aip-guide__tip">
        AI 在开始新对话时若识别到分支含 issue key 但 agent 报"未绑定",会主动建议跑一次 init。
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
      <p class="aip-card__caption">Claude 端 / Cursor 端都直接写本机文件,无需平台同步:</p>
      <ul class="aip-guide__bullet-list">
        <li>
          <strong>Claude Code</strong>:agent 进程内置
          <code class="aip-inline-code">TranscriptWatcher</code> 监听
          <code class="aip-inline-code">~/.claude/projects/**/*.jsonl</code>,每条 assistant 消息按
          cwd → git root → branch → Jira Key 路由,命中已绑定需求时即 <strong>直接写</strong>
          <code class="aip-inline-code"
            >~/.truesight-local-agent/ai-productivity/&lt;KEY&gt;/iterations.jsonl</code
          >。
        </li>
        <li>
          <strong>Cursor</strong>:在「MCP 配置」Tab 「Cursor 自动追踪」卡片点「一键注入
          Hook」即可。Cursor 每次回答后会执行
          <code class="aip-inline-code">node ~/Downloads/ai-productivity-mcp.mjs hook</code>(同一份
          MCP .mjs 在 <code class="aip-inline-code">argv[2]==='hook'</code> 时跳过 MCP loop,直接跑
          hook-core 的 runHook),把 token usage POST 给 agent。
        </li>
        <li>
          Token 计量 =
          <code class="aip-inline-code">input + output + cache_creation + cache_read</code
          >(与官方计费一致);agent 重启不会重复计数(<code class="aip-inline-code"
            >~/.truesight-local-agent/transcript-state.json</code
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
        按下面 5 步走一遍,确认本地存储链路完全通畅。任何一步异常都说明这条链没接好。
      </p>

      <ol class="aip-flow">
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 1 · 看板侧自检</h4>
            <ul>
              <li>
                切到本工具「业务配置」Tab:「本地 Agent」卡片应显示绿色
                <strong>在线 · vX.Y.Z</strong>,「存储目录」应显示
                <code class="aip-inline-code">~/.truesight-local-agent/ai-productivity</code>。
              </li>
              <li>
                「MCP 配置」Tab「Cursor 自动追踪」卡片:绿色「已注入」表示 hook 已就绪;若为「未安装
                CLI」或「未注入 Hook」,点「一键注入 Hook」。
              </li>
              <li>
                「MCP 配置」Tab「Claude Code 自动追踪」卡片:绿色「运行中」表示 transcript-watcher
                已启动;只在 Claude Code 至少跑过一次会话后才会显示追踪文件数 &gt; 0。
              </li>
            </ul>
            <p>命令行核对 agent 在线:</p>
            <pre class="aip-code aip-code--dark" @click="copy(agentStatusCurl)">{{
              agentStatusCurl
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
                本机文件系统应该新增一份
                <code class="aip-inline-code"
                  >~/.truesight-local-agent/ai-productivity/DEMO-1/requirement.json</code
                >
              </li>
              <li>
                对应 git 仓库下应该多了
                <code class="aip-inline-code">.ai-productivity/bindings.json</code>,里面
                <code class="aip-inline-code">DEMO-1.branch</code> 指向当前分支
              </li>
            </ul>
            <p>命令行直接核对:</p>
            <pre class="aip-code aip-code--dark" @click="copy(storageInspectSample)">{{
              storageInspectSample
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
                Cursor → CLI hook 调本地 agent
                <code class="aip-inline-code">POST /ai-productivity/hook</code> → 写
                bindings.cumulativeToken + 追加
                <code class="aip-inline-code">iterations.jsonl</code> 一行
              </li>
              <li>
                Claude Code → agent 内置 watcher 监听到 jsonl 增量 → 写 bindings.cumulativeToken +
                追加 <code class="aip-inline-code">iterations.jsonl</code> 一行
              </li>
              <li>
                看板 Workspace 列表「累计 Token / Coding
                次数」实时增长(<strong>无需刷新</strong>:抽屉详情时间线会出现新 iteration 卡片)
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
                对话总结」段落;还没注入时显示「本轮无 AI 对话总结」灰色占位
              </li>
              <li>
                抽屉右上「刷新 Bug 数」按钮 → 若 Settings 已配置 Jira 凭证,agent 会直接调 Jira REST
                把 <code class="aip-inline-code">linkedBugCount</code> 与
                <code class="aip-inline-code">bugsRefreshedAt</code> 写回 requirement.json
              </li>
              <li>
                「业务配置」Tab 调整公式系数并保存 → 提效倍数会用新公式重新计算(本身不需要刷新)
              </li>
            </ul>
          </div>
        </li>
        <li class="aip-flow-step">
          <span class="aip-flow-dot" />
          <div class="aip-flow-body">
            <h4>Step 5 · 服务重启 + 数据持久性</h4>
            <p>(可选)验证数据完全落在本机:</p>
            <ol class="aip-guide__nested">
              <li>
                停掉 agent:
                <code class="aip-inline-code"
                  >launchctl unload ~/Library/LaunchAgents/com.truesight.local-agent.plist</code
                >
              </li>
              <li>看板刷新:本地 Agent 卡应该显示「离线」;Workspace 列表为空且报错(预期行为)</li>
              <li>
                重启 agent:
                <code class="aip-inline-code"
                  >launchctl load ~/Library/LaunchAgents/com.truesight.local-agent.plist</code
                >
              </li>
              <li>看板刷新:DEMO-1 应该立刻回来,iteration 计数与重启前完全一致</li>
              <li>
                清理:抽屉「状态」改成「已放弃」即可让该测试需求从默认筛选里消失;或者直接
                <code class="aip-inline-code"
                  >rm -rf ~/.truesight-local-agent/ai-productivity/DEMO-1</code
                >
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
          看板「本地 Agent」显示离线 → 命令行
          <code class="aip-inline-code">curl -s http://127.0.0.1:17280/status</code>,无响应则手动
          <code class="aip-inline-code">~/Downloads/truesight-agent start &amp;</code>
        </li>
        <li>
          看板报「无法连接 agent」/网络错误 → 浏览器是否被代理/插件拦截了 127.0.0.1
          请求(常见于公司代理 PAC);agent 看板路由对同源 / 127.0.0.1 / localhost Origin 自动放行
        </li>
        <li>
          MCP 没在 IDE 中显示 → 确认
          <code class="aip-inline-code">node ~/Downloads/ai-productivity-mcp.mjs</code> 能手动跑通且
          stderr 出现 <code class="aip-inline-code">running -&gt; http://127.0.0.1:17280</code>
        </li>
        <li>
          MCP 调用报 <code class="aip-inline-code">401</code> → IDE MCP JSON 里
          <code class="aip-inline-code">TRUESIGHT_AGENT_TOKEN</code> 与
          <code class="aip-inline-code">~/.truesight-local-agent/config.json</code> 里的
          <code class="aip-inline-code">token</code> 不一致
        </li>
        <li>
          init 报「分支不含 issue key」→ 切到形如
          <code class="aip-inline-code">feature/ABC-123-xxx</code> 的分支后重试(正则
          <code class="aip-inline-code">[A-Z][A-Z0-9]+-\d+</code>)
        </li>
        <li>
          Cursor 一键注入 Hook 显示「未下载 MCP」→ 回「MCP 接入 → Step 3」点「一键下载到
          ~/Downloads」按钮,完成后再回本卡片点「刷新状态」+「一键注入 Hook」
        </li>
        <li>
          Claude watcher 显示「未运行」/「追踪文件数 0」→ 确认
          <code class="aip-inline-code">~/.claude/projects/</code> 存在(只在 Claude Code
          至少跑过一次会话后才会生成);如果存在仍未运行,检查
          <code class="aip-inline-code">tail -f ~/.truesight-local-agent/logs/*.log</code>
        </li>
        <li>
          iteration 不增长:
          <ol class="aip-guide__nested">
            <li>
              确认分支名含 issue key:<code class="aip-inline-code">git branch --show-current</code>
            </li>
            <li>
              确认该 issue key 已 init 过:<code class="aip-inline-code"
                >ls ~/.truesight-local-agent/ai-productivity/&lt;KEY&gt;/requirement.json</code
              >(未 init 的 token 在 bindings 的 <code class="aip-inline-code">pending</code>)
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
              stdin 是否到 MCP .mjs hook 入口
            </li>
            <li>
              查 agent 日志:
              <code class="aip-inline-code">tail -f ~/.truesight-local-agent/logs/*.log</code>
            </li>
          </ol>
        </li>
        <li>
          Jira Bug 刷新失败 → 检查 Settings「Jira 查询凭证」的 Base URL / Email / API Token / JQL
          模板;agent <strong>直接调</strong> Jira REST,不经平台代理
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
  gap: 16px;
  padding: 24px;
}

.aip-guide__tip {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(255, 169, 0, 0.08);
  border: 1px solid rgba(255, 169, 0, 0.18);
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-secondary);
}

.aip-guide__tip--danger {
  background: rgba(212, 98, 111, 0.08);
  border-color: rgba(212, 98, 111, 0.28);
  color: var(--danger, #d4626f);
}

.aip-guide__tip--danger strong {
  color: var(--danger, #d4626f);
}

.aip-mcp-install {
  display: grid;
  gap: 8px;
  margin: 8px 0 12px;
}

.aip-mcp-install__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.aip-mcp-install__btn {
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  background: var(--accent-primary, #4f6ef5);
  color: #fff;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.aip-mcp-install__btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.aip-mcp-install__btn:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.aip-mcp-install__btn--ghost {
  background: transparent;
  color: var(--accent-primary, #4f6ef5);
  border: 1px solid rgba(79, 110, 245, 0.4);
  padding: 7px 13px;
}

.aip-mcp-install__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(96, 114, 153, 0.08);
  cursor: pointer;
  word-break: break-all;
}

.aip-mcp-install__path:hover {
  background: rgba(96, 114, 153, 0.16);
}

.aip-mcp-install__hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.aip-mcp-install__error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(212, 98, 111, 0.08);
  border: 1px solid rgba(212, 98, 111, 0.28);
  color: var(--danger, #d4626f);
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-all;
}

.aip-guide__bullet-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}

.aip-guide__bullet-list li {
  padding: 10px 12px 10px 28px;
  border-radius: 8px;
  background: rgba(96, 114, 153, 0.04);
  border: 1px solid rgba(96, 114, 153, 0.08);
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary);
  position: relative;
}

.aip-guide__bullet-list li::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 17px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary, #4f6ef5);
  opacity: 0.7;
}

.aip-guide__bullet-list--troubleshoot li::before {
  background: #d48200;
}

.aip-guide__nested {
  margin: 6px 0 0 16px;
  padding: 0;
  display: grid;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.aip-guide__link {
  color: var(--accent-primary, #4f6ef5);
  text-decoration: none;
  font-weight: 600;
}

.aip-guide__link:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .aip-guide {
    padding: 18px;
    gap: 14px;
  }
}
</style>
