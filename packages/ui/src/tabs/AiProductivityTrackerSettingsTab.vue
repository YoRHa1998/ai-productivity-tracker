<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  ElButton,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElSlider,
  ElSwitch
} from 'element-plus'

import {
  fetchFormula,
  fetchJiraConfig,
  patchFormula,
  patchJiraConfig,
  type FormulaSettings,
  type JiraPluginConfigPayload
} from '../api'
import { useAgentContext } from '../composables/useAgentContext'
import '../styles/aip-shared.css'

const { state: agentState } = useAgentContext()
const agentReady = computed(() => agentState.value.agent.ok)
const initialized = ref(false)

const formula = reactive<FormulaSettings>({
  wThink: 0.7,
  tokenPenaltyEnabled: false,
  tokenSoftCapK: 200
})
const formulaSaving = ref(false)

// 滑块以「AI 工作时间权重 (%)」为单位展示,后端字段 wThink ∈ [0, 1]
const wThinkPercent = computed<number>({
  get: () => Math.round(formula.wThink * 100),
  set: (val: number) => {
    formula.wThink = Math.max(0, Math.min(1, val / 100))
  }
})
const wElapsedPercent = computed(() => 100 - wThinkPercent.value)

const jiraConfig = reactive<JiraPluginConfigPayload>({
  configured: false,
  baseUrl: '',
  apiEmail: '',
  bugJqlTemplate: ''
})
const jiraApiTokenInput = ref('')
const jiraSaving = ref(false)

async function loadFormula(): Promise<void> {
  try {
    Object.assign(formula, await fetchFormula())
  } catch (err) {
    ElMessage.error((err as Error).message || '加载公式失败')
  }
}

async function handleSaveFormula(): Promise<void> {
  formulaSaving.value = true
  try {
    const next = await patchFormula(formula)
    Object.assign(formula, next)
    ElMessage.success('公式已保存')
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    formulaSaving.value = false
  }
}

async function loadJiraConfig(): Promise<void> {
  try {
    Object.assign(jiraConfig, await fetchJiraConfig())
  } catch (err) {
    ElMessage.error((err as Error).message || '加载 Jira 配置失败')
  }
}

async function handleSaveJiraConfig(): Promise<void> {
  jiraSaving.value = true
  try {
    const patch: Partial<{
      baseUrl: string
      apiEmail: string
      apiToken: string
      bugJqlTemplate: string
    }> = {
      baseUrl: jiraConfig.baseUrl,
      apiEmail: jiraConfig.apiEmail,
      bugJqlTemplate: jiraConfig.bugJqlTemplate
    }
    if (jiraApiTokenInput.value) patch.apiToken = jiraApiTokenInput.value
    Object.assign(jiraConfig, await patchJiraConfig(patch))
    jiraApiTokenInput.value = ''
    ElMessage.success('Jira 配置已保存')
  } catch (err) {
    ElMessage.error((err as Error).message || '保存失败')
  } finally {
    jiraSaving.value = false
  }
}

// agent 在线后(useAgentContext 30s 轮询发现 daemon 起来)首次加载表单数据
watch(
  agentReady,
  async (ready) => {
    if (!ready || initialized.value) return
    initialized.value = true
    await Promise.allSettled([loadFormula(), loadJiraConfig()])
  },
  { immediate: true }
)
</script>

