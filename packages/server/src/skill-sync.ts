import { promises as fs } from 'node:fs'
import { existsSync, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

import {
  CLAUDE_TRACK_HOOK_REMINDER_COMMAND,
  CLAUDE_TRACK_HOOK_REMINDER_MARKER,
  CLAUDE_TRACK_SKILL_CONTENT,
  CLAUDE_TRACK_SKILL_FILENAME,
  CODEX_TRACK_HOOK_REMINDER_COMMAND,
  CODEX_TRACK_HOOK_REMINDER_MARKER,
  CODEX_TRACK_SKILL_CONTENT,
  CODEX_TRACK_SKILL_FILENAME,
  CODEX_TRACK_SKILL_KEY,
  CURSOR_SESSION_REMINDER_COMMAND,
  CURSOR_SESSION_REMINDER_MARKER,
  CURSOR_TRACK_RULE_CONTENT,
  CURSOR_TRACK_RULE_FILENAME,
  TRACK_SKILL_VERSION,
  LESSONS_EXTRACT_CLAUDE_CONTENT,
  LESSONS_EXTRACT_CLAUDE_FILENAME,
  LESSONS_EXTRACT_CODEX_CONTENT,
  LESSONS_EXTRACT_CURSOR_CONTENT,
  LESSONS_EXTRACT_CURSOR_FILENAME,
  LESSONS_EXTRACT_SKILL_KEY,
  LESSONS_EXTRACT_SKILL_VERSION,
  RETROSPECTIVE_CLAUDE_CONTENT,
  RETROSPECTIVE_CLAUDE_FILENAME,
  RETROSPECTIVE_CODEX_CONTENT,
  RETROSPECTIVE_CURSOR_CONTENT,
  RETROSPECTIVE_CURSOR_FILENAME,
  RETROSPECTIVE_SKILL_KEY,
  RETROSPECTIVE_SKILL_VERSION
} from '@ai-productivity-tracker/core'

export type SkillTool = 'cursor' | 'claude'

export type SkillSyncState = 'missing' | 'synced' | 'outdated'

export interface ExpectedFile {
  path: string
  sha256: string
}

export interface SkillStatusReport {
  state: SkillSyncState
  missingFiles: string[]
  mismatchedFiles: string[]
  extraFiles: string[]
}

export interface SkillFilePayload {
  path: string
  encoding: 'utf8' | 'base64'
  content: string
}

export interface PathProbeResult {
  exists: boolean
  isDirectory: boolean
  writable: boolean
}

export interface SkillRootDefaults {
  home: string
  cursor: { defaultPath: string; exists: boolean }
  claude: { defaultPath: string; exists: boolean }
}

const SUPPORTED_TOOLS: readonly SkillTool[] = ['cursor', 'claude'] as const

const SKILL_KEY_PATTERN = /^[a-z][a-z0-9-]*$/

export class SkillSyncError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SkillSyncError'
    this.status = status
  }
}

export function isSupportedTool(value: unknown): value is SkillTool {
  return typeof value === 'string' && (SUPPORTED_TOOLS as readonly string[]).includes(value)
}

export function expandHomePath(input: string): string {
  if (!input) return input
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2))
  }
  return input
}

function assertSafeKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !SKILL_KEY_PATTERN.test(key)) {
    throw new SkillSyncError(`非法的 skill key: ${String(key)}`)
  }
}

const FORBIDDEN_ROOTS = new Set([
  '/',
  '/Users',
  '/home',
  '/root',
  '/etc',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/private',
  '/Volumes',
  '/Library',
  '/System',
  '/tmp'
])

export function resolveSafeRoot(root: unknown): string {
  if (typeof root !== 'string' || !root.trim()) {
    throw new SkillSyncError('root 路径不能为空')
  }

  const expanded = expandHomePath(root.trim())

  if (!path.isAbsolute(expanded)) {
    throw new SkillSyncError(`root 必须是绝对路径: ${root}`)
  }

  const normalized = path.resolve(expanded)

  if (FORBIDDEN_ROOTS.has(normalized)) {
    throw new SkillSyncError(`不允许使用顶级或敏感目录作为 root: ${normalized}`)
  }

  const segments = normalized.split(path.sep).filter(Boolean)
  if (segments.length < 2) {
    throw new SkillSyncError(`root 至少需要两段非空目录: ${normalized}`)
  }

  return normalized
}

function assertSafeRelativePath(relPath: unknown, allowedRoot: string): string {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new SkillSyncError('文件相对路径不能为空')
  }

  const normalized = relPath.replace(/\\/g, '/').trim()

  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new SkillSyncError(`非法的文件路径（不允许绝对路径）: ${relPath}`)
  }

  const segments = normalized.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new SkillSyncError(`非法的文件路径段: ${relPath}`)
    }
  }

  const absolute = path.resolve(allowedRoot, ...segments)
  const rootAbs = path.resolve(allowedRoot)

  if (absolute !== rootAbs && !absolute.startsWith(rootAbs + path.sep)) {
    throw new SkillSyncError(`文件路径越界: ${relPath}`)
  }

  return absolute
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const rel = path.relative(rootDir, abs).split(path.sep).join('/')
      files.push(rel)
    }
  }

  await walk(rootDir)
  return files.sort((a, b) => a.localeCompare(b))
}

async function hashFile(absPath: string): Promise<string> {
  const buffer = await fs.readFile(absPath)
  return createHash('sha256').update(buffer).digest('hex')
}

export async function computeSkillStatus(
  root: string,
  key: string,
  expected: ExpectedFile[]
): Promise<SkillStatusReport> {
  const resolvedRoot = resolveSafeRoot(root)
  assertSafeKey(key)

  const skillDir = path.join(resolvedRoot, key)

  if (!existsSync(skillDir)) {
    return {
      state: 'missing',
      missingFiles: expected.map((f) => f.path),
      mismatchedFiles: [],
      extraFiles: []
    }
  }

  const missingFiles: string[] = []
  const mismatchedFiles: string[] = []

  for (const file of expected) {
    const abs = assertSafeRelativePath(file.path, skillDir)
    if (!(await pathExists(abs))) {
      missingFiles.push(file.path)
      continue
    }
    const actualHash = await hashFile(abs)
    if (actualHash !== file.sha256) {
      mismatchedFiles.push(file.path)
    }
  }

  const expectedSet = new Set(expected.map((f) => f.path))
  const actualFiles = await listFilesRecursive(skillDir)
  const extraFiles = actualFiles.filter((f) => !expectedSet.has(f))

  let state: SkillSyncState = 'synced'
  if (missingFiles.length > 0) {
    state = 'missing'
  } else if (mismatchedFiles.length > 0 || extraFiles.length > 0) {
    state = 'outdated'
  }

  return { state, missingFiles, mismatchedFiles, extraFiles }
}

async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true })
}

export async function writeSkillFiles(
  root: string,
  key: string,
  files: SkillFilePayload[]
): Promise<void> {
  const resolvedRoot = resolveSafeRoot(root)
  assertSafeKey(key)

  if (!Array.isArray(files) || files.length === 0) {
    throw new SkillSyncError('files 不能为空')
  }

  await fs.mkdir(resolvedRoot, { recursive: true })

  const finalDir = path.join(resolvedRoot, key)
  const tmpDir = path.join(resolvedRoot, `.${key}.tmp-${randomBytes(6).toString('hex')}`)

  try {
    await fs.mkdir(tmpDir, { recursive: true })

    for (const file of files) {
      if (!file || typeof file !== 'object') {
        throw new SkillSyncError('文件项格式非法')
      }
      const abs = assertSafeRelativePath(file.path, tmpDir)
      const encoding = file.encoding === 'base64' ? 'base64' : 'utf8'

      if (typeof file.content !== 'string') {
        throw new SkillSyncError(`文件内容必须为字符串: ${file.path}`)
      }

      await fs.mkdir(path.dirname(abs), { recursive: true })

      if (encoding === 'base64') {
        await fs.writeFile(abs, Buffer.from(file.content, 'base64'))
      } else {
        await fs.writeFile(abs, file.content, 'utf8')
      }
    }

    if (existsSync(finalDir)) {
      const backupDir = path.join(resolvedRoot, `.${key}.bak-${randomBytes(6).toString('hex')}`)
      await fs.rename(finalDir, backupDir)
      try {
        await fs.rename(tmpDir, finalDir)
      } catch (err) {
        await fs.rename(backupDir, finalDir).catch(() => {})
        throw err
      }
      await rmrf(backupDir)
    } else {
      await fs.rename(tmpDir, finalDir)
    }
  } catch (err) {
    await rmrf(tmpDir).catch(() => {})
    throw err
  }
}

