import type {
  HarnessScope,
  HarnessSuggestionCategory,
  RetrospectiveHarnessSuggestion
} from '../api'

/**
 * harness 护栏建议的看板展示元数据 + Markdown 序列化,供
 * RetrospectiveReportPanel(单需求复盘报告)与复盘经验页 harness 视图共享,
 * 与 core 端 `HarnessSuggestionCategory` 严格对齐。
 */

/** 6 个 category 的固定展示顺序(对齐 core HARNESS_SUGGESTION_CATEGORIES) */
export const HARNESS_CATEGORY_ORDER: readonly HarnessSuggestionCategory[] = [
  'guardrail-rule',
  'check-script',
  'checklist',
  'baseline',
  'manifest',
  'self-evolution'
]

export const HARNESS_CATEGORY_LABEL: Record<HarnessSuggestionCategory, string> = {
  'guardrail-rule': '硬护栏规则',
  'check-script': '检查脚本',
  checklist: '自检清单',
  baseline: '存量债基线',
  manifest: '治理清单',
  'self-evolution': '自进化约定'
}

export const HARNESS_CATEGORY_CHIP: Record<HarnessSuggestionCategory, string> = {
  'guardrail-rule': 'aip-chip--primary',
  'check-script': 'aip-chip--success',
  checklist: 'aip-chip--warning',
  baseline: 'aip-chip--muted',
  manifest: 'aip-chip--primary',
  'self-evolution': 'aip-chip--muted'
}

/** 下拉筛选用 options(按固定顺序) */
export const HARNESS_CATEGORY_OPTIONS: ReadonlyArray<{
  value: HarnessSuggestionCategory
  label: string
}> = HARNESS_CATEGORY_ORDER.map((value) => ({ value, label: HARNESS_CATEGORY_LABEL[value] }))

/** scope 展示文案(项目专属时由调用方拼 projectSlug) */
export const HARNESS_SCOPE_LABEL: Record<Exclude<HarnessScope, ''>, string> = {
  general: '通用',
  project: '项目专属'
}

export const HARNESS_SCOPE_CHIP: Record<HarnessScope, string> = {
  general: 'aip-chip--success',
  project: 'aip-chip--muted',
  '': 'aip-chip--muted'
}

/** scope 归一化:把缺省 / 非法值收敛成 ''(老数据未分类)。 */
export function normalizeHarnessScope(scope: HarnessScope | undefined): HarnessScope {
  return scope === 'general' || scope === 'project' ? scope : ''
}

/** harness scope 展示文案:通用 / 项目专属(带 slug)/ 未分类。 */
export function harnessScopeLabel(scope: HarnessScope | undefined, projectSlug?: string): string {
  const s = normalizeHarnessScope(scope)
  if (s === 'general') return '通用'
  if (s === 'project') return projectSlug ? `项目: ${projectSlug}` : '项目专属'
  return '未分类'
}

/** 把单条护栏建议序列化成可直接贴进项目 harness 的 Markdown 片段。 */
export function buildSuggestionMarkdown(s: RetrospectiveHarnessSuggestion): string {
  const lines: string[] = [`### [${HARNESS_CATEGORY_LABEL[s.category]}] ${s.title}`, '']
  const scope = normalizeHarnessScope(s.scope)
  if (scope) lines.push(`- 适用范围: ${harnessScopeLabel(scope, s.projectSlug)}`)
  if (s.signal) lines.push(`- 触发信号: ${s.signal}`)
  if (s.targetFile) lines.push(`- 建议落到: \`${s.targetFile}\``)
  if (s.anchorSeqs && s.anchorSeqs.length) {
    lines.push(`- 关联轮次: ${s.anchorSeqs.map((n) => `#${n}`).join(' ')}`)
  }
  lines.push('', s.content)
  return lines.join('\n')
}
