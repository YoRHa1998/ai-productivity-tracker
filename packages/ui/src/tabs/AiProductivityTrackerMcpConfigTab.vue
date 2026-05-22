<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElButton, ElMessage, ElMessageBox } from 'element-plus'

import {
  fetchCursorHookStatus,
  fetchPublishedMcpVersion,
  fetchTrackSkillStatus,
  fetchWatcherStatus,
  installCursorHook,
  installMcpEntry,
  installTrackSkill,
  type CursorHookStatus,
  type TrackSkillStatus,
  type WatcherStatus
} from '../api'
import AipAgentStatusCard from '../components/AipAgentStatusCard.vue'
import '../styles/aip-shared.css'

const platformOrigin = computed(() =>
  typeof window !== 'undefined' ? window.location.origin : '<platform>'
)

const mcpDownloadCommand = computed(
  () =>
    `curl -fsSL ${platformOrigin.value}/downloads/ai-productivity-mcp/ai-productivity-mcp.mjs -o ~/Downloads/ai-productivity-mcp.mjs && chmod 755 ~/Downloads/ai-productivity-mcp.mjs`
)

const agentReady = ref(false)

const watcher = ref<WatcherStatus | null>(null)
const watcherLoading = ref(false)

const cursorHook = ref<CursorHookStatus | null>(null)
const cursorHookLoading = ref(false)
const cursorHookInstalling = ref(false)

const mcpInstalling = ref(false)
const mcpInstallError = ref<string | null>(null)

// 线上版本 vs 本地版本对比:线上从同源静态 version.json 拉,
// 本地从 agent /ai-productivity/cursor-hook-status 返回的 hookEntryVersion 拿。
const publishedMcpVersion = ref<string | null>(null)

const mcpVersionState = computed<
  'unknown' | 'mismatch' | 'aligned' | 'local-missing' | 'local-legacy'
>(() => {
  if (!cursorHook.value) return 'unknown'
  if (!cursorHook.value.hookEntryInstalled) return 'local-missing'
  const local = cursorHook.value.hookEntryVersion
  const remote = publishedMcpVersion.value
  if (local === null) return 'local-legacy'
  if (remote === null) return 'unknown'
  return local === remote ? 'aligned' : 'mismatch'
})

const mcpVersionLabel = computed(() => {
  const remote = publishedMcpVersion.value ?? '—'
  const local = cursorHook.value?.hookEntryVersion ?? '未知'
  return { remote, local }
})

const mcpVersionChipClass = computed(() => {
  switch (mcpVersionState.value) {
    case 'aligned':
      return 'aip-chip aip-chip--success'
    case 'mismatch':
    case 'local-legacy':
      return 'aip-chip aip-chip--warning'
    default:
      return 'aip-chip aip-chip--muted'
  }
})

const mcpVersionChipLabel = computed(() => {
  switch (mcpVersionState.value) {
    case 'aligned':
      return '版本一致'
    case 'mismatch':
      return '本地落后,需重新下载'
    case 'local-legacy':
      return '本地无版本标记(老 build),建议重新下载'
    case 'local-missing':
      return '本地未下载'
    default:
      return '版本未知'
  }
})

const trackSkill = ref<TrackSkillStatus | null>(null)
const trackSkillLoading = ref(false)
const trackSkillInstalling = ref(false)

const cursorHookStatusLabel = computed(() => {
  if (!cursorHook.value) return '加载中…'
  if (!cursorHook.value.hookEntryInstalled) return '未下载 MCP'
  if (!cursorHook.value.hookInstalled) return '未注入 Hook'
  if (cursorHook.value.legacyHookDetected) return '已注入 · 待清理'
  return cursorHook.value.debugMode ? '已注入 · DEBUG 模式' : '已注入'
})

const cursorHookStatusClass = computed(() => {
  if (!cursorHook.value) return 'aip-chip aip-chip--muted'
  if (!cursorHook.value.hookEntryInstalled) return 'aip-chip aip-chip--muted'
  if (!cursorHook.value.hookInstalled) return 'aip-chip aip-chip--warning'
  if (cursorHook.value.legacyHookDetected) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
})