export async function removeSkillDirectory(
  root: string,
  key: string
): Promise<{ removed: boolean }> {
  const resolvedRoot = resolveSafeRoot(root)
  assertSafeKey(key)

  const finalDir = path.join(resolvedRoot, key)
  if (!existsSync(finalDir)) {
    return { removed: false }
  }

  const trashDir = path.join(resolvedRoot, `.${key}.removed-${randomBytes(6).toString('hex')}`)
  await fs.rename(finalDir, trashDir)
  rmrf(trashDir).catch((err) => {
    console.error('[skill-sync] 清理移除目录失败：', err)
  })

  return { removed: true }
}

export async function probePath(absPath: unknown): Promise<PathProbeResult> {
  if (typeof absPath !== 'string' || !absPath.trim()) {
    throw new SkillSyncError('path 不能为空')
  }
  const expanded = expandHomePath(absPath.trim())
  if (!path.isAbsolute(expanded)) {
    throw new SkillSyncError(`path 必须是绝对路径: ${absPath}`)
  }

  const target = path.resolve(expanded)

  let exists = false
  let isDirectory = false
  let writable = false

  try {
    const stat = await fs.stat(target)
    exists = true
    isDirectory = stat.isDirectory()
  } catch {
    exists = false
  }

  if (exists) {
    try {
      await fs.access(target, fsConstants.W_OK)
      writable = true
    } catch {
      writable = false
    }
  } else {
    let probe = path.dirname(target)
    while (probe && probe !== path.dirname(probe)) {
      try {
        await fs.access(probe, fsConstants.W_OK)
        writable = true
        break
      } catch {
        if (existsSync(probe)) break
        probe = path.dirname(probe)
      }
    }
  }

  return { exists, isDirectory, writable }
}

export function getDefaultSkillRoots(): SkillRootDefaults {
  const home = homedir()
  const cursorPath = path.join(home, '.cursor', 'skills')
  const claudePath = path.join(home, '.claude', 'skills')
  return {
    home,
    cursor: { defaultPath: cursorPath, exists: existsSync(cursorPath) },
    claude: { defaultPath: claudePath, exists: existsSync(claudePath) }
  }
}

export const SUPPORTED_SKILL_TOOLS = SUPPORTED_TOOLS

// ===== v2.3.0 AI 对话总结 Skill / Cursor Rule 一键注入 =====

const TRACK_SKILL_KEY = 'ai-productivity-track'

function defaultClaudeTrackSkillRoot(): string {
  return path.join(homedir(), '.claude', 'skills')
}

function defaultClaudeTrackSkillFile(): string {
  return path.join(defaultClaudeTrackSkillRoot(), TRACK_SKILL_KEY, CLAUDE_TRACK_SKILL_FILENAME)
}

function defaultCursorTrackRuleDir(): string {
  return path.join(homedir(), '.cursor', 'rules')
}

function defaultCursorTrackRuleFile(): string {
  return path.join(defaultCursorTrackRuleDir(), CURSOR_TRACK_RULE_FILENAME)
}

// v2.16.0 lessons-extract skill 默认落盘路径 (复用 track 同款目录约定)
function defaultLessonsExtractClaudeFile(): string {
  return path.join(
    defaultClaudeTrackSkillRoot(),
    LESSONS_EXTRACT_SKILL_KEY,
    LESSONS_EXTRACT_CLAUDE_FILENAME
  )
}

function defaultLessonsExtractCursorFile(): string {
  return path.join(defaultCursorTrackRuleDir(), LESSONS_EXTRACT_CURSOR_FILENAME)
}

// v1.0.0-rc.23 retrospective-report skill 默认落盘路径(复用同款目录约定)
function defaultRetrospectiveClaudeFile(): string {
  return path.join(
    defaultClaudeTrackSkillRoot(),
    RETROSPECTIVE_SKILL_KEY,
    RETROSPECTIVE_CLAUDE_FILENAME
  )
}

function defaultRetrospectiveCursorFile(): string {
  return path.join(defaultCursorTrackRuleDir(), RETROSPECTIVE_CURSOR_FILENAME)
}

// v1.0.0 Codex 集成:Codex 用 ~/.codex/skills/<name>/SKILL.md 体系(与 Claude 同构),
// hooks 写 ~/.codex/hooks.json(与 Claude settings.json 同构)。
function defaultCodexSkillRoot(): string {
  return path.join(homedir(), '.codex', 'skills')
}

function defaultCodexTrackSkillFile(): string {
  return path.join(defaultCodexSkillRoot(), CODEX_TRACK_SKILL_KEY, CODEX_TRACK_SKILL_FILENAME)
}

function defaultCodexLessonsExtractFile(): string {
  return path.join(
    defaultCodexSkillRoot(),
    LESSONS_EXTRACT_SKILL_KEY,
    LESSONS_EXTRACT_CLAUDE_FILENAME
  )
}

function defaultCodexRetrospectiveFile(): string {
  return path.join(defaultCodexSkillRoot(), RETROSPECTIVE_SKILL_KEY, RETROSPECTIVE_CLAUDE_FILENAME)
}

function defaultCodexHooksFile(): string {
  return path.join(homedir(), '.codex', 'hooks.json')
}

async function readFileSafe(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf-8')
  } catch {
    return null
  }
}

export interface TrackSkillTargetStatus {
  defaultPath: string
  installed: boolean
  upToDate: boolean
  /** 已安装但内容与最新模板不一致时,前端会展示「可一键覆盖」 */
  outdated: boolean
}

/**
 * v2.6.0 Claude Code UserPromptSubmit Hook 状态.
 *
 * - installed:`~/.claude/settings.json` 内已存在 marker `# ai-productivity-track-reminder` 的 hook.
 * - upToDate:command 与最新模板字符串完全一致(用于版本升级时引导用户重新一键安装).
 * - currentCommand:实际写入的命令字符串(便于面板展示与排查).
 */
export interface ClaudeTrackHookStatus {
  path: string
  installed: boolean
  upToDate: boolean
  currentCommand: string | null
}

export interface TrackSkillBundleStatus {
  version: string
  claude: TrackSkillTargetStatus & {
    hook: ClaudeTrackHookStatus
    stopCheck: ClaudeTrackHookStatus
    /**
     * v2.10.0 deprecated:`~/.claude/settings.json` 的 `PostToolUse` 数组里残留的
     * `# ai-productivity-mark-tool-called` 老条目。install 时会主动清理。
     */
    legacyMarkToolDetected: boolean
    /**
     * v2.13.0 deprecated:`~/.claude/settings.json` 的 `Stop` 数组里残留的
     * `~/.local/bin/ai-productivity.mjs hook` 老 hook 入口。install 时会主动清理。
     */
    legacyLocalBinHookDetected: boolean
  }
  cursor: TrackSkillTargetStatus & {
    hook: CursorTrackHookStatus
  }
  /**
   * v2.16.0 lessons-extract skill 同步状态(复用「一键注入 Skill」一并装入)。
   * 看板 UI 不强制展示,主要供 install 时回报「附带装了哪些」。
   */
  lessonsExtract: {
    version: string
    claude: TrackSkillTargetStatus
    cursor: TrackSkillTargetStatus
  }
  /**
   * v1.0.0-rc.23 retrospective-report skill 同步状态(复用「一键注入 Skill」一并装入)。
   * 与 lessonsExtract 同构,无 Hook,只是文件覆盖。
   */
  retrospective: {
    version: string
    claude: TrackSkillTargetStatus
    cursor: TrackSkillTargetStatus
  }
  /**
   * v1.0.0 Codex 集成状态:ai-productivity-track / lessons-extract / retrospective-report
   * 三个 skill 写到 ~/.codex/skills/,外加 ~/.codex/hooks.json 的 reminder + stop-check。
   */
  codex: {
    track: TrackSkillTargetStatus
    lessonsExtract: TrackSkillTargetStatus
    retrospective: TrackSkillTargetStatus
    hook: CodexTrackHookStatus
  }
}