<template>
  <section class="aip-settings">
    <p v-if="!agentReady" class="aip-settings__offline aipt-glass">
      <span class="aipt-status-dot aipt-status-dot--danger"></span>
      <span>Daemon 当前离线,基础配置暂时无法读写。请到「设置 · Daemon 状态」检查并启动。</span>
    </p>

    <!-- 提效公式 -->
    <article class="aip-card aip-card--accent aip-formula">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon"><i class="i-lucide-sigma"></i></span>
          提效公式
        </h3>
      </header>
      <p class="aip-card__caption aip-formula__caption">
        <code class="aip-inline-code"
          >boost = manualEstimateMinutes / (effectiveMinutes &times; tokenPenalty)</code
        >。其中
        <code class="aip-inline-code"
          >effectiveMinutes = (1 &minus; wThink) &times; 墙钟 + wThink &times; (AI 工作累计 /
          60)</code
        >。 并行多任务时把权重往「AI 工作时间」推,可以削减墙钟空闲带来的误差;Token
        惩罚默认关闭,开启后超出软上限的部分按比例线性放大分母。
      </p>

      <section class="aip-formula__panel">
        <header class="aip-formula__legend">
          <span class="aip-formula__legend-title">时间权重</span>
          <span class="aip-formula__legend-hint">
            AI 工作 <strong>{{ wThinkPercent }}%</strong>
            <span class="aip-formula__legend-sep">·</span>
            墙钟 <strong>{{ wElapsedPercent }}%</strong>
          </span>
        </header>
        <div class="aip-formula__slider">
          <ElSlider
            v-model="wThinkPercent"
            :min="0"
            :max="100"
            :step="5"
            :disabled="!agentReady"
            :marks="{ 0: '0%', 25: '25%', 50: '50%', 75: '75%', 100: '100%' }"
          />
          <div class="aip-formula__slider-tips">
            <span>← 纯墙钟(单线程)</span>
            <span>50 / 50</span>
            <span>纯 AI 工作(强并行) →</span>
          </div>
        </div>
      </section>

      <section
        class="aip-formula__panel aip-formula__panel--token"
        :class="{ 'is-off': !formula.tokenPenaltyEnabled }"
      >
        <header class="aip-formula__legend">
          <span class="aip-formula__legend-title">Token 惩罚</span>
          <span class="aip-formula__legend-hint aip-formula__legend-hint--muted">
            可选 · 默认关闭
          </span>
        </header>
        <div class="aip-formula__token-row">
          <label class="aip-formula__switch">
            <ElSwitch v-model="formula.tokenPenaltyEnabled" :disabled="!agentReady" />
            <span>启用软上限惩罚</span>
          </label>
          <div class="aip-formula__cap">
            <span class="aip-formula__cap-label">软上限</span>
            <ElInputNumber
              v-model="formula.tokenSoftCapK"
              :precision="0"
              :step="10"
              :min="0"
              controls-position="right"
              :disabled="!agentReady || !formula.tokenPenaltyEnabled"
              size="default"
            />
            <span class="aip-formula__cap-unit">k tokens</span>
          </div>
        </div>
        <p class="aip-formula__token-hint">
          <code class="aip-inline-code"
            >tokenPenalty = 1 + max(0, tokens/1000 &minus; cap) / cap</code
          >。例:cap=100k、实际 300k → <strong>×3</strong>。
        </p>
      </section>

      <div class="aip-settings__form-actions">
        <ElButton
          type="primary"
          :loading="formulaSaving"
          :disabled="!agentReady"
          @click="handleSaveFormula"
        >
          保存公式
        </ElButton>
      </div>
    </article>

    <!-- Jira 凭证 -->
    <article class="aip-card aip-card--accent">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon"><i class="i-lucide-ticket"></i></span>
          Jira 查询凭证
        </h3>
        <span v-if="jiraConfig.configured" class="aip-chip aip-chip--success">已配置</span>
        <span v-else class="aip-chip aip-chip--muted">未配置</span>
      </header>
      <p class="aip-card__caption">
        看板「刷新 bug 数」按钮会由本地 agent 直接调 Jira REST,凭证仅存
        <code class="aip-inline-code">jira.json</code>。
      </p>
      <ElForm label-position="top" :disabled="!agentReady">
        <div class="aip-settings__grid">
          <ElFormItem label="Jira Base URL">
            <ElInput v-model="jiraConfig.baseUrl" placeholder="https://yourorg.atlassian.net" />
            <p class="aip-card__caption aip-card__caption--inline">
              必须包含协议;漏写
              <code class="aip-inline-code">https://</code> 时保存会自动补齐,并去掉尾部
              <code class="aip-inline-code">/</code>。
            </p>
          </ElFormItem>
          <ElFormItem label="API Email">
            <ElInput v-model="jiraConfig.apiEmail" placeholder="account@company.com" />
          </ElFormItem>
          <ElFormItem label="API Token">
            <ElInput
              v-model="jiraApiTokenInput"
              type="password"
              show-password
              :placeholder="
                jiraConfig.configured ? '已配置,留空表示不变' : '粘贴 Atlassian API Token'
              "
            />
          </ElFormItem>
          <ElFormItem label="Bug JQL 模板">
            <ElInput
              v-model="jiraConfig.bugJqlTemplate"
              placeholder='issuetype = Bug AND "Epic Link" = {{jiraKey}}'
            />
            <p class="aip-card__caption aip-card__caption--inline">
              Atlassian 新接口要求 JQL 必须含
              <code class="aip-inline-code">project=</code> 等限制字段; 若模板未指定,agent 会按
              jiraKey 前缀自动追加
              <code class="aip-inline-code">AND project = &lt;项目码&gt;</code> 兜底。
            </p>
          </ElFormItem>
        </div>
        <p class="aip-card__caption">
          JQL 中使用 <code class="aip-inline-code">&#123;&#123;jiraKey&#125;&#125;</code> 占位符,
          agent 会自动替换为当前需求的 Jira Key。
        </p>
        <div class="aip-settings__form-actions">
          <ElButton
            type="primary"
            :loading="jiraSaving"
            :disabled="!agentReady"
            @click="handleSaveJiraConfig"
          >
            保存 Jira 配置
          </ElButton>
        </div>
      </ElForm>
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