function describeTrackTarget(
  target: TrackSkillStatus['claude'] | TrackSkillStatus['cursor'] | undefined
): string {
  if (!target) return '加载中…'
  if (!target.installed) return '未注入'
  if (target.outdated) return '版本过时'
  if (target.upToDate) return '已注入'
  return '已注入'
}

function trackTargetChipClass(
  target: TrackSkillStatus['claude'] | TrackSkillStatus['cursor'] | undefined
): string {
  if (!target) return 'aip-chip aip-chip--muted'
  if (!target.installed) return 'aip-chip aip-chip--muted'
  if (target.outdated) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
}

/**
 * v2.16.0 经验提取 skill 聚合态(Claude + Cursor 两个文件):
 * - 任一未装 → 未注入
 * - 任一过时 → 版本过时
 * - 都最新 → 已注入
 */
const lessonsExtractChipLabel = computed<string>(() => {
  const bundle = trackSkill.value?.lessonsExtract
  if (!bundle) return '未知'
  const targets = [bundle.claude, bundle.cursor]
  if (targets.some((t) => !t.installed)) return '未注入'
  if (targets.some((t) => t.outdated)) return '版本过时'
  return '已注入'
})

const lessonsExtractChipClass = computed<string>(() => {
  const bundle = trackSkill.value?.lessonsExtract
  if (!bundle) return 'aip-chip aip-chip--muted'
  const targets = [bundle.claude, bundle.cursor]
  if (targets.some((t) => !t.installed)) return 'aip-chip aip-chip--muted'
  if (targets.some((t) => t.outdated)) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
})

function describeClaudeHook(hook: TrackSkillStatus['claude']['hook'] | undefined): string {
  if (!hook) return '加载中…'
  if (!hook.installed) return '未注入'
  if (!hook.upToDate) return '版本过时'
  return '已注入'
}

function claudeHookChipClass(hook: TrackSkillStatus['claude']['hook'] | undefined): string {
  if (!hook) return 'aip-chip aip-chip--muted'
  if (!hook.installed) return 'aip-chip aip-chip--muted'
  if (!hook.upToDate) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
}

function describeCursorTrackHook(hook: TrackSkillStatus['cursor']['hook'] | undefined): string {
  if (!hook) return '加载中…'
  if (!hook.stopCheckInstalled) return '未注入'
  if (!hook.stopCheckUpToDate) return '版本过时'
  if (hook.legacyMarkToolDetected || hook.legacyHookDetected) return '已注入 · 待清理'
  return '已注入'
}

function cursorTrackHookChipClass(hook: TrackSkillStatus['cursor']['hook'] | undefined): string {
  if (!hook) return 'aip-chip aip-chip--muted'
  if (!hook.stopCheckInstalled) return 'aip-chip aip-chip--muted'
  if (!hook.stopCheckUpToDate) return 'aip-chip aip-chip--warning'
  if (hook.legacyMarkToolDetected || hook.legacyHookDetected) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
}

const trackSkillTargets = computed(() => {
  if (!trackSkill.value) return null
  const t = trackSkill.value
  return [
    { installed: t.claude.installed, upToDate: t.claude.upToDate },
    { installed: t.claude.hook.installed, upToDate: t.claude.hook.upToDate },
    { installed: t.claude.stopCheck.installed, upToDate: t.claude.stopCheck.upToDate },
    { installed: t.cursor.installed, upToDate: t.cursor.upToDate },
    {
      installed: t.cursor.hook.stopCheckInstalled,
      upToDate: t.cursor.hook.stopCheckUpToDate
    }
  ]
})

const trackSkillSummaryLabel = computed(() => {
  if (!trackSkill.value || !trackSkillTargets.value) return '加载中…'
  const total = trackSkillTargets.value.length
  const installed = trackSkillTargets.value.filter((t) => t.installed).length
  const upToDate = trackSkillTargets.value.filter((t) => t.installed && t.upToDate).length
  if (installed === 0) return '未注入'
  if (installed === total && upToDate === total) {
    return `已注入 · v${trackSkill.value.version}`
  }
  return `${installed}/${total} 已注入`
})