export interface ClaudeTrackHookInstallResult {
  path: string
  replaced: boolean
  previousCommand: string | null
  finalCommand: string
}

export interface CursorTrackHookInstallResult {
  path: string
  stopCheck: {
    replaced: boolean
    previousCommand: string | null
    finalCommand: string
  }
  /**
   * v2.14.0 新增:`hooks.sessionStart` 数组里 marker
   * `# ai-productivity-session-reminder` 的安装结果(覆盖式 upsert).
   */
  sessionReminder: {
    replaced: boolean
    previousCommand: string | null
    finalCommand: string
  }
  /**
   * v2.10.0:install 时检测并删除 `~/.cursor/hooks.json` 的 `afterMCPExecution`
   * 数组里 marker `# ai-productivity-mark-tool-called` 命中的老条目。
   * `removed=true` 表示真的删了一条;前端可据此提示用户重启 IDE 让新链路生效。
   */
  legacyMarkToolRemoved: boolean
  legacyMarkToolPreviousCommand: string | null
}

export interface TrackSkillBundleInstallResult {
  version: string
  claude: {
    path: string
    written: boolean
    replaced: boolean
    hook: ClaudeTrackHookInstallResult
    stopCheck: ClaudeTrackHookInstallResult
    /** v2.10.0:install 时清理掉 PostToolUse 老 mark-tool-called 条目 */
    legacyMarkToolRemoved: boolean
    legacyMarkToolPreviousCommand: string | null
    /** v2.13.0:install 时清理掉 Stop 数组里 `~/.local/bin/ai-productivity.mjs` 老 hook 入口 */
    legacyLocalBinHookRemoved: boolean
    legacyLocalBinHookPreviousCommand: string | null
  }
  cursor: {
    path: string
    written: boolean
    replaced: boolean
    hook: CursorTrackHookInstallResult
  }
  /**
   * v2.16.0 lessons-extract skill 一并写入的结果(无 Hook,只是文件覆盖)。
   * 老前端解构时该字段为 undefined 不影响,新前端可据此提示「同步装了 lessons-extract」。
   */
  lessonsExtract: {
    version: string
    claude: { path: string; written: boolean; replaced: boolean }
    cursor: { path: string; written: boolean; replaced: boolean }
  }
  /**
   * v1.0.0-rc.23 retrospective-report skill 一并写入的结果(无 Hook,只是文件覆盖)。
   */
  retrospective: {
    version: string
    claude: { path: string; written: boolean; replaced: boolean }
    cursor: { path: string; written: boolean; replaced: boolean }
  }
  /**
   * v1.0.0 Codex 集成:三个 skill 写到 ~/.codex/skills/,外加 ~/.codex/hooks.json
   * 的 reminder + stop-check 注入结果。
   */
  codex: {
    track: { path: string; written: boolean; replaced: boolean }
    lessonsExtract: { path: string; written: boolean; replaced: boolean }
    retrospective: { path: string; written: boolean; replaced: boolean }
    hook: CodexTrackHookInstallResult
  }
}

export async function inspectAiTrackSkillBundle(): Promise<TrackSkillBundleStatus> {
  const claudePath = defaultClaudeTrackSkillFile()
  const cursorPath = defaultCursorTrackRuleFile()
  const lessonsClaudePath = defaultLessonsExtractClaudeFile()
  const lessonsCursorPath = defaultLessonsExtractCursorFile()
  const retroClaudePath = defaultRetrospectiveClaudeFile()
  const retroCursorPath = defaultRetrospectiveCursorFile()
  const codexTrackPath = defaultCodexTrackSkillFile()
  const codexLessonsPath = defaultCodexLessonsExtractFile()
  const codexRetroPath = defaultCodexRetrospectiveFile()

  const [
    claudeContent,
    cursorContent,
    hookStatus,
    stopCheckStatus,
    claudeLegacyMarkTool,
    claudeLegacyLocalBinHook,
    cursorHookStatus,
    lessonsClaudeContent,
    lessonsCursorContent,
    retroClaudeContent,
    retroCursorContent,
    codexTrackContent,
    codexLessonsContent,
    codexRetroContent,
    codexHookStatus
  ] = await Promise.all([
    readFileSafe(claudePath),
    readFileSafe(cursorPath),
    inspectAiTrackClaudeHook(),
    inspectAiTrackClaudeStopCheck(),
    detectLegacyClaudeMarkToolEntry(),
    detectLegacyClaudeStopHookEntry(),
    inspectAiTrackCursorHook(),
    readFileSafe(lessonsClaudePath),
    readFileSafe(lessonsCursorPath),
    readFileSafe(retroClaudePath),
    readFileSafe(retroCursorPath),
    readFileSafe(codexTrackPath),
    readFileSafe(codexLessonsPath),
    readFileSafe(codexRetroPath),
    inspectAiTrackCodexHook()
  ])

  const claudeInstalled = claudeContent !== null
  const cursorInstalled = cursorContent !== null
  const lessonsClaudeInstalled = lessonsClaudeContent !== null
  const lessonsCursorInstalled = lessonsCursorContent !== null
  const retroClaudeInstalled = retroClaudeContent !== null
  const retroCursorInstalled = retroCursorContent !== null
  const codexTrackInstalled = codexTrackContent !== null
  const codexLessonsInstalled = codexLessonsContent !== null
  const codexRetroInstalled = codexRetroContent !== null

  return {
    version: TRACK_SKILL_VERSION,
    claude: {
      defaultPath: claudePath,
      installed: claudeInstalled,
      upToDate: claudeContent === CLAUDE_TRACK_SKILL_CONTENT,
      outdated: claudeInstalled && claudeContent !== CLAUDE_TRACK_SKILL_CONTENT,
      hook: hookStatus,
      stopCheck: stopCheckStatus,
      legacyMarkToolDetected: claudeLegacyMarkTool,
      legacyLocalBinHookDetected: claudeLegacyLocalBinHook
    },
    cursor: {
      defaultPath: cursorPath,
      installed: cursorInstalled,
      upToDate: cursorContent === CURSOR_TRACK_RULE_CONTENT,
      outdated: cursorInstalled && cursorContent !== CURSOR_TRACK_RULE_CONTENT,
      hook: cursorHookStatus
    },
    lessonsExtract: {
      version: LESSONS_EXTRACT_SKILL_VERSION,
      claude: {
        defaultPath: lessonsClaudePath,
        installed: lessonsClaudeInstalled,
        upToDate: lessonsClaudeContent === LESSONS_EXTRACT_CLAUDE_CONTENT,
        outdated: lessonsClaudeInstalled && lessonsClaudeContent !== LESSONS_EXTRACT_CLAUDE_CONTENT
      },
      cursor: {
        defaultPath: lessonsCursorPath,
        installed: lessonsCursorInstalled,
        upToDate: lessonsCursorContent === LESSONS_EXTRACT_CURSOR_CONTENT,
        outdated: lessonsCursorInstalled && lessonsCursorContent !== LESSONS_EXTRACT_CURSOR_CONTENT
      }
    },
    retrospective: {
      version: RETROSPECTIVE_SKILL_VERSION,
      claude: {
        defaultPath: retroClaudePath,
        installed: retroClaudeInstalled,
        upToDate: retroClaudeContent === RETROSPECTIVE_CLAUDE_CONTENT,
        outdated: retroClaudeInstalled && retroClaudeContent !== RETROSPECTIVE_CLAUDE_CONTENT
      },
      cursor: {
        defaultPath: retroCursorPath,
        installed: retroCursorInstalled,
        upToDate: retroCursorContent === RETROSPECTIVE_CURSOR_CONTENT,
        outdated: retroCursorInstalled && retroCursorContent !== RETROSPECTIVE_CURSOR_CONTENT
      }
    },
    codex: {
      track: {
        defaultPath: codexTrackPath,
        installed: codexTrackInstalled,
        upToDate: codexTrackContent === CODEX_TRACK_SKILL_CONTENT,
        outdated: codexTrackInstalled && codexTrackContent !== CODEX_TRACK_SKILL_CONTENT
      },
      lessonsExtract: {
        defaultPath: codexLessonsPath,
        installed: codexLessonsInstalled,
        upToDate: codexLessonsContent === LESSONS_EXTRACT_CODEX_CONTENT,
        outdated: codexLessonsInstalled && codexLessonsContent !== LESSONS_EXTRACT_CODEX_CONTENT
      },
      retrospective: {
        defaultPath: codexRetroPath,
        installed: codexRetroInstalled,
        upToDate: codexRetroContent === RETROSPECTIVE_CODEX_CONTENT,
        outdated: codexRetroInstalled && codexRetroContent !== RETROSPECTIVE_CODEX_CONTENT
      },
      hook: codexHookStatus
    }
  }
}

