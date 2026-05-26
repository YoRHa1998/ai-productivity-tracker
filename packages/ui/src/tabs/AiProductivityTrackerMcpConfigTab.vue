<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElButton, ElMessage, ElMessageBox } from 'element-plus'

import {
  fetchCursorHookStatus,
  fetchTrackSkillStatus,
  fetchWatcherStatus,
  installCursorHook,
  installTrackSkill,
  type CursorHookStatus,
  type TrackSkillStatus,
  type WatcherStatus
} from '../api'
import { useAgentContext } from '../composables/useAgentContext'
import '../styles/aip-shared.css'

const installCliCommand = 'npm install -g @ai-productivity-tracker/cli'
const aiptInstallCommand = 'aipt install'
const aiptInstallCursorOnlyCommand = 'aipt install --ide=cursor'
const aiptInstallClaudeOnlyCommand = 'aipt install --ide=claude'
const aiptDoctorCommand = 'aipt doctor'

const { state: agentState } = useAgentContext()
const agentReady = computed(() => agentState.value.agent.ok)
const initialized = ref(false)

const watcher = ref<WatcherStatus | null>(null)
const watcherLoading = ref(false)

const cursorHook = ref<CursorHookStatus | null>(null)
const cursorHookLoading = ref(false)
const cursorHookInstalling = ref(false)

const trackSkill = ref<TrackSkillStatus | null>(null)
const trackSkillLoading = ref(false)
const trackSkillInstalling = ref(false)

const cursorHookStatusLabel = computed(() => {
  if (!cursorHook.value) return '加载中…'
  if (!cursorHook.value.hookInstalled) return '未注入'
  if (cursorHook.value.legacyHookDetected) return '已注入 · 待清理'
  return cursorHook.value.debugMode ? '已注入 · DEBUG 模式' : '已注入'
})

const cursorHookStatusClass = computed(() => {
  if (!cursorHook.value) return 'aip-chip aip-chip--muted'
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
    cursorHook.value = await fetchCursorHookStatus()
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

async function copyText(text: string, hint: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`${hint} 已复制`)
  } catch {
    ElMessage.warning('复制失败,请手动复制')
  }
}

async function confirmInstallDebug(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '启用 DEBUG 模式将在 Hook 命令前加 AI_PRODUCTIVITY_DEBUG_HOOK=1 环境变量,运行时会写诊断日志,排查问题完成后请用「一键注入 Hook」按钮恢复标准模式。',
      '启用 DEBUG 模式',
      { type: 'warning' }
    )
    await handleInstallCursorHook(true)
  } catch {
    /* user cancelled */
  }
}

watch(
  agentReady,
  async (ready) => {
    if (!ready || initialized.value) return
    initialized.value = true
    await Promise.allSettled([loadWatcher(), loadCursorHook(), loadTrackSkill()])
  },
  { immediate: true }
)
</script>

