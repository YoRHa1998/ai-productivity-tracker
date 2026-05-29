import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  AgentClient,
  AgentClientError,
  type LessonInputForSave,
  type RetrospectiveNarrativeInput,
  type SaveRetrospectiveResult
} from './agent-client.js'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [x: string]: unknown
}

const initInputShape = {
  jira: z.string().min(1).describe('Jira issue URL(https://...) 或裸 issueKey(如 ABC-123)'),
  title: z
    .string()
    .optional()
    .describe(
      '需求标题。**强烈建议传 Jira issue summary 的真实标题**(可由 user-jira MCP `jira_get_issue` 拿到 fields.summary);仅在确实拿不到时省略,agent 会先尝试用本地 jira-config 二次拉取,再次失败才回退到 jiraKey。直接传 jiraKey 视为低质量调用,看板会标「未同步」并自动后台修正。'
    ),
  projectRoot: z
    .string()
    .optional()
    .describe('业务项目 git 根目录绝对路径;不传时使用 agent 进程 cwd'),
  summary: z.string().optional(),
  manualEstimateMinutes: z.number().int().positive().optional().describe('人工预估分钟数'),
  complexity: z.enum(['low', 'medium', 'high']).optional()
}

const statusInputShape = {
  projectRoot: z.string().optional().describe('业务项目 git 根目录绝对路径')
}

const attachSummaryInputShape = {
  oneLine: z
    .string()
    .min(1)
    .describe(
      '一句话总结本轮对话,目标 ≤120 字(超出 agent 会静默截断到 120 字,不会失败)。事实陈述,不带 emoji 或夸张形容词'
    ),
  type: z
    .enum(['coding', 'communication'])
    .optional()
    .describe(
      '对话类型(可选,缺省时 agent 端默认 communication):coding=本轮涉及代码改动(Write/Edit/Bash 等),communication=纯沟通讨论'
    ),
  changeScope: z
    .string()
    .optional()
    .describe(
      '改动范围简述,目标 ≤120 字(超出 agent 会静默截断到 120 字,不会失败)。type=coding 时必填,概述改动了哪些模块/文件、影响范围'
    ),
  discussion: z
    .string()
    .optional()
    .describe(
      '讨论内容简述,目标 ≤300 字(超出 agent 会静默截断到 300 字,不会失败)。type=communication 时必填,概述本轮讨论的话题与结论'
    ),
  jiraKey: z.string().optional().describe('需求 jiraKey,缺省时从 branch 解析'),
  branch: z.string().optional().describe('当前分支名;agent 会从分支名解析 issueKey'),
  source: z
    .enum(['cursor', 'claude-code'])
    .optional()
    .describe(
      '调用方 AI 工具来源,由 skill 模板硬编码:CURSOR_RULE.md 传 cursor,SKILL.md 传 claude-code。仅在 target iteration 缺失 source 时被回填,不覆盖 Hook/Watcher 已写入的值'
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      '当前工作目录,通常无需主动传;MCP 客户端会自动从 CLAUDE_PROJECT_DIR / CURSOR_PROJECT_DIR / process.cwd() 推断,供 agent 端 jiraKey 兜底解析使用'
    )
}

function formatInit(result: { jiraKey: string; branch: string; panelUrl: string }): string {
  return [
    `已创建需求并绑定当前分支(数据已写入本机 ~/.ai-productivity-tracker/data/${result.jiraKey}/)`,
    `- Jira Key: ${result.jiraKey}`,
    `- branch: ${result.branch}`,
    `- 面板: ${result.panelUrl}`
  ].join('\n')
}

function formatStatus(result: {
  bound: boolean
  branch: string | null
  issueKey: string | null
  jiraKey?: string | null
  cumulativeToken?: number
  gitRoot: string | null
}): string {
  if (!result.gitRoot) return '当前目录不是 git 仓库,无法识别需求绑定'
  if (!result.issueKey) {
    return [
      `git root: ${result.gitRoot}`,
      `branch: ${result.branch}`,
      `当前分支不包含 Jira issueKey,不会上报指标`
    ].join('\n')
  }
  if (!result.bound) {
    return [
      `branch: ${result.branch}  (issueKey: ${result.issueKey})`,
      `尚未通过 ai_productivity_init 创建需求绑定`
    ].join('\n')
  }
  return [
    `branch: ${result.branch}`,
    `issueKey: ${result.issueKey}`,
    `jiraKey: ${result.jiraKey ?? result.issueKey}`,
    `累计 token: ${result.cumulativeToken ?? 0}`
  ].join('\n')
}