async function writeFileAtomic(absPath: string, content: string): Promise<{ replaced: boolean }> {
  const dir = path.dirname(absPath)
  await fs.mkdir(dir, { recursive: true })
  const existed = existsSync(absPath)
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, absPath)
  return { replaced: existed }
}

/**
 * 一键注入 AI 对话总结 skill / rule:
 * - Claude: ~/.claude/skills/ai-productivity-track/SKILL.md
 * - Cursor: ~/.cursor/rules/ai-productivity-track.mdc
 *
 * 落盘方式: tmp + rename 原子覆盖。父目录不存在自动创建。
 * 不做路径黑名单 (这两个路径硬编码在用户家目录下,不暴露 root 入参)。
 *
 * v2.10.0 同时执行兼容清理:
 * - 删除 `~/.cursor/hooks.json` 的 `afterMCPExecution` 数组中 `# ai-productivity-mark-tool-called` 条目
 * - 删除 `~/.claude/settings.json` 的 `PostToolUse` 数组中同 marker 条目
 * 用户点一次「一键注入」即可清理掉老链路残留,不需要手工编辑配置。
 */
export async function installAiTrackSkillBundle(): Promise<TrackSkillBundleInstallResult> {
  const claudePath = defaultClaudeTrackSkillFile()
  const cursorPath = defaultCursorTrackRuleFile()

  const claudeRes = await writeFileAtomic(claudePath, CLAUDE_TRACK_SKILL_CONTENT)
  const cursorRes = await writeFileAtomic(cursorPath, CURSOR_TRACK_RULE_CONTENT)
  const hookRes = await installAiTrackClaudeHook()
  const stopCheckRes = await installAiTrackClaudeStopCheck()
  const claudeLegacyMarkRes = await cleanupLegacyClaudeMarkToolEntries()
  // v2.13.0:同步清掉 Stop 数组里 `~/.local/bin/ai-productivity.mjs` 老 hook 入口。
  // 注意必须在 installAiTrackClaudeStopCheck 之后跑,否则若 cleanup 把整个 Stop key 删掉,
  // install 跑时会重新创 Stop key 但又写不进我们的新条目 —— 顺序保证 stop-check 一定能挂上。
  const claudeLegacyLocalBinRes = await cleanupLegacyClaudeStopHookEntries()
  const cursorHookRes = await installAiTrackCursorHook()

  // v2.16.0:lessons-extract skill 同步装入(无 Hook,只是文件覆盖)
  const lessonsClaudePath = defaultLessonsExtractClaudeFile()
  const lessonsCursorPath = defaultLessonsExtractCursorFile()
  const lessonsClaudeRes = await writeFileAtomic(lessonsClaudePath, LESSONS_EXTRACT_CLAUDE_CONTENT)
  const lessonsCursorRes = await writeFileAtomic(lessonsCursorPath, LESSONS_EXTRACT_CURSOR_CONTENT)

  // v1.0.0-rc.23:retrospective-report skill 同步装入(无 Hook,只是文件覆盖)
  const retroClaudePath = defaultRetrospectiveClaudeFile()
  const retroCursorPath = defaultRetrospectiveCursorFile()
  const retroClaudeRes = await writeFileAtomic(retroClaudePath, RETROSPECTIVE_CLAUDE_CONTENT)
  const retroCursorRes = await writeFileAtomic(retroCursorPath, RETROSPECTIVE_CURSOR_CONTENT)

  // v1.0.0 Codex:三个 skill 写到 ~/.codex/skills/,外加 hooks.json reminder + stop-check
  const codexTrackPath = defaultCodexTrackSkillFile()
  const codexLessonsPath = defaultCodexLessonsExtractFile()
  const codexRetroPath = defaultCodexRetrospectiveFile()
  const codexTrackRes = await writeFileAtomic(codexTrackPath, CODEX_TRACK_SKILL_CONTENT)
  const codexLessonsRes = await writeFileAtomic(codexLessonsPath, LESSONS_EXTRACT_CODEX_CONTENT)
  const codexRetroRes = await writeFileAtomic(codexRetroPath, RETROSPECTIVE_CODEX_CONTENT)
  const codexHookRes = await installAiTrackCodexHook()

  return {
    version: TRACK_SKILL_VERSION,
    claude: {
      path: claudePath,
      written: true,
      replaced: claudeRes.replaced,
      hook: hookRes,
      stopCheck: stopCheckRes,
      legacyMarkToolRemoved: claudeLegacyMarkRes.removed,
      legacyMarkToolPreviousCommand: claudeLegacyMarkRes.previousCommand,
      legacyLocalBinHookRemoved: claudeLegacyLocalBinRes.removed,
      legacyLocalBinHookPreviousCommand: claudeLegacyLocalBinRes.previousCommand
    },
    cursor: {
      path: cursorPath,
      written: true,
      replaced: cursorRes.replaced,
      hook: cursorHookRes
    },
    lessonsExtract: {
      version: LESSONS_EXTRACT_SKILL_VERSION,
      claude: { path: lessonsClaudePath, written: true, replaced: lessonsClaudeRes.replaced },
      cursor: { path: lessonsCursorPath, written: true, replaced: lessonsCursorRes.replaced }
    },
    retrospective: {
      version: RETROSPECTIVE_SKILL_VERSION,
      claude: { path: retroClaudePath, written: true, replaced: retroClaudeRes.replaced },
      cursor: { path: retroCursorPath, written: true, replaced: retroCursorRes.replaced }
    },
    codex: {
      track: { path: codexTrackPath, written: true, replaced: codexTrackRes.replaced },
      lessonsExtract: { path: codexLessonsPath, written: true, replaced: codexLessonsRes.replaced },
      retrospective: { path: codexRetroPath, written: true, replaced: codexRetroRes.replaced },
      hook: codexHookRes
    }
  }
}

// ===== v2.6.0 Claude Code UserPromptSubmit Hook 注入 =====

interface ClaudeHookEntry {
  type: string
  command: string
  [key: string]: unknown
}