const trackSkillSummaryClass = computed(() => {
  if (!trackSkill.value || !trackSkillTargets.value) return 'aip-chip aip-chip--muted'
  const total = trackSkillTargets.value.length
  const installed = trackSkillTargets.value.filter((t) => t.installed).length
  const upToDate = trackSkillTargets.value.filter((t) => t.installed && t.upToDate).length
  if (installed === 0) return 'aip-chip aip-chip--muted'
  if (installed < total || upToDate < installed) return 'aip-chip aip-chip--warning'
  return 'aip-chip aip-chip--success'
})

async function loadWatcher(): Promise<void> {
  watcherLoading.value = true
  try {
    watcher.value = await fetchWatcherStatus()
  } catch (err) {
    watcher.value = null
    ElMessage.warning(`watcher 状态加载失败: ${(err as Error).message}`)
  } finally {
    watcherLoading.value = false
  }
}

async function loadCursorHook(): Promise<void> {
  cursorHookLoading.value = true
  try {
    const [hook, remote] = await Promise.all([fetchCursorHookStatus(), fetchPublishedMcpVersion()])
    cursorHook.value = hook
    publishedMcpVersion.value = remote
  } catch (err) {
    cursorHook.value = null
    ElMessage.warning(`Cursor Hook 状态加载失败: ${(err as Error).message}`)
  } finally {
    cursorHookLoading.value = false
  }
}

async function loadTrackSkill(): Promise<void> {
  trackSkillLoading.value = true
  try {
    trackSkill.value = await fetchTrackSkillStatus()
  } catch (err) {
    trackSkill.value = null
    ElMessage.warning(`Track Skill 状态加载失败: ${(err as Error).message}`)
  } finally {
    trackSkillLoading.value = false
  }
}

async function handleInstallTrackSkill(): Promise<void> {
  trackSkillInstalling.value = true
  try {
    const result = await installTrackSkill()
    const parts: string[] = []
    if (result.claude.written)
      parts.push(result.claude.replaced ? 'Claude Skill 已覆盖' : 'Claude Skill 已写入')
    if (result.claude.hook) {
      parts.push(
        result.claude.hook.replaced
          ? 'Claude UserPromptSubmit 已覆盖'
          : 'Claude UserPromptSubmit 已写入'
      )
    }
    if (result.claude.stopCheck) {
      parts.push(result.claude.stopCheck.replaced ? 'Claude Stop 已覆盖' : 'Claude Stop 已写入')
    }
    if (result.claude.legacyMarkToolRemoved) {
      parts.push('Claude PostToolUse 老条目已清理')
    }
    if (result.cursor.written)
      parts.push(result.cursor.replaced ? 'Cursor Rule 已覆盖' : 'Cursor Rule 已写入')
    if (result.cursor.hook) {
      parts.push(
        result.cursor.hook.stopCheck.replaced ? 'Cursor stop 已覆盖' : 'Cursor stop 已写入'
      )
      if (result.cursor.hook.legacyMarkToolRemoved) {
        parts.push('Cursor afterMCPExecution 老条目已清理')
      }
    }
    ElMessage.success(`AI 对话总结 + 防伪造 Hook 注入完成 · ${parts.join(' / ')}`)
    ElMessage.warning('请完全退出并重启 Cursor / Claude Code 一次,让新 Hook 加载生效')
    await loadTrackSkill()
  } catch (err) {
    ElMessage.error((err as Error).message || '注入失败')
  } finally {
    trackSkillInstalling.value = false
  }
}

async function handleInstallCursorHook(debug = false): Promise<void> {
  cursorHookInstalling.value = true
  try {
    const result = await installCursorHook(debug)
    if (result.ok) {
      if (result.previousCommand) {
        ElMessage.warning(`已覆盖老的 Hook 命令: ${result.previousCommand}`)
      }
      ElMessage.success('已注入 Cursor Hook,请完全退出并重启 Cursor 让 hook 生效')
    } else {
      ElMessage.error(result.errorMessage || '安装失败')
    }
    await loadCursorHook()
  } catch (err) {
    ElMessage.error((err as Error).message || '安装失败')
  } finally {
    cursorHookInstalling.value = false
  }
}