// ─── v2.16.0 lessons-extract skill: bundle / save ───────────────────────

const extractBundleInputShape = {
  jiraKey: z
    .string()
    .min(1)
    .describe(
      '需求 Jira Key(如 ABC-1234)。skill 应优先从当前 git 分支正则解析后传入;agent 会用 jiraKey 拉 requirement.json + 全部 iterations + 已有 lessons.'
    ),
  cwd: z
    .string()
    .optional()
    .describe('当前工作目录,通常无需主动传(同 attach_summary 的 cwd 兜底逻辑)')
}

const lessonInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('显式 id(覆盖式更新场景);缺省时 agent 自动生成 lsn-<jiraKey>-<random>'),
  jiraKey: z.string().min(1).describe('该条经验来自的需求 Jira Key,通常与 body.jiraKey 一致'),
  jiraTitle: z
    .string()
    .optional()
    .describe('需求标题冗余存储,缺省时 agent 从 requirement.json 兜底'),
  type: z
    .enum(['pitfall', 'rule', 'best-practice', 'split-suggestion', 'tooling'])
    .describe(
      'pitfall=踩的坑;rule=沉淀的规则;best-practice=最佳实践;split-suggestion=对话拆分/合并建议;tooling=工具链改进'
    ),
  title: z
    .string()
    .min(1)
    .describe('短标题,目标 ≤80 字(超出 agent 静默截断到 200);事实陈述,不带 emoji 与情绪词'),
  content: z
    .string()
    .min(1)
    .describe(
      '主体内容,目标 ≤500 字(超出 agent 静默截断到 4000);独立可读,不引用 jiraKey 内部上下文'
    ),
  rootCause: z.string().optional().describe('根因(pitfall 强烈建议填)'),
  fix: z.string().optional().describe('修复 / 改进建议'),
  reusableWhen: z.string().optional().describe('复用条件,描述什么场景下应当回想起本条经验'),
  tags: z
    .array(z.string())
    .optional()
    .describe('技术栈 / 模块 / 语义标签,用于看板筛选(如 jira / cors / vue / watcher)'),
  affectedFiles: z.array(z.string()).optional().describe('涉及到的关键文件路径(仓库相对)'),
  iterationSeqs: z
    .array(z.number().int().positive())
    .optional()
    .describe('引用的 iteration seq 列表,用于看板跳回相应轮次锚点'),
  trust: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('可信度:high=用户主动触发提取(默认),medium=自动定期扫描,low=待人工复核'),
  scope: z
    .enum(['general', 'project'])
    .optional()
    .describe(
      'v2.17.0 经验作用域:general=与具体项目无关的通用知识(技术栈/外部 API/JS|TS 基础陷阱,脱离项目仍可复用);project=本项目专属(引用项目模块/特有架构/特有命名/特有约束);缺省时 agent 默认 project(保守)'
    ),
  projectSlug: z
    .string()
    .optional()
    .describe(
      'v2.17.0 项目标识(=package.json name);scope="project" 时必填,直接传 extract_bundle 返回的 currentProjectSlug;scope="general" 时强制为空。缺省时 agent 按 jiraKey 反查 requirement.projectSlug 兜底'
    )
})

const saveLessonsInputShape = {
  jiraKey: z.string().min(1).describe('需求 Jira Key,缺省时每条 lesson 必须自带 jiraKey'),
  lessons: z
    .array(lessonInputSchema)
    // v2.17.0 允许空数组:本轮如果确实没有可沉淀的经验(看完 bundle 后所有维度都没信号),
    // 直接传 lessons:[] 让 agent 静默落盘空结果,**禁止凑数**。详见 lessons-extract skill 模板。
    .min(0)
    .describe(
      'LLM 推理出的多维度经验数组;若本需求确无可沉淀经验,允许传空数组,agent 会静默处理,**不要硬凑**'
    ),
  projectSlug: z
    .string()
    .optional()
    .describe(
      'v2.17.0 批次维度 projectSlug 兜底:批量所有 lesson 漏填 projectSlug 时由此统一兜底,优先级低于 lesson 自身字段;skill 模板通常应在每条 lesson 内显式填,此字段仅作兼容'
    )
}

