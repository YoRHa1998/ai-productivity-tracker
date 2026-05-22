import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { extractIssueKey, getCurrentBranch } from './git.js'

/**
 * v2.8.0 mark-tool-called / stop-check 共用的「追踪上下文」解析器.
 *
 * 与 hook.ts 的 resolveProjectRoot 不同:
 *   - resolveProjectRoot 校验目录里有没有 .ai-productivity/ 子目录(老的 bindings 路径)
 *   - 这里只关心 git 分支是否含 Jira issueKey,以及对应 jiraKey 目录是否在
 *     ~/.ai-productivity-tracker/data/<jiraKey>/ 下有 requirement.json
 *     (即「该需求是否已经通过 ai_productivity_init 创建」)
 *
 * 任一不满足 → 返回 null,调用方据此 exit 0 静默放行.
 */

export interface TrackingContext {
  /** 命中的项目根目录(用于诊断;非必填) */
  projectRoot: string
  branch: string
  issueKey: string
}

function listCandidateRoots(parsed: Record<string, unknown> | null): string[] {
  const out: string[] = []
  const env = process.env.CURSOR_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR
  if (env && env.trim()) out.push(env.trim())

  const ws = process.env.WORKSPACE_FOLDER_PATHS
  if (ws && ws.trim()) {
    for (const seg of ws.split(':')) {
      const trimmed = seg.trim()
      if (trimmed) out.push(trimmed)
    }
  }

  if (parsed && Array.isArray((parsed as { workspace_roots?: unknown[] }).workspace_roots)) {
    for (const r of (parsed as { workspace_roots: unknown[] }).workspace_roots) {
      if (typeof r === 'string' && r) out.push(r)
    }
  }

  try {
    out.push(process.cwd())
  } catch {
    // 极端 cwd 失败时忽略
  }

  return out
}

export function resolveTrackingContext(
  parsed: Record<string, unknown> | null
): TrackingContext | null {
  for (const dir of listCandidateRoots(parsed)) {
    const branch = getCurrentBranch(dir)
    if (!branch) continue
    const issueKey = extractIssueKey(branch)
    if (!issueKey) continue
    return { projectRoot: dir, branch, issueKey }
  }
  return null
}

/**
 * 校验该 jiraKey 是否已通过 ai_productivity_init 创建本地需求目录.
 * 路径: ~/.ai-productivity-tracker/data/<jiraKey>/requirement.json
 *
 * 提供 rootOverride 以便测试(覆盖到一个隔离根,函数会在其下找
 * `data/<jiraKey>/requirement.json`).
 *
 * v1.0 兼容:存在 ~/.truesight-local-agent/ai-productivity/<jiraKey>/requirement.json 时
 * 也视为已初始化,便于老用户迁移期共存。
 */
export function isRequirementInitialized(jiraKey: string, rootOverride?: string): boolean {
  if (!jiraKey) return false
  const base = rootOverride ?? join(homedir(), '.ai-productivity-tracker')
  const file = join(base, 'data', jiraKey, 'requirement.json')
  if (existsSync(file)) return true
  if (rootOverride) return false
  const legacyFile = join(
    homedir(),
    '.truesight-local-agent',
    'ai-productivity',
    jiraKey,
    'requirement.json'
  )
  return existsSync(legacyFile)
}