.aip-settings__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--aipt-space-3) var(--aipt-space-4);
}

.aip-settings__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--aipt-space-2);
  margin-top: var(--aipt-space-3);
}

/* ===== 提效公式专属布局 ===== */

.aip-formula__caption {
  margin-bottom: var(--aipt-space-3);
}

.aip-formula__panel {
  margin: 0 0 var(--aipt-space-3);
  padding: var(--aipt-space-3) var(--aipt-space-4) var(--aipt-space-4);
  border: 1px solid var(--aipt-border);
  border-radius: var(--aipt-radius-md);
  background: var(--aipt-surface-soft, rgba(255, 255, 255, 0.45));
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
}

.aip-formula__panel:last-of-type {
  margin-bottom: 0;
}

.aip-formula__panel.is-off {
  background: transparent;
}

.aip-formula__panel.is-off .aip-formula__token-hint {
  opacity: 0.55;
}

.aip-formula__legend {
  display: inline-flex;
  align-items: baseline;
  gap: var(--aipt-space-2);
  padding: 0 var(--aipt-space-2);
  margin-left: calc(-1 * var(--aipt-space-2));
}

.aip-formula__legend-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aipt-text-strong, var(--aipt-text));
}

.aip-formula__legend-hint {
  font-size: 12px;
  color: var(--aipt-text-secondary);
}

.aip-formula__legend-hint strong {
  font-weight: 600;
  color: var(--aipt-text-strong, var(--aipt-text));
  font-variant-numeric: tabular-nums;
}

.aip-formula__legend-hint--muted {
  color: var(--aipt-text-muted);
}

.aip-formula__legend-sep {
  margin: 0 4px;
  color: var(--aipt-text-muted);
}

.aip-formula__slider {
  padding: 0 12px;
  margin-top: 6px;
}

.aip-formula__slider :deep(.el-slider__marks-text) {
  font-size: 11px;
  color: var(--aipt-text-muted);
  font-variant-numeric: tabular-nums;
}

.aip-formula__slider :deep(.el-slider) {
  --el-slider-main-bg-color: var(--aipt-aurora-2, #4f7cff);
  margin-bottom: 4px;
}

.aip-formula__slider-tips {
  display: flex;
  justify-content: space-between;
  margin-top: 24px;
  font-size: 12px;
  color: var(--aipt-text-muted);
}

.aip-formula__slider-tips span:nth-child(2) {
  color: var(--aipt-text-secondary);
}

.aip-formula__token-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--aipt-space-3) var(--aipt-space-5, 24px);
  margin-top: 4px;
}

.aip-formula__switch {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
  font-size: 13px;
  color: var(--aipt-text-strong, var(--aipt-text));
  cursor: pointer;
  user-select: none;
}

.aip-formula__cap {
  display: inline-flex;
  align-items: center;
  gap: var(--aipt-space-2);
  font-size: 13px;
  color: var(--aipt-text-secondary);
}

.aip-formula__cap-label {
  color: var(--aipt-text-muted);
}

.aip-formula__cap-unit {
  color: var(--aipt-text-muted);
  font-variant-numeric: tabular-nums;
}

.aip-formula__cap :deep(.el-input-number) {
  width: 140px;
}

.aip-formula__token-hint {
  margin: var(--aipt-space-3) 0 0;
  padding: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--aipt-text-muted);
  word-break: break-word;
}

.aip-formula__token-hint strong {
  font-weight: 600;
  color: var(--aipt-text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .aip-settings__grid {
    grid-template-columns: 1fr;
  }

  .aip-formula__slider-tips {
    font-size: 11px;
  }
}
</style>
