<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElButton, ElMessage } from 'element-plus'

import { AGENT_BASE, fetchStoragePath, probeAgent, type AgentStatus } from '../api'

defineProps<{
  /** 文案语境:business 强调业务配置语义,mcp 强调 MCP 入口语义 */
  variant?: 'business' | 'mcp'
}>()

const emit = defineEmits<{
  (event: 'ready', value: boolean): void
}>()

const agent = reactive<AgentStatus>({ ok: false })
const agentChecking = ref(false)
const storagePath = ref('')

async function loadAgent(): Promise<void> {
  agentChecking.value = true
  try {
    const status = await probeAgent()
    Object.assign(agent, status)
    if (status.ok) {
      const sp = await fetchStoragePath().catch(() => ({ root: '' }))
      storagePath.value = sp.root
    }
    emit('ready', status.ok)
  } finally {
    agentChecking.value = false
  }
}

async function copyStoragePath(): Promise<void> {
  if (!storagePath.value) return
  try {
    await navigator.clipboard.writeText(storagePath.value)
    ElMessage.success('存储目录已复制')
  } catch {
    ElMessage.warning('复制失败,请手动复制')
  }
}

function statusLabel(): string {
  if (agentChecking.value) return '检测中…'
  if (agent.ok) return `在线 ${agent.version ? `· v${agent.version}` : ''}`.trim()
  return agent.errorMessage ? `离线 · ${agent.errorMessage}` : '离线'
}

function statusClass(): string {
  if (agentChecking.value) return 'aip-chip aip-chip--muted'
  return agent.ok ? 'aip-chip aip-chip--success' : 'aip-chip aip-chip--danger'
}

defineExpose({
  reload: loadAgent,
  isReady: () => agent.ok
})

onMounted(loadAgent)
</script>

<template>
  <article class="aip-card">
    <header class="aip-card__header">
      <h3 class="aip-card__title">
        <span class="aip-card__title-icon">●</span>
        本地 Agent
      </h3>
      <span :class="statusClass()">{{ statusLabel() }}</span>
    </header>
    <p class="aip-card__caption">
      所有需求 / iteration / 公式 / Jira 凭证都存在本机
      <code class="aip-inline-code">~/.ai-productivity-tracker/data/</code>, 看板与上报全部通过
      daemon 读写本地数据。
      <template v-if="variant === 'mcp'">
        若 daemon 离线,下方 MCP / Hook / Skill 注入操作会一并失败。
      </template>
    </p>
    <div v-if="storagePath" class="aip-settings__inline">
      <span class="aip-settings__watcher-label">存储目录:</span>
      <code class="aip-inline-code aip-settings__path">{{ storagePath }}</code>
      <ElButton size="small" plain @click="copyStoragePath">复制</ElButton>
    </div>
    <div class="aip-settings__form-actions">
      <ElButton :loading="agentChecking" @click="loadAgent">刷新状态</ElButton>
    </div>
    <p v-if="!agent.ok && !agentChecking" class="aip-settings__error">
      Daemon 不在线: 请确认 ai-productivity-tracker daemon 已启动 (默认监听 127.0.0.1:17350)。
    </p>
  </article>
</template>

<style scoped>
.aip-settings__inline {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
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

.aip-settings__watcher-label {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 12.5px;
}

.aip-settings__path {
  max-width: 100%;
  overflow-wrap: anywhere;
}
</style>
