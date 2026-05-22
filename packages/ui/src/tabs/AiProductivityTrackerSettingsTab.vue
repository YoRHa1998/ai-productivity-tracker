<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElButton, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage } from 'element-plus'

import {
  fetchFormula,
  fetchJiraConfig,
  patchFormula,
  patchJiraConfig,
  type FormulaSettings,
  type JiraPluginConfigPayload
} from '../api'
import AipAgentStatusCard from '../components/AipAgentStatusCard.vue'
import '../styles/aip-shared.css'

const agentReady = ref(false)

const formula = reactive<FormulaSettings>({
  kBug: 0.15,
  kToken: 0.05,
  tokenPriceUsdPer1k: 0.01,
  hourlyCostUsd: 40
})
const formulaSaving = ref(false)

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

async function handleAgentReady(ready: boolean): Promise<void> {
  agentReady.value = ready
  if (!ready) return
  await Promise.allSettled([loadFormula(), loadJiraConfig()])
}

onMounted(() => {
  // AipAgentStatusCard 的 onMounted 会触发 emit('ready', ...) 由 handleAgentReady 处理。
  // 这里无需额外初始化,保留生命周期钩子用于未来扩展。
})
</script>

<template>
  <section class="aip-settings">
    <AipAgentStatusCard variant="business" @ready="handleAgentReady" />

    <!-- 提效公式 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">∑</span>
          提效公式
        </h3>
      </header>
      <p class="aip-card__caption">
        提效倍数 = manualEstimateMinutes / (elapsedMinutes × bugPenalty × tokenPenalty)。 bugPenalty
        = 1 + linkedBugCount × k_bug;tokenPenalty = 1 + (cost / hourly × 60) × k_token。
      </p>
      <ElForm label-position="top" :disabled="!agentReady">
        <div class="aip-settings__grid">
          <ElFormItem label="k_bug (Bug 惩罚系数)">
            <ElInputNumber v-model="formula.kBug" :precision="3" :step="0.01" :min="0" />
          </ElFormItem>
          <ElFormItem label="k_token (Token 惩罚系数)">
            <ElInputNumber v-model="formula.kToken" :precision="3" :step="0.01" :min="0" />
          </ElFormItem>
          <ElFormItem label="tokenPriceUsdPer1k">
            <ElInputNumber
              v-model="formula.tokenPriceUsdPer1k"
              :precision="4"
              :step="0.001"
              :min="0"
            />
          </ElFormItem>
          <ElFormItem label="hourlyCostUsd">
            <ElInputNumber v-model="formula.hourlyCostUsd" :precision="2" :step="1" :min="0" />
          </ElFormItem>
        </div>
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
      </ElForm>
    </article>

    <!-- Jira 凭证 -->
    <article class="aip-card">
      <header class="aip-card__header">
        <h3 class="aip-card__title">
          <span class="aip-card__title-icon">J</span>
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
  gap: 16px;
  padding: 24px;
}

.aip-settings__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.aip-settings__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