async function copyMcpDownloadCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(mcpDownloadCommand.value)
    ElMessage.success('下载命令已复制,请粘贴到终端执行')
  } catch {
    ElMessage.warning('复制失败,请手动复制')
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function downloadMcpEntry(): Promise<void> {
  mcpInstalling.value = true
  mcpInstallError.value = null
  try {
    const url = `${platformOrigin.value}/downloads/ai-productivity-mcp/ai-productivity-mcp.mjs`
    const resp = await fetch(url, { cache: 'no-store' })
    if (!resp.ok) throw new Error(`下载 .mjs 失败: HTTP ${resp.status}`)
    const buf = await resp.arrayBuffer()
    const result = await installMcpEntry(arrayBufferToBase64(buf))
    ElMessage.success(result.replaced ? `已覆盖更新: ${result.path}` : `已安装: ${result.path}`)
    await loadCursorHook()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    mcpInstallError.value = msg
    ElMessage.error(`安装失败: ${msg}`)
  } finally {
    mcpInstalling.value = false
  }
}

async function confirmInstallDebug(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '启用 DEBUG 模式将在 Hook 命令前加 AI_PRODUCTIVITY_DEBUG_HOOK=1 环境变量,运行时会写诊断日志,排查问题完成后请用「+ 标准模式重装」恢复。',
      '启用 DEBUG 模式',
      { type: 'warning' }
    )
    await handleInstallCursorHook(true)
  } catch {
    /* user cancelled */
  }
}

async function handleAgentReady(ready: boolean): Promise<void> {
  agentReady.value = ready
  if (!ready) return
  await Promise.allSettled([loadWatcher(), loadCursorHook(), loadTrackSkill()])
}
</script>