<template>
  <section class="aip-settings">
    <p v-if="!agentReady" class="aip-settings__offline aipt-glass">
      <span class="aipt-status-dot aipt-status-dot--danger"></span>
      <span>Daemon 当前离线,以下「一键注入」按钮暂时无法工作,先到 Daemon 状态页排查。</span>
    </p>

    <!-- 推荐:命令行一键集成 -->
    <article class="aip-card aip-card--accent">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon"><i class="i-lucide-zap"></i></span>
          推荐:命令行一键集成
        </h3>
        <span class="aip-chip aip-chip--success">主路径</span>
      </header>
      <p class="aip-card__caption">
        一行命令完成
        <strong
          >Cursor + Claude Code MCP server + Cursor hooks.json + Claude / Cursor skill +
          rule</strong
        >
        的注入(自动写 <code class="aip-inline-code">~/.cursor/mcp.json</code> 与
        <code class="aip-inline-code">~/.claude.json</code
        >),无需手动下载任何文件。下面卡片仅用于状态可视化与单点重装。
      </p>
      <div class="aip-mcp-config__cli">
        <div class="aip-mcp-config__cli-item">
          <span class="aip-mcp-config__cli-step">1</span>
          <div class="aip-mcp-config__cli-body">
            <strong>全局安装 CLI</strong>
            <code
              class="aip-mcp-config__cli-cmd"
              @click="copyText(installCliCommand, '安装命令')"
              :title="installCliCommand"
              >{{ installCliCommand }}</code
            >
          </div>
        </div>
        <div class="aip-mcp-config__cli-item">
          <span class="aip-mcp-config__cli-step">2</span>
          <div class="aip-mcp-config__cli-body">
            <strong>一键注入 IDE 配置</strong>
            <code
              class="aip-mcp-config__cli-cmd"
              @click="copyText(aiptInstallCommand, '安装命令')"
              :title="aiptInstallCommand"
              >{{ aiptInstallCommand }}</code
            >
            <p class="aip-mcp-config__cli-hint">
              只装 Cursor:<code
                class="aip-inline-code aip-mcp-config__inline-cmd"
                @click="copyText(aiptInstallCursorOnlyCommand, '命令')"
                >{{ aiptInstallCursorOnlyCommand }}</code
              >
              · 只装 Claude:<code
                class="aip-inline-code aip-mcp-config__inline-cmd"
                @click="copyText(aiptInstallClaudeOnlyCommand, '命令')"
                >{{ aiptInstallClaudeOnlyCommand }}</code
              >
            </p>
          </div>
        </div>
        <div class="aip-mcp-config__cli-item">
          <span class="aip-mcp-config__cli-step">3</span>
          <div class="aip-mcp-config__cli-body">
            <strong>完全重启 IDE</strong>(Cmd + Q 退出 Cursor / Claude Code 再启动),让 mcp.json /
            hooks.json / skill 生效。
            <p class="aip-mcp-config__cli-hint">
              想体检:<code
                class="aip-inline-code aip-mcp-config__inline-cmd"
                @click="copyText(aiptDoctorCommand, '体检命令')"
                >{{ aiptDoctorCommand }}</code
              >
              一行 9 项检查。
            </p>
          </div>
        </div>
      </div>
    </article>

    <!-- Cursor Hook -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon"><i class="i-lucide-play"></i></span>
          Cursor 自动追踪(afterAgentResponse Hook)
        </h3>
        <span :class="cursorHookStatusClass">{{ cursorHookStatusLabel }}</span>
      </header>
      <p class="aip-card__caption">
        在 <code class="aip-inline-code">~/.cursor/hooks.json</code> 注入 afterAgentResponse Hook,
        Cursor IDE 每次回答后自动累计 token 与生成 iteration。命令形如
        <code class="aip-inline-code">node &lt;cli.mjs&gt; hook</code>,与当前 daemon
        同源,无需手动下载。
      </p>
      <div v-if="cursorHook && cursorHook.hookCommand" class="aip-settings__watcher">
        <span class="aip-settings__watcher-label">Hook 命令:</span>
        <code class="aip-inline-code aip-mcp-config__hook-path">{{ cursorHook.hookCommand }}</code>
      </div>
      <div v-if="cursorHook?.legacyHookDetected" class="aip-settings__legacy-warning">
        检测到 <code class="aip-inline-code">~/.cursor/hooks.json</code> 存在历史 hook
        条目,点「一键注入 Hook」自动覆盖即可。
      </div>
      <div class="aip-settings__form-actions">
        <ElButton :loading="cursorHookLoading" @click="loadCursorHook">刷新状态</ElButton>
        <ElButton
          type="primary"
          :loading="cursorHookInstalling"
          :disabled="!agentReady"
          @click="handleInstallCursorHook(false)"
        >
          一键注入 Hook
        </ElButton>
        <ElButton plain :disabled="!agentReady" @click="confirmInstallDebug">
          + DEBUG 重装
        </ElButton>
      </div>
      <p class="aip-card__caption aip-card__caption--inline">
        看板这里点「一键注入」等价于 <code class="aip-inline-code">aipt install --ide=cursor</code>
        的 Hook 部分;两者写入的内容完全一致。
      </p>
    </article>

    <!-- AI 对话总结 Skill -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon"><i class="i-lucide-edit-3"></i></span>
          AI 对话总结 Skill / Rule
        </h3>
        <span :class="trackSkillSummaryClass">{{ trackSkillSummaryLabel }}</span>
      </header>
      <p class="aip-card__caption">
        AI 每轮答复前通过 MCP tool
        <code class="aip-inline-code">ai_productivity_attach_summary</code>
        回填一句话总结到当前 iteration,整套通道对用户无感。Stop Hook 后置校验会在 AI
        漏调时静默打回让 AI 下一轮补一次; 前置不满足(分支不含 Jira issueKey / 需求未 init / daemon
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
        在 IDE 内输入「经验提取」即可触发对当前需求的多维度经验抽取,产物在
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
          <span class="aip-card__title-icon"><i class="i-lucide-eye"></i></span>
          Claude Code 自动追踪(Transcript Watcher)
        </h3>
        <span v-if="watcher?.running" class="aip-chip aip-chip--success">运行中</span>
        <span v-else class="aip-chip aip-chip--muted">未运行</span>
      </header>
      <p class="aip-card__caption">
        daemon 进程内置 transcript-watcher,监听
        <code class="aip-inline-code">~/.claude/projects/**/*.jsonl</code>
        自动累加 token 与生成 iteration,无需在 Claude Code 内安装任何插件,也不需要手动启动。
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
  gap: var(--aipt-space-4);
}