interface ClaudeHookMatcherGroup {
  matcher: string
  hooks: ClaudeHookEntry[]
  [key: string]: unknown
}

interface ClaudeSettingsLike {
  hooks?: {
    UserPromptSubmit?: ClaudeHookMatcherGroup[]
    [k: string]: unknown
  }
  [k: string]: unknown
}

function defaultClaudeSettingsFile(): string {
  return path.join(homedir(), '.claude', 'settings.json')
}

function findTrackReminderEntry(group: ClaudeHookMatcherGroup): ClaudeHookEntry | null {
  if (!group || !Array.isArray(group.hooks)) return null
  for (const entry of group.hooks) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as ClaudeHookEntry).command === 'string' &&
      (entry as ClaudeHookEntry).type === 'command' &&
      (entry as ClaudeHookEntry).command.includes(CLAUDE_TRACK_HOOK_REMINDER_MARKER)
    ) {
      return entry as ClaudeHookEntry
    }
  }
  return null
}

async function readClaudeSettings(file: string): Promise<ClaudeSettingsLike> {
  const raw = await readFileSafe(file)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ClaudeSettingsLike
    }
    return {}
  } catch {
    return {}
  }
}

export async function inspectAiTrackClaudeHook(): Promise<ClaudeTrackHookStatus> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = settings.hooks?.UserPromptSubmit
  if (!Array.isArray(groups)) {
    return { path: file, installed: false, upToDate: false, currentCommand: null }
  }
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue
    const entry = findTrackReminderEntry(group as ClaudeHookMatcherGroup)
    if (entry) {
      return {
        path: file,
        installed: true,
        upToDate: entry.command === CLAUDE_TRACK_HOOK_REMINDER_COMMAND,
        currentCommand: entry.command
      }
    }
  }
  return { path: file, installed: false, upToDate: false, currentCommand: null }
}

/**
 * 在 ~/.claude/settings.json 注入 / 更新 UserPromptSubmit Hook.
 *
 * - 通过 marker `# ai-productivity-track-reminder` 在 hooks[].command 中识别同源 entry.
 * - 找到则覆盖(用于版本升级),没找到则在 matcher='*' 的 group 内追加.
 * - matcher='*' 的 group 不存在时自动创建.
 * - 不动其他 hook entry,不动其他 matcher group,不动顶层其他字段.
 * - tmp + rename 原子写盘.
 */
export async function installAiTrackClaudeHook(): Promise<ClaudeTrackHookInstallResult> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {}
  }
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
    settings.hooks.UserPromptSubmit = []
  }
  const groups = settings.hooks.UserPromptSubmit as ClaudeHookMatcherGroup[]

  let previousCommand: string | null = null
  let replaced = false

  // 在所有 group 内寻找已存在的 reminder entry(包容用户手动改过 matcher 的情况)
  let foundGroup: ClaudeHookMatcherGroup | null = null
  let foundEntry: ClaudeHookEntry | null = null
  for (const group of groups) {
    const entry = findTrackReminderEntry(group)
    if (entry) {
      foundGroup = group
      foundEntry = entry
      break
    }
  }

  if (foundEntry) {
    previousCommand = foundEntry.command
    foundEntry.command = CLAUDE_TRACK_HOOK_REMINDER_COMMAND
    foundEntry.type = 'command'
    replaced = true
  } else {
    let starGroup = groups.find((g) => g && g.matcher === '*')
    if (!starGroup) {
      starGroup = { matcher: '*', hooks: [] }
      groups.push(starGroup)
    }
    if (!Array.isArray(starGroup.hooks)) starGroup.hooks = []
    starGroup.hooks.push({
      type: 'command',
      command: CLAUDE_TRACK_HOOK_REMINDER_COMMAND
    })
    foundGroup = starGroup
  }
  // 防止 typed group 的 hooks 字段被外部置 undefined
  if (foundGroup && !Array.isArray(foundGroup.hooks)) foundGroup.hooks = []

  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)

  return {
    path: file,
    replaced,
    previousCommand,
    finalCommand: CLAUDE_TRACK_HOOK_REMINDER_COMMAND
  }
}

// ===== v2.8.0 防伪造校验 Hook 注入(v2.10.0 简化) =====
//
// v2.8.0 引入背景:用户追踪后凭空写"该对话已总结上报"却没真调 attach_summary。
// 老链路通过两组 hook 实现「打勾 + 后置校验」:
//   - Cursor afterMCPExecution / Claude PostToolUse → 命中 attach_summary 时写 conv-gen 维度 sentinel
//   - Cursor stop / Claude Stop → 看不到 sentinel 时强制 LLM 在下一轮补一次
// 实测 afterMCPExecution 是 fire-and-forget,跨进程时序不可控,sentinel 经常漏写,
// 导致 stop-check 永远走 inject_followup → 一次对话被强制重答两次 + 5-6 秒延迟。
//
// v2.10.0 简化为单层 stop hook:
//   - agent attach-summary handler 同进程同步写 jiraKey 维度 sentinel
//   - 仅注入 Cursor stop / Claude Stop hook,Cursor afterMCPExecution / Claude PostToolUse 下线
//   - install 时主动清理 marker `# ai-productivity-mark-tool-called` 命中的老条目
//
// 现存 install/inspect 函数都遵循:marker 同源识别、原地覆盖、不动其他 hook entry.

export const CURSOR_STOP_CHECK_MARKER = '# ai-productivity-stop-check'
/** v2.10.0 deprecated:仅用于识别老 hooks.json 残留条目,install 时清理 */
export const CURSOR_MARK_TOOL_MARKER = '# ai-productivity-mark-tool-called'
export const CURSOR_STOP_LOOP_LIMIT = 2

export const CLAUDE_STOP_CHECK_MARKER = '# ai-productivity-stop-check'
/** v2.10.0 deprecated:仅用于识别老 settings.json 残留条目,install 时清理 */
export const CLAUDE_MARK_TOOL_MARKER = '# ai-productivity-mark-tool-called'

/**
 * v2.13.0 deprecated:Claude Code Stop hook 残留的 `~/.local/bin/ai-productivity.mjs hook` 老条目识别片段.
 *
 * 老路径背景:v2.1.x 用户安装 install.sh 时把 CLI 装到 `~/.local/bin/ai-productivity.mjs`,
 * 当时 Cursor `afterAgentResponse` hook 用该路径作为入口;v2.2.0 起 hook 入口统一改成
 * `~/Downloads/ai-productivity-mcp.mjs hook`,但部分用户 / 早期文档把老路径误注入到
 * Claude Code Stop hook 里,导致每轮 Stop 都额外 spawn 一次 node 跑老入口(对 Claude Code
 * 这边因 payload 无 token 字段、agent /ai-productivity/hook 会 early return 不写 iteration,
 * 但浪费 ~70ms 跑时,并占着 hook 槽位).
 *
 * 用 `.includes('/.local/bin/ai-productivity.mjs')` 做片段匹配,兼容 nvm 完整路径写法
 * (`/.../node /Users/<user>/.local/bin/ai-productivity.mjs hook # ai-productivity-hook`).
 */
export const CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT = '/.local/bin/ai-productivity.mjs'

/**
 * 当前 cli.mjs 的绝对路径(用于 stop-check hook 命令拼装)。
 *
 * v1.0 起 cli 与 daemon 是同一份 cli.mjs(esbuild bundle 单文件),
 * daemon 进程的 `process.argv[1]` 就是 cli.mjs 的真实绝对路径。
 *
 * 老 v2.x 这里返回 `~/Downloads/ai-productivity-mcp.mjs`(用户手动下载位置),
 * 是迁移期遗漏的死代码。
 */
function defaultMcpBinPath(): string {
  return process.argv[1] ?? path.join(homedir(), 'Downloads', 'ai-productivity-mcp.mjs')
}