<template>
  <section class="aip-settings">
    <AipAgentStatusCard variant="mcp" @ready="handleAgentReady" />

    <!-- Cursor Hook -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">▶</span>
          Cursor 自动追踪
        </h3>
        <span :class="cursorHookStatusClass">{{ cursorHookStatusLabel }}</span>
      </header>
      <p class="aip-card__caption">
        在 <code class="aip-inline-code">~/.cursor/hooks.json</code> 注入 afterAgentResponse Hook,
        Cursor IDE 每次回答后自动累计 token 与生成 iteration。Hook 入口与 MCP server 复用同一份
        <code class="aip-inline-code">~/Downloads/ai-productivity-mcp.mjs</code>。
      </p>
      <div v-if="cursorHook" class="aip-settings__watcher">
        <span class="aip-settings__watcher-label">MCP 入口:</span>
        <code class="aip-inline-code">{{ cursorHook.hookEntryPath }}</code>
        <span class="aip-settings__watcher-meta">{{
          cursorHook.hookEntryInstalled ? '已下载' : '未下载'
        }}</span>
        <ElButton
          v-if="cursorHook.hookEntryInstalled"
          size="small"
          plain
          :loading="mcpInstalling"
          :disabled="!agentReady"
          @click="downloadMcpEntry"
        >
          {{ mcpInstalling ? '正在覆盖…' : '重新下载并覆盖' }}
        </ElButton>
        <ElButton
          v-else
          size="small"
          type="primary"
          :loading="mcpInstalling"
          :disabled="!agentReady"
          @click="downloadMcpEntry"
        >
          {{ mcpInstalling ? '正在下载…' : '一键下载到 ~/Downloads' }}
        </ElButton>
      </div>
      <div v-if="cursorHook" class="aip-settings__watcher aip-settings__mcp-version">
        <span class="aip-settings__watcher-label">MCP 版本:</span>
        <span class="aip-settings__watcher-meta">
          线上 <code class="aip-inline-code">v{{ mcpVersionLabel.remote }}</code>
          <span class="aip-settings__watcher-meta-sep"> · </span>
          本地
          <code class="aip-inline-code">{{
            mcpVersionLabel.local === '未知' ? '未知' : `v${mcpVersionLabel.local}`
          }}</code>
        </span>
        <span :class="mcpVersionChipClass">{{ mcpVersionChipLabel }}</span>
      </div>
      <p v-if="mcpInstallError" class="aip-settings__error">{{ mcpInstallError }}</p>
      <div v-if="cursorHook?.legacyHookDetected" class="aip-settings__legacy-warning">
        检测到 <code class="aip-inline-code">~/.cursor/hooks.json</code> 存在历史 hook
        条目,点「一键注入 Hook」自动覆盖即可。
      </div>
      <div class="aip-settings__form-actions">
        <ElButton :loading="cursorHookLoading" @click="loadCursorHook">刷新状态</ElButton>
        <ElButton
          type="primary"
          :loading="cursorHookInstalling"
          :disabled="!agentReady || !cursorHook?.hookEntryInstalled"
          @click="handleInstallCursorHook(false)"
        >
          一键注入 Hook
        </ElButton>
        <ElButton
          plain
          :disabled="!agentReady || !cursorHook?.hookEntryInstalled"
          @click="confirmInstallDebug"
        >
          + DEBUG 重装
        </ElButton>
      </div>
      <div v-if="cursorHook && !cursorHook.hookEntryInstalled" class="aip-settings__install">
        <p class="aip-card__caption">
          未检测到 MCP 入口 (默认期望路径
          <code class="aip-inline-code">~/Downloads/ai-productivity-mcp.mjs</code>)。
          推荐直接点上方「一键下载到
          ~/Downloads」按钮;若浏览器/网络环境受限,也可在终端运行下面命令下载,
          完成后点「刷新状态」并注入 Hook,详见 <strong>「使用说明 → MCP 接入 Step 3」</strong>。
        </p>
        <pre class="aip-code" @click="copyMcpDownloadCommand">{{ mcpDownloadCommand }}</pre>
      </div>
    </article>

    <!-- AI 对话总结 Skill -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">✎</span>
          AI 对话总结 Skill
        </h3>
        <span :class="trackSkillSummaryClass">{{ trackSkillSummaryLabel }}</span>
      </header>
      <p class="aip-card__caption">
        AI 每轮答复前通过 MCP tool
        <code class="aip-inline-code">ai_productivity_attach_summary</code>
        回填一句话总结到当前 iteration,整套通道对用户无感。Stop Hook 后置校验会在 AI
        漏调时静默打回让 AI 下一轮补一次; 前置不满足(分支不含 Jira issueKey / 需求未 init / agent
        不可达)时完全静默,不影响普通对话。
      </p>
      <div v-if="trackSkill" class="aip-settings__track-grid">
        <div class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>Claude Skill</strong>
            <span class="aip-settings__watcher-meta"
              >~/.claude/skills/ai-productivity-track/SKILL.md</span
            >
          </div>
          <span :class="trackTargetChipClass(trackSkill.claude)">{{
            describeTrackTarget(trackSkill.claude)
          }}</span>
        </div>
        <div class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>Claude UserPromptSubmit Hook</strong>
            <span class="aip-settings__watcher-meta"
              >~/.claude/settings.json · UserPromptSubmit reminder</span
            >
          </div>
          <span :class="claudeHookChipClass(trackSkill.claude.hook)">{{
            describeClaudeHook(trackSkill.claude.hook)
          }}</span>
        </div>
        <div class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>Claude Stop Hook</strong>
            <span class="aip-settings__watcher-meta">
              ~/.claude/settings.json · Stop 防伪造校验
              <span
                v-if="trackSkill.claude.legacyMarkToolDetected"
                class="aip-settings__watcher-meta-warn"
              >
                · 检测到历史条目,一键注入自动清理
              </span>
            </span>
          </div>
          <span :class="claudeHookChipClass(trackSkill.claude.stopCheck)">{{
            describeClaudeHook(trackSkill.claude.stopCheck)
          }}</span>
        </div>
        <div class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>Cursor Rule</strong>
            <span class="aip-settings__watcher-meta"
              >~/.cursor/rules/ai-productivity-track.mdc</span
            >
          </div>
          <span :class="trackTargetChipClass(trackSkill.cursor)">{{
            describeTrackTarget(trackSkill.cursor)
          }}</span>
        </div>
        <div class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>Cursor Stop Hook</strong>
            <span class="aip-settings__watcher-meta">
              ~/.cursor/hooks.json · stop 防伪造校验
              <span
                v-if="trackSkill.cursor.hook.legacyMarkToolDetected"
                class="aip-settings__watcher-meta-warn"
              >
                · 检测到历史条目,一键注入自动清理
              </span>
            </span>
          </div>
          <span :class="cursorTrackHookChipClass(trackSkill.cursor.hook)">{{
            describeCursorTrackHook(trackSkill.cursor.hook)
          }}</span>
        </div>
        <!-- v2.16.0:复用「一键注入」一并装入 lessons-extract skill -->
        <div v-if="trackSkill.lessonsExtract" class="aip-settings__track-row">
          <div class="aip-settings__track-label">
            <strong>经验提取 Skill / Rule</strong>
            <span class="aip-settings__watcher-meta">
              ~/.claude/skills/lessons-extract/SKILL.md
              <br />
              ~/.cursor/rules/lessons-extract.mdc
            </span>
          </div>
          <span :class="lessonsExtractChipClass">{{ lessonsExtractChipLabel }}</span>
        </div>
      </div>
      <p class="aip-card__caption aip-card__caption--inline">
        v2.16.0:同步注入「经验提取」skill(lessons-extract),用户在 IDE
        输入「经验提取」即可触发对当前需求的多维度经验抽取,产物在
        <code class="aip-inline-code">复盘经验</code> Tab 浏览。
      </p>
      <div class="aip-settings__form-actions">
        <ElButton :loading="trackSkillLoading" @click="loadTrackSkill">刷新状态</ElButton>
        <ElButton
          type="primary"
          :loading="trackSkillInstalling"
          :disabled="!agentReady"
          @click="handleInstallTrackSkill"
        >
          一键注入 Skill
        </ElButton>
      </div>
    </article>

    <!-- Claude Transcript Watcher -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">◎</span>
          Claude Code 自动追踪
        </h3>
        <span v-if="watcher?.running" class="aip-chip aip-chip--success">运行中</span>
        <span v-else class="aip-chip aip-chip--muted">未运行</span>
      </header>
      <p class="aip-card__caption">
        agent 进程内置 transcript-watcher,监听
        <code class="aip-inline-code">~/.claude/projects/**/*.jsonl</code>
        自动累加 token 与生成 iteration,无需在 Claude Code 内安装任何插件。
      </p>
      <div v-if="watcher" class="aip-settings__watcher">
        <span class="aip-settings__watcher-label">追踪目录:</span>
        <code class="aip-inline-code">{{ watcher.claudeProjectsDir || '—' }}</code>
        <span class="aip-settings__watcher-meta">已跟踪 {{ watcher.trackedFiles }} 个文件</span>
        <span v-if="watcher.startedAt" class="aip-settings__watcher-meta">
          启动于 {{ new Date(watcher.startedAt).toLocaleString() }}
        </span>
      </div>
      <div class="aip-settings__form-actions">
        <ElButton :loading="watcherLoading" @click="loadWatcher">刷新状态</ElButton>
      </div>
    </article>
  </section>
