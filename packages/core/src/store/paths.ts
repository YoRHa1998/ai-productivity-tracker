import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * AI Productivity Tracker 本地存储根目录。
 *
 * 所有需求 / iteration / 全局配置都按 jiraKey 落在这里,跨项目共享一份;
 * 看板浏览器通过 daemon HTTP 端点反向读取该目录。
 *
 * 默认 `~/.ai-productivity-tracker/data`,可通过环境变量
 * `AIPT_DATA_ROOT` 覆盖。
 */
export const AIP_ROOT_ENV = 'AIPT_DATA_ROOT'

function resolveDefaultRoot(): string {
  const envRoot = process.env[AIP_ROOT_ENV]
  if (envRoot && envRoot.trim()) return resolve(envRoot.trim())
  return join(homedir(), '.ai-productivity-tracker', 'data')
}

export const INDEX_FILE_NAME = 'index.json'
export const FORMULA_FILE_NAME = 'formula.json'
export const JIRA_CONFIG_FILE_NAME = 'jira.json'
export const REQUIREMENT_FILE_NAME = 'requirement.json'
export const ITERATIONS_FILE_NAME = 'iterations.jsonl'
export const SUBTASK_EVENTS_FILE_NAME = 'subtask-events.jsonl'
export const RAW_DIR_NAME = 'raw'
export const LESSONS_DIR_NAME = 'lessons'
export const LESSONS_INDEX_FILE_NAME = 'INDEX.json'
export const RETROSPECTIVE_FILE_NAME = 'retrospective.json'
/**
 * 「AI 整体用量」单文件聚合(按 AI×自然日)。与需求维度正交,直接落 data 根,
 * 不绑 jiraKey 目录;查询 O(1),覆盖 main / 非仓库会话。详见 ai-usage-store.ts。
 */
export const AI_USAGE_FILE_NAME = 'ai-usage.json'
/**
 * 「用量测算」秒表式窗口化测算单文件(active 会话 + 历史记录)。与整体用量、需求维度
 * 都正交,直接落 data 根;详见 usage-benchmark-store.ts。
 */
export const USAGE_BENCHMARK_FILE_NAME = 'usage-benchmark.json'

export function aipRoot(root?: string): string {
  return root ? resolve(root) : resolveDefaultRoot()
}

export function ensureRoot(root?: string): string {
  const dir = aipRoot(root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function indexPath(root?: string): string {
  return join(aipRoot(root), INDEX_FILE_NAME)
}

export function formulaPath(root?: string): string {
  return join(aipRoot(root), FORMULA_FILE_NAME)
}

export function jiraConfigPath(root?: string): string {
  return join(aipRoot(root), JIRA_CONFIG_FILE_NAME)
}

/** 「AI 整体用量」聚合文件路径(data 根下单文件,惰性创建)。 */
export function aiUsagePath(root?: string): string {
  return join(aipRoot(root), AI_USAGE_FILE_NAME)
}

/** 「用量测算」文件路径(data 根下单文件,惰性创建)。 */
export function usageBenchmarkPath(root?: string): string {
  return join(aipRoot(root), USAGE_BENCHMARK_FILE_NAME)
}

/** JiraKey 在文件路径里的安全形态:大写 + [A-Z0-9-] 过滤 */
export function sanitizeJiraKey(jiraKey: string): string {
  return String(jiraKey || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 120)
}

export function requirementDir(jiraKey: string, root?: string): string {
  const key = sanitizeJiraKey(jiraKey)
  if (!key) throw new Error('jiraKey 不能为空')
  return join(aipRoot(root), key)
}

export function ensureRequirementDir(jiraKey: string, root?: string): string {
  const dir = requirementDir(jiraKey, root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function requirementFilePath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), REQUIREMENT_FILE_NAME)
}

export function iterationsFilePath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), ITERATIONS_FILE_NAME)
}

export function subtaskEventsFilePath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), SUBTASK_EVENTS_FILE_NAME)
}

export function rawDirPath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), RAW_DIR_NAME)
}

/**
 * 单需求复盘报告(retrospective.json)文件路径。单文件覆盖式存储,
 * 每个 jiraKey 至多保留一份「最新一次复盘」,详见 retrospective-store.ts。
 */
export function retrospectivePath(jiraKey: string, root?: string): string {
  return join(requirementDir(jiraKey, root), RETROSPECTIVE_FILE_NAME)
}

export function ensureRawDir(jiraKey: string, root?: string): string {
  const dir = rawDirPath(jiraKey, root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * v2.16.0 经验沉淀(lessons) 平铺存储目录:
 *
 *   ~/.ai-productivity-tracker/data/lessons/
 *   ├── INDEX.json              # 列表/筛选数据源(仅索引字段)
 *   └── <lessonId>.json         # 单条经验完整内容
 *
 * 跨 jiraKey 全局平铺,文件名形如 lsn-<jiraKey>-<8位 random>。
 * 只受 P0 经验提取闭环消费,与既有 requirement/iteration 链路完全解耦。
 */
export function lessonsDir(root?: string): string {
  return join(aipRoot(root), LESSONS_DIR_NAME)
}

export function ensureLessonsDir(root?: string): string {
  const dir = lessonsDir(root)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function lessonsIndexPath(root?: string): string {
  return join(lessonsDir(root), LESSONS_INDEX_FILE_NAME)
}

/** 经验文件名只允许 [a-zA-Z0-9_-] + .json,避免路径遍历 */
const LESSON_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/
export function isValidLessonId(id: string): boolean {
  return typeof id === 'string' && LESSON_ID_PATTERN.test(id)
}

export function lessonFilePath(lessonId: string, root?: string): string {
  if (!isValidLessonId(lessonId)) throw new Error(`非法 lessonId: ${lessonId}`)
  return join(lessonsDir(root), `${lessonId}.json`)
}