/**
 * v1.0:用 process.execPath(当前 node 绝对路径)而不是 'node'。
 *
 * Cursor / Claude Code 从 macOS launchd 启动 hook 子进程时 PATH 只有
 * /usr/bin:/bin:/usr/sbin:/sbin,nvm/volta/fnm 装的 node 不在里面,
 * `command: 'node'` 会被 IDE 启 hook 子进程时报 ENOENT。
 */
export function buildCursorStopCheckCommand(): string {
  return `${process.execPath} ${defaultMcpBinPath()} stop-check ${CURSOR_STOP_CHECK_MARKER}`
}

export function buildClaudeStopCheckCommand(): string {
  return `${process.execPath} ${defaultMcpBinPath()} stop-check ${CLAUDE_STOP_CHECK_MARKER}`
}

/**
 * v2.14.0:Cursor `sessionStart` reminder hook 命令.
 *
 * 与 `buildCursorStopCheckCommand()` 不同,reminder 完全在 shell 层实现(bash + git),
 * 不调任何 cli 子命令.因此这里直接转发 core 模板常量 `CURSOR_SESSION_REMINDER_COMMAND`,
 * 不需要拼装 `process.execPath` / `defaultMcpBinPath()`.
 *
 * 暴露成函数(而非直接 export `CURSOR_SESSION_REMINDER_COMMAND`)是为了和
 * `buildCursorStopCheckCommand` 调用风格保持一致,未来若需要在 Cursor 端额外拼参数
 * (例如不同 daemon URL),改这里一处即可.
 */
export function buildCursorSessionReminderCommand(): string {
  return CURSOR_SESSION_REMINDER_COMMAND
}

// ----- Cursor hooks.json -----

export interface CursorTrackHookStatus {
  path: string
  stopCheckInstalled: boolean
  stopCheckUpToDate: boolean
  stopCheckCurrentCommand: string | null
  /**
   * v2.14.0 新增:`~/.cursor/hooks.json` 的 `hooks.sessionStart` 数组里
   * marker `# ai-productivity-session-reminder` 命中的条目状态.该 hook 在每个新
   * Cursor 会话创建时探一次 git 分支,Jira 分支输出 `additional_context` 给 LLM
   * 注入 reminder,与 Claude `UserPromptSubmit` Hook 双方言对称.
   */
  sessionReminderInstalled: boolean
  sessionReminderUpToDate: boolean
  sessionReminderCurrentCommand: string | null
  /**
   * v2.10.0 deprecated:`afterMCPExecution` 数组里残留的
   * `# ai-productivity-mark-tool-called` 老条目;install 时会主动删除。
   */
  legacyMarkToolDetected: boolean
  /** 检测到 tanmi-workspace 或其他失效路径时给前端一个提示;install 不会自动删除 */
  legacyHookDetected: boolean
}

interface CursorHookEntryLike {
  command: string
  matcher?: string
  loop_limit?: number
  [k: string]: unknown
}

interface CursorHooksFileLike {
  version?: number
  hooks?: {
    stop?: CursorHookEntryLike[]
    sessionStart?: CursorHookEntryLike[]
    afterMCPExecution?: CursorHookEntryLike[]
    [k: string]: unknown
  }
  [k: string]: unknown
}

function defaultCursorHooksFile(): string {
  return path.join(homedir(), '.cursor', 'hooks.json')
}

async function readCursorHooksFile(file: string): Promise<CursorHooksFileLike> {
  const raw = await readFileSafe(file)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CursorHooksFileLike
    }
    return {}
  } catch {
    return {}
  }
}

function findCursorEntryByMarker(
  entries: CursorHookEntryLike[] | undefined,
  marker: string
): { index: number; entry: CursorHookEntryLike } | null {
  if (!Array.isArray(entries)) return null
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    if (e && typeof e.command === 'string' && e.command.includes(marker)) {
      return { index: i, entry: e }
    }
  }
  return null
}

function detectLegacyCursorEntry(parsed: CursorHooksFileLike): boolean {
  const hooks = parsed.hooks ?? {}
  for (const key of Object.keys(hooks)) {
    const arr = (hooks as Record<string, unknown>)[key]
    if (!Array.isArray(arr)) continue
    for (const e of arr) {
      if (
        e &&
        typeof e === 'object' &&
        typeof (e as CursorHookEntryLike).command === 'string' &&
        (e as CursorHookEntryLike).command.includes('.tanmi-workspace')
      ) {
        return true
      }
    }
  }
  return false
}

export async function inspectAiTrackCursorHook(): Promise<CursorTrackHookStatus> {
  const file = defaultCursorHooksFile()
  const parsed = await readCursorHooksFile(file)
  const stopCheckCmd = buildCursorStopCheckCommand()
  const sessionReminderCmd = buildCursorSessionReminderCommand()

  const stopHit = findCursorEntryByMarker(parsed.hooks?.stop, CURSOR_STOP_CHECK_MARKER)
  const sessionHit = findCursorEntryByMarker(
    parsed.hooks?.sessionStart,
    CURSOR_SESSION_REMINDER_MARKER
  )
  const legacyMarkHit = findCursorEntryByMarker(
    parsed.hooks?.afterMCPExecution,
    CURSOR_MARK_TOOL_MARKER
  )

  return {
    path: file,
    stopCheckInstalled: !!stopHit,
    stopCheckUpToDate: !!stopHit && stopHit.entry.command === stopCheckCmd,
    stopCheckCurrentCommand: stopHit?.entry.command ?? null,
    sessionReminderInstalled: !!sessionHit,
    sessionReminderUpToDate: !!sessionHit && sessionHit.entry.command === sessionReminderCmd,
    sessionReminderCurrentCommand: sessionHit?.entry.command ?? null,
    legacyMarkToolDetected: !!legacyMarkHit,
    legacyHookDetected: detectLegacyCursorEntry(parsed)
  }
}

/**
 * v2.14.0 install:
 *   1. 写 stop hook(沿用既有覆盖语义)
 *   2. 写 sessionStart reminder hook(v2.14.0 新增,等价 Claude UserPromptSubmit)
 *   3. 主动清理 afterMCPExecution 数组里 `# ai-productivity-mark-tool-called` 老条目(下线兼容)
 *   4. 整体写盘
 */