.aip-settings__offline {
  display: flex;
  align-items: center;
  gap: var(--aipt-space-2);
  margin: 0;
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  font-size: 13px;
  color: var(--aipt-state-danger);
}

.aip-settings__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--aipt-space-2);
}

.aip-settings__watcher {
  display: flex;
  gap: var(--aipt-space-2);
  align-items: center;
  flex-wrap: wrap;
  padding: var(--aipt-space-3) var(--aipt-space-3);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  font-size: 13px;
  color: var(--aipt-text-secondary);
}

.aip-settings__watcher-label {
  font-weight: 600;
  color: var(--aipt-text);
  font-size: 12.5px;
}

.aip-settings__watcher-meta {
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-settings__watcher-meta-warn {
  color: var(--aipt-state-warning);
}

.aip-settings__track-grid {
  display: grid;
  gap: var(--aipt-space-2);
}

.aip-settings__track-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  font-size: 13px;
}

.aip-settings__track-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.aip-settings__legacy-warning {
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-state-warning-soft);
  border: 1px solid rgba(245, 196, 137, 0.3);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--aipt-state-warning);
}

/* ===== 命令行一键集成块 ===== */
.aip-mcp-config__cli {
  display: grid;
  gap: var(--aipt-space-2);
}

.aip-mcp-config__cli-item {
  display: flex;
  align-items: flex-start;
  gap: var(--aipt-space-3);
  padding: var(--aipt-space-3) var(--aipt-space-4);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft);
  border: 1px solid var(--aipt-border-faint);
  transition: border-color var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-mcp-config__cli-item:hover {
  border-color: var(--aipt-border-strong);
}

.aip-mcp-config__cli-step {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--aipt-gradient-aurora);
  color: var(--aipt-text-on-accent);
  font-size: 12px;
  font-weight: 700;
  line-height: 26px;
  text-align: center;
  box-shadow: var(--aipt-shadow-glow);
}

.aip-mcp-config__cli-body {
  flex: 1;
  display: grid;
  gap: 6px;
  min-width: 0;
}

.aip-mcp-config__cli-body strong {
  font-size: 13.5px;
  color: var(--aipt-text);
}

.aip-mcp-config__cli-cmd {
  display: inline-block;
  padding: 7px 12px;
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-bg-deep);
  border: 1px solid var(--aipt-border);
  color: var(--aipt-text);
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  cursor: pointer;
  user-select: all;
  word-break: break-all;
  transition:
    border-color var(--aipt-duration-base) var(--aipt-easing-out),
    background var(--aipt-duration-base) var(--aipt-easing-out);
}

.aip-mcp-config__cli-cmd:hover {
  border-color: var(--aipt-aurora-2);
  background: var(--aipt-surface-hover);
}

.aip-mcp-config__cli-hint {
  margin: 0;
  font-size: 12px;
  color: var(--aipt-text-secondary);
  line-height: 1.6;
}

.aip-mcp-config__inline-cmd {
  cursor: pointer;
  user-select: all;
}

.aip-mcp-config__inline-cmd:hover {
  color: var(--aipt-aurora-2);
}

.aip-mcp-config__hook-path {
  word-break: break-all;
  flex: 1;
  min-width: 0;
}
</style>