</template>

<style scoped>
.aip-settings {
  display: grid;
  gap: 16px;
  padding: 24px;
}

.aip-settings__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.aip-settings__error {
  color: var(--danger, #d4626f);
  font-size: 12.5px;
  margin: 0;
}

.aip-settings__watcher {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(96, 114, 153, 0.04);
  border: 1px solid rgba(96, 114, 153, 0.08);
  font-size: 13px;
  color: var(--text-secondary);
}

.aip-settings__watcher-label {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 12.5px;
}

.aip-settings__watcher-meta {
  font-size: 12px;
  color: var(--text-soft);
}

.aip-settings__watcher-meta-warn {
  color: var(--color-warning, #d97706);
}

.aip-settings__watcher-meta-sep {
  color: var(--text-soft);
  margin: 0 2px;
}

.aip-settings__mcp-version {
  margin-top: -2px;
  padding: 8px 12px;
  background: rgba(96, 114, 153, 0.025);
}

.aip-settings__install {
  display: grid;
  gap: 8px;
}

.aip-settings__track-grid {
  display: grid;
  gap: 8px;
}

.aip-settings__track-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(96, 114, 153, 0.04);
  border: 1px solid rgba(96, 114, 153, 0.08);
  font-size: 13px;
}

.aip-settings__track-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aip-settings__legacy-warning {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 149, 0, 0.08);
  border: 1px solid rgba(255, 149, 0, 0.2);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
</style>