export async function installAiTrackCursorHook(): Promise<CursorTrackHookInstallResult> {
  const file = defaultCursorHooksFile()
  const parsed = await readCursorHooksFile(file)

  parsed.version = parsed.version ?? 1
  parsed.hooks = parsed.hooks ?? {}
  const hooks = parsed.hooks
  const stopArr = (Array.isArray(hooks.stop) ? hooks.stop : []) as CursorHookEntryLike[]
  const sessionArr = (
    Array.isArray(hooks.sessionStart) ? hooks.sessionStart : []
  ) as CursorHookEntryLike[]
  const mcpArr = (
    Array.isArray(hooks.afterMCPExecution) ? hooks.afterMCPExecution : []
  ) as CursorHookEntryLike[]

  const stopCheckCmd = buildCursorStopCheckCommand()
  const sessionReminderCmd = buildCursorSessionReminderCommand()

  // 1) stop hook(覆盖式注入)
  const stopHit = findCursorEntryByMarker(stopArr, CURSOR_STOP_CHECK_MARKER)
  const stopPrev = stopHit?.entry.command ?? null
  const stopReplaced = !!stopHit
  const stopEntry: CursorHookEntryLike = {
    command: stopCheckCmd,
    loop_limit: CURSOR_STOP_LOOP_LIMIT
  }
  if (stopHit) {
    stopArr[stopHit.index] = stopEntry
  } else {
    stopArr.push(stopEntry)
  }
  hooks.stop = stopArr

  // 2) sessionStart reminder hook(v2.14.0,覆盖式注入)
  //
  // 与 stop hook 不同,sessionStart entry 不需要 loop_limit / matcher 等字段,只要 command.
  // 同 marker 命中老条目时覆盖 command;不命中时 push 新 entry.其他 sessionStart 条目
  // (例如用户自己装的 audit / env 注入)完全保留,绝不破坏.
  const sessionHit = findCursorEntryByMarker(sessionArr, CURSOR_SESSION_REMINDER_MARKER)
  const sessionPrev = sessionHit?.entry.command ?? null
  const sessionReplaced = !!sessionHit
  const sessionEntry: CursorHookEntryLike = { command: sessionReminderCmd }
  if (sessionHit) {
    sessionArr[sessionHit.index] = sessionEntry
  } else {
    sessionArr.push(sessionEntry)
  }
  hooks.sessionStart = sessionArr

  // 3) 清理 afterMCPExecution 老 mark-tool-called 条目(v2.10.0 下线)
  let legacyRemoved = false
  let legacyPrev: string | null = null
  const legacyHit = findCursorEntryByMarker(mcpArr, CURSOR_MARK_TOOL_MARKER)
  if (legacyHit) {
    legacyPrev = legacyHit.entry.command
    mcpArr.splice(legacyHit.index, 1)
    legacyRemoved = true
  }
  if (mcpArr.length > 0) {
    hooks.afterMCPExecution = mcpArr
  } else if ('afterMCPExecution' in hooks) {
    // 数组为空时直接删 key,避免 hooks.json 出现一堆空数组
    delete (hooks as Record<string, unknown>).afterMCPExecution
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)

  return {
    path: file,
    stopCheck: { replaced: stopReplaced, previousCommand: stopPrev, finalCommand: stopCheckCmd },
    sessionReminder: {
      replaced: sessionReplaced,
      previousCommand: sessionPrev,
      finalCommand: sessionReminderCmd
    },
    legacyMarkToolRemoved: legacyRemoved,
    legacyMarkToolPreviousCommand: legacyPrev
  }
}

// ----- Claude Code Stop / PostToolUse -----

interface ClaudeHookUpsertInput {
  hookType: 'Stop' | 'PostToolUse' | 'UserPromptSubmit'
  /** Stop 用 null(无 matcher 概念);PostToolUse / UserPromptSubmit 传 matcher 字符串 */
  matcher: string | null
  marker: string
  finalCommand: string
}

function findClaudeEntryByMarker(
  groups: ClaudeHookMatcherGroup[],
  marker: string
): { group: ClaudeHookMatcherGroup; entry: ClaudeHookEntry } | null {
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue
    for (const entry of group.hooks) {
      if (
        entry &&
        typeof (entry as ClaudeHookEntry).command === 'string' &&
        (entry as ClaudeHookEntry).command.includes(marker)
      ) {
        return { group, entry: entry as ClaudeHookEntry }
      }
    }
  }
  return null
}

function upsertClaudeHookEntry(
  settings: ClaudeSettingsLike,
  input: ClaudeHookUpsertInput
): { replaced: boolean; previousCommand: string | null } {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {}
  }
  const hooks = settings.hooks as Record<string, unknown>
  if (!Array.isArray(hooks[input.hookType])) {
    hooks[input.hookType] = []
  }
  const groups = hooks[input.hookType] as ClaudeHookMatcherGroup[]

  const found = findClaudeEntryByMarker(groups, input.marker)
  if (found) {
    const prev = found.entry.command
    found.entry.command = input.finalCommand
    found.entry.type = 'command'
    return { replaced: true, previousCommand: prev }
  }

  // 没找到 → 找 matcher 一致的 group;Stop 走第一个 group / null matcher group
  let target: ClaudeHookMatcherGroup | null = null
  if (input.matcher === null) {
    target = groups.find((g) => g && !('matcher' in g)) ?? groups[0] ?? null
    if (!target) {
      target = { matcher: '', hooks: [] }
      delete (target as { matcher?: string }).matcher
      groups.push(target)
    }
  } else {
    target = groups.find((g) => g && g.matcher === input.matcher) ?? null
    if (!target) {
      target = { matcher: input.matcher, hooks: [] }
      groups.push(target)
    }
  }
  if (!Array.isArray(target.hooks)) target.hooks = []
  target.hooks.push({ type: 'command', command: input.finalCommand })
  return { replaced: false, previousCommand: null }
}

async function writeClaudeSettings(file: string, settings: ClaudeSettingsLike): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, file)
}

async function inspectClaudeHookByMarker(
  hookType: 'Stop' | 'PostToolUse',
  marker: string,
  expectedCommand: string
): Promise<ClaudeTrackHookStatus> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = (settings.hooks?.[hookType] as ClaudeHookMatcherGroup[] | undefined) ?? null
  if (!Array.isArray(groups)) {
    return { path: file, installed: false, upToDate: false, currentCommand: null }
  }
  const found = findClaudeEntryByMarker(groups, marker)
  if (!found) {
    return { path: file, installed: false, upToDate: false, currentCommand: null }
  }
  return {
    path: file,
    installed: true,
    upToDate: found.entry.command === expectedCommand,
    currentCommand: found.entry.command
  }
}

export async function inspectAiTrackClaudeStopCheck(): Promise<ClaudeTrackHookStatus> {
  return inspectClaudeHookByMarker('Stop', CLAUDE_STOP_CHECK_MARKER, buildClaudeStopCheckCommand())
}

export async function installAiTrackClaudeStopCheck(): Promise<ClaudeTrackHookInstallResult> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const cmd = buildClaudeStopCheckCommand()
  const res = upsertClaudeHookEntry(settings, {
    hookType: 'Stop',
    matcher: null,
    marker: CLAUDE_STOP_CHECK_MARKER,
    finalCommand: cmd
  })
  await writeClaudeSettings(file, settings)
  return {
    path: file,
    replaced: res.replaced,
    previousCommand: res.previousCommand,
    finalCommand: cmd
  }
}

/**
 * v2.10.0 兼容清理:从 `~/.claude/settings.json` 的 `PostToolUse` 数组里删除
 * marker `# ai-productivity-mark-tool-called` 命中的老条目(以及该条目所属 group 的空壳).
 *
 * - 找不到 → no-op,返回 `{ removed: false, previousCommand: null }`,**不写盘**
 * - 找到一条 → 删除,group.hooks 空时连 group 一起删;返回 `{ removed: true, previousCommand: '<原命令>' }` 并写盘
 */
export async function cleanupLegacyClaudeMarkToolEntries(): Promise<{
  removed: boolean
  previousCommand: string | null
}> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = settings.hooks?.PostToolUse
  if (!Array.isArray(groups) || groups.length === 0) {
    return { removed: false, previousCommand: null }
  }

  let removed = false
  let previousCommand: string | null = null
  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    const group = groups[gi]
    if (!group || !Array.isArray(group.hooks)) continue
    for (let hi = group.hooks.length - 1; hi >= 0; hi -= 1) {
      const entry = group.hooks[hi]
      if (
        entry &&
        typeof (entry as ClaudeHookEntry).command === 'string' &&
        (entry as ClaudeHookEntry).command.includes(CLAUDE_MARK_TOOL_MARKER)
      ) {
        if (!removed) previousCommand = (entry as ClaudeHookEntry).command
        group.hooks.splice(hi, 1)
        removed = true
      }
    }
    // group.hooks 被清空且 matcher 是我们当年自动创建的(与 deprecated marker 配套)→ 一起删 group
    if (group.hooks.length === 0) {
      groups.splice(gi, 1)
    }
  }

  if (!removed) {
    return { removed: false, previousCommand: null }
  }

  // 当 PostToolUse 数组也空了,删除该 key 让 settings.json 干净
  if (groups.length === 0 && settings.hooks) {
    delete (settings.hooks as Record<string, unknown>).PostToolUse
  }

  await writeClaudeSettings(file, settings)
  return { removed: true, previousCommand }
}