interface FormatBundleComputedSignals {
  boost: number | null
  linkedBugCount: number | null
  cumulativeEffectiveTokens: number
  cumulativeThinkSeconds: number
  fileChurnMap: Array<{
    path: string
    insertions: number
    deletions: number
    touchedSeqs: number[]
  }>
  abnormalStopReasons: Array<{ reason: string; seqs: number[] }>
  topThinkSeqs: number[]
}

function formatTokensShort(n: number): string {
  if (!n || n <= 0) return '0'
  if (n < 1_000) return `${n}`
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function formatThinkShort(sec: number): string {
  if (!sec || sec <= 0) return '0s'
  if (sec < 60) return `${Math.round(sec)}s`
  const m = sec / 60
  if (m < 60) return `${m.toFixed(1)}min`
  return `${(m / 60).toFixed(1)}h`
}

function buildComputedSignalsBlock(signals: FormatBundleComputedSignals | undefined): string[] {
  if (!signals) return []
  const lines: string[] = ['=== 客观信号(供 LLM 推理参考)===']
  const boostLabel =
    signals.boost == null
      ? 'boost: (无人工预估或未跑过 iteration)'
      : `boost: ${signals.boost.toFixed(2)}x`
  const bugLabel =
    signals.linkedBugCount == null
      ? 'linkedBugCount: 未刷新'
      : `linkedBugCount: ${signals.linkedBugCount}`
  lines.push(`${boostLabel} | ${bugLabel}`)
  lines.push(
    `累计 effectiveTokens: ${formatTokensShort(signals.cumulativeEffectiveTokens)} | ` +
      `累计 thinkSeconds: ${formatThinkShort(signals.cumulativeThinkSeconds)}`
  )
  if (signals.abnormalStopReasons.length) {
    const detail = signals.abnormalStopReasons
      .map((r) => `${r.reason}(轮次 ${r.seqs.map((s) => `#${s}`).join(',')})`)
      .join(' / ')
    lines.push(`异常 stopReason: ${detail}`)
  } else {
    lines.push('异常 stopReason: 无')
  }
  if (signals.topThinkSeqs.length) {
    lines.push(
      `top 3 思考时长轮次: ${signals.topThinkSeqs.map((s) => `#${s}`).join(' ')} — 大概率是难点,优先扫`
    )
  }
  if (signals.fileChurnMap.length) {
    lines.push('反复修改文件(top 5,touchedSeqs 多者优先,为 pitfall 候选):')
    for (const f of signals.fileChurnMap) {
      const seqStr = f.touchedSeqs.map((s) => `#${s}`).join(',')
      const diffStr = f.insertions + f.deletions > 0 ? ` +${f.insertions} -${f.deletions}` : ''
      lines.push(`  - ${f.path} (${f.touchedSeqs.length}轮${diffStr}, ${seqStr})`)
    }
  }
  lines.push('')
  return lines
}

function formatExtractBundle(result: {
  jiraKey: string
  currentProjectSlug?: string
  requirement: unknown
  iterations: unknown[]
  existingLessons: unknown[]
  computedSignals?: FormatBundleComputedSignals
}): string {
  const projectSlug = result.currentProjectSlug?.trim() || '(未识别)'
  const lines = [
    `已拉取 ${result.jiraKey} 历史数据包,可直接基于以下信息抽取经验。`,
    '',
    `currentProjectSlug: ${projectSlug}  // scope='project' 时填到 lesson.projectSlug`,
    `iterations: ${Array.isArray(result.iterations) ? result.iterations.length : 0} 条`,
    `existingLessons: ${Array.isArray(result.existingLessons) ? result.existingLessons.length : 0} 条(已过滤为「通用+当前项目」,请去重避免重复落盘)`,
    ''
  ]
  lines.push(...buildComputedSignalsBlock(result.computedSignals))
  lines.push('BUNDLE_JSON_BEGIN', JSON.stringify(result, null, 2), 'BUNDLE_JSON_END')
  return lines.join('\n')
}

// ─── v1.0.0-rc.23 retrospective-report skill: bundle / save ─────────────

const extractRetroBundleInputShape = {
  jiraKey: z
    .string()
    .min(1)
    .describe(
      '需求 Jira Key(如 ABC-1234)。skill 应优先从当前 git 分支正则解析后传入;agent 会用 jiraKey 拉 requirement.json + 全部 iterations + 关联 lessons + 已存在的复盘报告。'
    ),
  cwd: z
    .string()
    .optional()
    .describe('当前工作目录,通常无需主动传(同 attach_summary 的 cwd 兜底逻辑)')
}

const retroPhaseSchema = z.object({
  title: z.string().min(1).describe('阶段标题,目标 ≤80 字'),
  iterationSeqRange: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .describe('该阶段覆盖的 iteration seq 闭区间 [from, to];超出实际 iteration 范围会被静默过滤'),
  summary: z.string().describe('阶段叙事(markdown / plain text),目标 ≤400 字')
})

const retroNarrativeSchema = z.object({
  overview: z
    .string()
    .min(1)
    .describe(
      '一段话总览(目标 ≤600 字,超出会被静默截断)。事实陈述,概括本需求的开发节奏 / boost 表现 / 主要难点。**严禁为空**(空叙事请勿调用,直接告知用户「本需求 iteration 数过少,暂不生成复盘」)'
    ),
  phases: z
    .array(retroPhaseSchema)
    .max(8)
    .describe(
      '阶段拆分(最多 8 段)。把全部 iterations 按主题分段,例如「设计与拆分」「实现」「调试与修复」。每段 iterationSeqRange 必须落在实际 seq 范围内'
    ),
  highlights: z
    .array(z.string())
    .max(8)
    .describe(
      '亮点(最多 8 条,每条 ≤300 字)。例如「topThinkSeqs 对应轮次一气呵成」「changeScope 干净不漂移」'
    ),
  issues: z
    .array(z.string())
    .max(8)
    .describe('暴露的问题(最多 8 条)。例如「watcher 漏抓导致一轮 conversationSummary null」'),
  improvements: z
    .array(z.string())
    .max(8)
    .describe('改进建议(最多 8 条)。指向具体可落地动作,不是空洞口号'),
  pitfallsObserved: z
    .array(z.string())
    .max(8)
    .describe('观察到的坑(最多 8 条)。可与 lessons pitfall 类型联动'),
  nextSteps: z.array(z.string()).max(8).describe('下次类似需求的预热建议(最多 8 条)'),
  splitSuggestions: z.array(z.string()).max(8).optional().describe('对话拆分建议(可选,最多 8 条)')
})

const harnessSuggestionSchema = z.object({
  category: z
    .enum(['guardrail-rule', 'check-script', 'checklist', 'baseline', 'manifest', 'self-evolution'])
    .describe(
      '护栏类别:guardrail-rule=写进 guardrails.md 的硬护栏 / check-script=可脚本化的静态检查 / checklist=人工自检项 / baseline=存量债登记 / manifest=治理边界调整 / self-evolution=触发时机或入口约定'
    ),
  scope: z
    .enum(['general', 'project'])
    .optional()
    .describe(
      '适用范围:general=通用护栏(跨项目/AI 协作元规则,如 stale_timeout→session-handoff、上下文偏长切窗),project=本仓库架构专属护栏(如某 store/composable 收口约定)。缺省按 project 兜底。判定不清优先 project'
    ),
  projectSlug: z
    .string()
    .optional()
    .describe(
      'scope=project 时的项目标识(=package.json name,取 bundle 的 currentProjectSlug);scope=general 留空或省略,缺省时 agent 端按需求 projectSlug 兜底'
    ),
  title: z.string().describe('一句话标题(≤80 字)。写成持久不变式,不要带本次轮次/事件描述'),
  signal: z
    .string()
    .describe('触发该建议的本需求失败信号(≤200 字),例如反复改某文件 / 踩的工具坑 / 卡点'),
  content: z
    .string()
    .describe('可落地内容(≤600 字):规则文字 / 脚本片段 / checklist 条目,直接可贴进 harness'),
  targetFile: z
    .string()
    .optional()
    .describe(
      '建议落到的 harness 目标文件(可选),例如 docs/ai/harness/technical-harness-guardrails.md'
    ),
  anchorSeqs: z
    .array(z.number().int().positive())
    .max(8)
    .optional()
    .describe('关联 iteration seq(可选,≤8 个)。超出实际范围的会被静默过滤')
})

const retroHarnessSchema = z.object({
  overview: z.string().optional().describe('一句话总览本需求可沉淀的 harness 方向(可选,≤400 字)'),
  suggestions: z
    .array(harnessSuggestionSchema)
    .max(12)
    .describe('结构化护栏建议(最多 12 条)。无可沉淀的 harness 约束时传空数组,禁止凑数')
})

const saveRetrospectiveInputShape = {
  jiraKey: z.string().min(1).describe('需求 Jira Key,与 extract_retro_bundle 入参一致'),
  narrative: retroNarrativeSchema.describe('LLM 推理产物的结构化叙事'),
  source: z
    .enum(['cursor', 'claude-code'])
    .optional()
    .describe(
      '调用方 AI 工具来源,由 SKILL/Rule 模板硬编码:CURSOR_RULE.md 传 cursor,SKILL.md 传 claude-code,缺省 manual'
    ),
  referencedLessonIds: z
    .array(z.string())
    .max(32)
    .optional()
    .describe(
      '复盘里引用的 lesson id 列表,从 extract_retro_bundle 返回的 relatedLessons 中精选。**只引用本需求已沉淀的经验,跨需求 / 不存在的 id 会被静默过滤**'
    ),
  anchorIterationSeqs: z
    .array(z.number().int().positive())
    .max(16)
    .optional()
    .describe(
      '报告引用的关键 iteration seq(高 think / 高 churn / 异常 stop 的轮次)。**超出实际 iteration 范围的 seq 会被静默过滤**'
    ),
  harnessSummary: retroHarnessSchema
    .optional()
    .describe(
      '【Harness 总结】可落地的工程护栏建议:把本需求暴露的失败信号(反复改的文件 / 踩的工具坑 / 卡点 / 异常中断)转译成可直接配置进项目 harness 的结构化建议。无可沉淀约束时省略或传空 suggestions,禁止凑数'
    )
}

interface FormatRetroRelatedLesson {
  id: string
  type: string
  title: string
  scope: string
  projectSlug: string
  hitCount: number
}

function formatRetroBundle(result: {
  jiraKey: string
  currentProjectSlug?: string
  requirement: unknown
  iterations: unknown[]
  computedSignals?: FormatBundleComputedSignals
  relatedLessons?: FormatRetroRelatedLesson[]
  existingRetrospective?: unknown
}): string {
  const projectSlug = result.currentProjectSlug?.trim() || '(未识别)'
  const lines = [
    `已拉取 ${result.jiraKey} 复盘数据包,可直接基于以下信息生成结构化复盘报告。`,
    '',
    `currentProjectSlug: ${projectSlug}`,
    `iterations: ${Array.isArray(result.iterations) ? result.iterations.length : 0} 条`,
    `relatedLessons: ${Array.isArray(result.relatedLessons) ? result.relatedLessons.length : 0} 条(本需求已沉淀的经验,supplyreferencedLessonIds 时从这里挑)`,
    result.existingRetrospective
      ? '已存在历史复盘报告(避免无变化重复落盘,有显著新增 iteration 才覆盖)'
      : '本需求尚未生成过复盘报告',
    ''
  ]
  lines.push(...buildComputedSignalsBlock(result.computedSignals))
  lines.push('RETRO_BUNDLE_JSON_BEGIN', JSON.stringify(result, null, 2), 'RETRO_BUNDLE_JSON_END')
  return lines.join('\n')
}

function formatSaveRetrospective(result: SaveRetrospectiveResult): string {
  const phaseCount = result.narrative.phases.length
  const highlights = result.narrative.highlights.length
  const issues = result.narrative.issues.length
  const lines = [
    `已落盘需求 ${result.jiraKey} 的复盘报告(基于第 ${result.generatedAtIterationSeq} 轮 / 共 ${result.generatedAtIterationCount} 轮 iteration)`,
    `- 叙事:${phaseCount} 个阶段、${highlights} 条亮点、${issues} 条问题`,
    `- 引用经验:${result.referencedLessonIds.length} 条`,
    `- 锚点 iteration:${result.anchorIterationSeqs.length} 个`,
    '',
    '可在「AI 提效面板 → 需求详情 → 复盘报告」Tab 浏览。'
  ]
  return lines.join('\n')
}

function formatSaveLessons(result: {
  saved: Array<{ id: string; type: string; title: string }>
  savedCount: number
  replaced: string[]
  rejected: Array<{ index: number; reason: string }>
}): string {
  // v2.17.0 空数组路径:lessons:[] 表示"本轮无可沉淀经验",明确告知用户而不是无意义的 "已落盘 0 条"
  if (result.savedCount === 0 && result.rejected.length === 0) {
    return [
      '本轮未沉淀新经验(lessons:[])。',
      '原因可能是本需求未出现反复 bugfix / 强约束 / 高 boost 最佳实践 / 对话拆分 / 工具链改进等可复用信号。',
      '如认为有遗漏,可补充上下文后再次触发「经验提取」。'
    ].join('\n')
  }
  const lines = [`已落盘 ${result.savedCount} 条经验。`]
  if (result.replaced.length)
    lines.push(`覆盖式更新: ${result.replaced.length} 条 (${result.replaced.join(', ')})`)
  if (result.rejected.length) {
    lines.push(`拒收: ${result.rejected.length} 条`)
    for (const r of result.rejected) lines.push(`  - #${r.index}: ${r.reason}`)
  }
  if (result.saved.length) {
    lines.push('已写入:')
    for (const s of result.saved.slice(0, 10)) lines.push(`  - [${s.type}] ${s.title} (${s.id})`)
    if (result.saved.length > 10) lines.push(`  ... 共 ${result.saved.length} 条`)
  }
  lines.push('', '可在「AI 提效面板 → 复盘经验」Tab 浏览全部经验。')
  return lines.join('\n')
}

function formatAttachSummary(result: {
  updated: boolean
  pending?: boolean
  skipped?: boolean
  jiraKey: string
  iterationSeq: number | null
  reason?: 'no_iteration' | 'only_init' | 'write_failed' | 'no_jira_key'
}): string {
  // v2.7.0:pending consume 模型下,总结写入 pending-summary.json 后即视作上报成功;
  // 下一条 iteration 写盘时会消费 pending 自动挂载,所以这里不再返回 iterationSeq。
  if (result.updated) {
    return `attached jiraKey=${result.jiraKey} (pending, will land on next iteration)`
  }
  // v2.13.0:skipped 场景(目前只有 no_jira_key,即 LLM 在非 Jira 分支误调)文案与
  // 普通 skipped 一致,但 jiraKey 为空串。LLM 看到这条文案应当理解为「本轮根本不该调」。
  if (result.skipped) {
    return `skipped reason=${result.reason ?? 'no_jira_key'} (本轮不该调用 attach_summary,当前分支不含 Jira issue key)`
  }
  const reasonHint = result.reason ?? 'not_found'
  return `skipped jiraKey=${result.jiraKey} reason=${reasonHint}`
}

function errorResult(err: unknown): ToolResult {
  let message: string
  if (err instanceof AgentClientError) {
    message = `调用本地 agent 失败 (status=${err.status}): ${err.message}`
    if (err.status === 0) {
      message +=
        '\n\n下一步:本地 ai-productivity-tracker daemon 似乎没有运行。请运行 `ai-productivity-tracker doctor` 自检,或 `ai-productivity-tracker daemon` 手动启动,确认 daemon 在线后再次调用本工具。'
    } else if (err.status === 401) {
      message +=
        '\n\n下一步:IDE 的 MCP JSON 里的 token 与 `~/.ai-productivity-tracker/runtime.json` 中的 `token` 不一致(通常发生在 daemon 重生 token 后)。可重启 daemon + IDE 让 token 重新对齐;或在 MCP JSON 里用最新 token。'
    }
  } else if (err instanceof Error) {
    message = err.message
  } else {
    message = 'unknown error'
  }
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function registerAiProductivityTools(server: McpServer, client: AgentClient): void {
  server.registerTool(
    'ai_productivity_init',
    {
      description: '基于 Jira URL 或 issueKey 创建提效追踪需求,并绑定当前分支',
      inputSchema: initInputShape
    },
    async (args: z.infer<z.ZodObject<typeof initInputShape>>): Promise<ToolResult> => {
      try {
        const result = await client.init({
          jiraInput: args.jira,
          title: args.title,
          projectRoot: args.projectRoot,
          summary: args.summary,
          manualEstimateMinutes: args.manualEstimateMinutes,
          complexity: args.complexity
        })
        return { content: [{ type: 'text', text: formatInit(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
    'ai_productivity_status',
    {
      description: '查看当前分支的 AI 提效追踪状态(是否已绑定需求、累计 token)',
      inputSchema: statusInputShape
    },
    async (args: z.infer<z.ZodObject<typeof statusInputShape>>): Promise<ToolResult> => {
      try {
        const result = await client.status({ projectRoot: args.projectRoot })
        return { content: [{ type: 'text', text: formatStatus(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
    'ai_productivity_attach_summary',
    {
      description:
        '【v2.13.0 触发约束】仅当当前 cwd 所在 git 分支名匹配正则 [A-Z][A-Z0-9]+-\\d+(Jira issue key),且该 jiraKey 已在 AI 提效面板初始化时才允许调用;不满足时严禁调用(daemon 会返 200 skipped 兜底,但工具调用本身就是噪音,会污染 IDE 工具面板)。前置满足时:把本轮对话总结静默上报到 AI 提效面板,回填到「最新一条非 init iteration」,每轮最终答复前调用一次,根据是否涉及代码改动选择 type=coding/communication',
      inputSchema: attachSummaryInputShape
    },
    async (args: z.infer<z.ZodObject<typeof attachSummaryInputShape>>): Promise<ToolResult> => {
      try {
        const result = await client.attachSummary({
          oneLine: args.oneLine,
          type: args.type,
          changeScope: args.changeScope,
          discussion: args.discussion,
          jiraKey: args.jiraKey,
          branch: args.branch,
          source: args.source,
          cwd: args.cwd
        })
        return { content: [{ type: 'text', text: formatAttachSummary(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // v2.16.0 P0 经验沉淀闭环: lessons-extract skill 配套两个工具

  server.registerTool(
    'ai_productivity_extract_bundle',
    {
      description:
        '【经验提取】skill 专用:拉取指定需求的 requirement + 全部 iterations + 已有 lessons,作为 LLM 抽取经验的输入数据包。返回 BUNDLE_JSON_BEGIN/END 包裹的 JSON(v2.17.0 起 JSON 中含 currentProjectSlug 字段,LLM 给 scope=project 经验时应据此填 projectSlug;existingLessons 已过滤为「通用+当前项目」)。LLM 解析后按维度推理出经验,再调 ai_productivity_save_lessons 落盘。',
      inputSchema: extractBundleInputShape
    },
    async (args: z.infer<z.ZodObject<typeof extractBundleInputShape>>): Promise<ToolResult> => {
      try {
        const result = await client.extractBundle({ jiraKey: args.jiraKey, cwd: args.cwd })
        return { content: [{ type: 'text', text: formatExtractBundle(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
    'ai_productivity_save_lessons',
    {
      description:
        '【经验提取】skill 专用:把 LLM 推理出的多维度经验批量落盘到本机 ~/.ai-productivity-tracker/data/lessons/。看板「复盘经验」Tab 直接消费同一份数据。每条 lesson 必填 type / title / content + 建议带 scope/projectSlug(通用 vs 项目专属),其余字段按维度补全。v2.17.0:**本轮如确实没有可复用经验,直接传 lessons:[],禁止凑数沉淀冗余条目**。v2.15.0 起同样支持 per-turn 单条沉淀:ai-productivity-track「经验内联」场景下,用户回复"记录"后只传本轮单条 lesson(填 iterationSeqs+scope),与整需求批量提取共用自动合并去重,落盘不会重复。',
      inputSchema: saveLessonsInputShape
    },
    async (args: z.infer<z.ZodObject<typeof saveLessonsInputShape>>): Promise<ToolResult> => {
      try {
        const lessons: LessonInputForSave[] = args.lessons.map((row) => ({
          ...row,
          jiraKey: row.jiraKey || args.jiraKey
        }))
        const result = await client.saveLessons({
          jiraKey: args.jiraKey,
          lessons,
          projectSlug: args.projectSlug
        })
        return { content: [{ type: 'text', text: formatSaveLessons(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // v1.0.0-rc.23 单需求复盘报告闭环:retrospective-report skill 配套两个工具

  server.registerTool(
    'ai_productivity_extract_retro_bundle',
    {
      description:
        '【需求复盘】skill 专用:拉取指定需求的复盘报告生成数据包(requirement + 全部 iterations + computedSignals + relatedLessons + existingRetrospective)。返回 RETRO_BUNDLE_JSON_BEGIN/END 包裹的 JSON。LLM 解析后按结构化叙事维度推理(overview / phases / highlights / issues / improvements / pitfallsObserved / nextSteps / splitSuggestions),并把本需求暴露的失败信号转译成可落地的 Harness 护栏建议(harnessSummary),再调 ai_productivity_save_retrospective 落盘。**复盘报告与 lessons 是弱引用关系**,LLM 通过 referencedLessonIds 关联本需求已沉淀的经验,不在复盘里直接落新 lesson(用户想沉淀经验仍走 lessons-extract skill)。',
      inputSchema: extractRetroBundleInputShape
    },
    async (
      args: z.infer<z.ZodObject<typeof extractRetroBundleInputShape>>
    ): Promise<ToolResult> => {
      try {
        const result = await client.extractRetrospectiveBundle({
          jiraKey: args.jiraKey,
          cwd: args.cwd
        })
        return { content: [{ type: 'text', text: formatRetroBundle(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
    'ai_productivity_save_retrospective',
    {
      description:
        '【需求复盘】skill 专用:把 LLM 推理出的结构化复盘叙事 + Harness 总结落盘到本机 ~/.ai-productivity-tracker/data/<jiraKey>/retrospective.json。**单文件覆盖**:同 jiraKey 重复落盘视为更新,snapshot / generatedAt / generatedAtIterationSeq 由 agent 端基于当前 iterations + requirement 自动注入,LLM 即便传相关字段也会被忽略。referencedLessonIds 不属于本 jiraKey 的 id 会被静默过滤;anchorIterationSeqs 与 harnessSummary.suggestions[].anchorSeqs 超出范围的 seq 会被静默过滤;harnessSummary 缺非法 category/空 title-content 的条目会被丢弃,空 suggestions 整体省略。narrative.overview 为空时 agent 端会拒收(返回错误)。',
      inputSchema: saveRetrospectiveInputShape
    },
    async (args: z.infer<z.ZodObject<typeof saveRetrospectiveInputShape>>): Promise<ToolResult> => {
      try {
        const narrative: RetrospectiveNarrativeInput = {
          overview: args.narrative.overview,
          phases: args.narrative.phases ?? [],
          highlights: args.narrative.highlights ?? [],
          issues: args.narrative.issues ?? [],
          improvements: args.narrative.improvements ?? [],
          pitfallsObserved: args.narrative.pitfallsObserved ?? [],
          nextSteps: args.narrative.nextSteps ?? [],
          splitSuggestions: args.narrative.splitSuggestions
        }
        const result = await client.saveRetrospective({
          jiraKey: args.jiraKey,
          narrative,
          source: args.source,
          referencedLessonIds: args.referencedLessonIds,
          anchorIterationSeqs: args.anchorIterationSeqs,
          harnessSummary: args.harnessSummary
        })
        return { content: [{ type: 'text', text: formatSaveRetrospective(result) }] }
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