/**
 * v2.13.0 兼容清理:从 `~/.claude/settings.json` 的 `Stop` 数组里删除
 * 命令片段包含 `~/.local/bin/ai-productivity.mjs` 的老 hook 条目.
 *
 * - 老条目背景见 `CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT` 注释
 * - 找不到 → no-op,返回 `{ removed: false, previousCommand: null }`,**不写盘**
 * - 找到一条/多条 → 全部删,group.hooks 空时连 group 一起删;返回 `removed=true` 且 `previousCommand` 取第一条命中(用于审计提示),写盘
 * - 一并处理:`Stop` 数组本身因清空也直接删 key,避免 settings.json 出现空数组
 */
export async function cleanupLegacyClaudeStopHookEntries(): Promise<{
  removed: boolean
  previousCommand: string | null
}> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = settings.hooks?.Stop
  if (!Array.isArray(groups) || groups.length === 0) {
    return { removed: false, previousCommand: null }
  }

  let removed = false
  let previousCommand: string | null = null
  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    const group = groups[gi]
    if (!group || !Array.isArray(group.hooks)) continue
    for (let hi = group.hooks.length - 1; hi >= 0; hi -= 1) {
      const entry = group.hooks[hi]
      if (
        entry &&
        typeof (entry as ClaudeHookEntry).command === 'string' &&
        (entry as ClaudeHookEntry).command.includes(CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT)
      ) {
        if (!removed) previousCommand = (entry as ClaudeHookEntry).command
        group.hooks.splice(hi, 1)
        removed = true
      }
    }
    if (group.hooks.length === 0) {
      groups.splice(gi, 1)
    }
  }

  if (!removed) {
    return { removed: false, previousCommand: null }
  }

  if (groups.length === 0 && settings.hooks) {
    delete (settings.hooks as Record<string, unknown>).Stop
  }

  await writeClaudeSettings(file, settings)
  return { removed: true, previousCommand }
}

/**
 * v2.13.0 inspect:仅检测,不删。前端拿到 `legacyLocalBinHookDetected=true` 时
 * 可在 Settings 卡片提示用户「点一次一键注入即可清理掉老 hook 入口」。
 */
async function detectLegacyClaudeStopHookEntry(): Promise<boolean> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = settings.hooks?.Stop
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue
    for (const entry of group.hooks) {
      if (
        entry &&
        typeof (entry as ClaudeHookEntry).command === 'string' &&
        (entry as ClaudeHookEntry).command.includes(CLAUDE_LEGACY_LOCAL_BIN_HOOK_FRAGMENT)
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * v2.10.0 inspect:仅检测,不删。前端拿到 `legacyMarkToolDetected=true` 时
 * 可在 Settings 卡片提示用户「点一次一键注入即可清理掉老条目」。
 */
async function detectLegacyClaudeMarkToolEntry(): Promise<boolean> {
  const file = defaultClaudeSettingsFile()
  const settings = await readClaudeSettings(file)
  const groups = settings.hooks?.PostToolUse
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue
    for (const entry of group.hooks) {
      if (
        entry &&
        typeof (entry as ClaudeHookEntry).command === 'string' &&
        (entry as ClaudeHookEntry).command.includes(CLAUDE_MARK_TOOL_MARKER)
      ) {
        return true
      }
    }
  }
  return false
}

// ===== v1.0.0 Codex hooks(~/.codex/hooks.json,Claude 同构 schema)=====
//
// Codex CLI 没有 afterAgentResponse 等价 hook(token/iteration 全走 CodexWatcher),
// 这里只装两类软数据 nudge:
//   - UserPromptSubmit:每轮 reminder(等价 Claude),提示 LLM 调 attach_summary(source=codex)
//   - Stop:stop-check 兜底(漏调 attach_summary 时打回补一次,复用 claude-code 方言输出)
// 两者均 marker 式覆盖 upsert,严格保留 hooks.json 里其它工具(codeisland / loongsuite 等)条目。

export const CODEX_STOP_CHECK_MARKER = '# ai-productivity-stop-check'

export function buildCodexStopCheckCommand(): string {
  return `${process.execPath} ${defaultMcpBinPath()} stop-check ${CODEX_STOP_CHECK_MARKER}`
}

export interface CodexTrackHookStatus {
  path: string
  reminderInstalled: boolean
  reminderUpToDate: boolean
  reminderCurrentCommand: string | null
  stopCheckInstalled: boolean
  stopCheckUpToDate: boolean
  stopCheckCurrentCommand: string | null
}

function codexHookGroups(
  settings: ClaudeSettingsLike,
  event: string
): ClaudeHookMatcherGroup[] | null {
  const hooks = settings.hooks as Record<string, unknown> | undefined
  const groups = hooks?.[event]
  return Array.isArray(groups) ? (groups as ClaudeHookMatcherGroup[]) : null
}

export async function inspectAiTrackCodexHook(): Promise<CodexTrackHookStatus> {
  const file = defaultCodexHooksFile()
  const settings = await readClaudeSettings(file)
  const reminderCmd = CODEX_TRACK_HOOK_REMINDER_COMMAND
  const stopCheckCmd = buildCodexStopCheckCommand()

  const reminderGroups = codexHookGroups(settings, 'UserPromptSubmit')
  const reminderFound = reminderGroups
    ? findClaudeEntryByMarker(reminderGroups, CODEX_TRACK_HOOK_REMINDER_MARKER)
    : null
  const stopGroups = codexHookGroups(settings, 'Stop')
  const stopFound = stopGroups ? findClaudeEntryByMarker(stopGroups, CODEX_STOP_CHECK_MARKER) : null

  return {
    path: file,
    reminderInstalled: !!reminderFound,
    reminderUpToDate: !!reminderFound && reminderFound.entry.command === reminderCmd,
    reminderCurrentCommand: reminderFound?.entry.command ?? null,
    stopCheckInstalled: !!stopFound,
    stopCheckUpToDate: !!stopFound && stopFound.entry.command === stopCheckCmd,
    stopCheckCurrentCommand: stopFound?.entry.command ?? null
  }
}

export interface CodexTrackHookInstallResult {
  path: string
  reminder: { replaced: boolean; previousCommand: string | null; finalCommand: string }
  stopCheck: { replaced: boolean; previousCommand: string | null; finalCommand: string }
}

/**
 * 在 ~/.codex/hooks.json 注入 / 更新 UserPromptSubmit reminder + Stop stop-check。
 *
 * 复用 Claude settings 的 upsert 逻辑(同构 JSON schema),marker 命中覆盖、不命中追加,
 * 绝不破坏其它事件 / 其它工具的 hook 条目。
 */
export async function installAiTrackCodexHook(): Promise<CodexTrackHookInstallResult> {
  const file = defaultCodexHooksFile()
  const settings = await readClaudeSettings(file)

  const reminderCmd = CODEX_TRACK_HOOK_REMINDER_COMMAND
  const stopCheckCmd = buildCodexStopCheckCommand()

  const reminderRes = upsertClaudeHookEntry(settings, {
    hookType: 'UserPromptSubmit',
    matcher: '*',
    marker: CODEX_TRACK_HOOK_REMINDER_MARKER,
    finalCommand: reminderCmd
  })
  const stopRes = upsertClaudeHookEntry(settings, {
    hookType: 'Stop',
    matcher: null,
    marker: CODEX_STOP_CHECK_MARKER,
    finalCommand: stopCheckCmd
  })

  await writeClaudeSettings(file, settings)

  return {
    path: file,
    reminder: {
      replaced: reminderRes.replaced,
      previousCommand: reminderRes.previousCommand,
      finalCommand: reminderCmd
    },
    stopCheck: {
      replaced: stopRes.replaced,
      previousCommand: stopRes.previousCommand,
      finalCommand: stopCheckCmd
    }
  }
}
