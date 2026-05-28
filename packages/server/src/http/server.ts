import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { TranscriptWatcher } from '@ai-productivity-tracker/core'

import type { ServerConfig } from '../config.js'
import { extractToken, verifyToken } from './auth.js'
import { applyCors, isPanelOriginAllowed } from './cors.js'
import { serveStatic } from './static.js'
import { matchRoute, parseJson, readBody, badJsonResponse } from './util.js'

import {
  handleAiProductivityInit,
  handleAiProductivityStatus,
  handleAiProductivityWatcherStatus,
  handleAiProductivityHook,
  handleAiProductivityTurnStart,
  handleAiProductivityTurnThought,
  handleAiProductivityCursorHookStatus,
  handleAiProductivityInstallCursorHook,
  handleAiProductivityInstallMcpEntry,
  handleAiProductivityListRequirements,
  handleAiProductivityGetRequirement,
  handleAiProductivityListIterations,
  handleAiProductivityMergeSplitIterations,
  handleAiProductivityPatchRequirement,
  handleAiProductivityPatchSubtask,
  handleAiProductivitySummary,
  handleAiProductivityGetFormula,
  handleAiProductivityPatchFormula,
  handleAiProductivityGetJiraConfig,
  handleAiProductivityPatchJiraConfig,
  handleAiProductivityRefreshBugs,
  handleAiProductivitySyncJiraTitle,
  handleAiProductivityStoragePath,
  handleAiProductivityAttachSummary,
  handleAiProductivityTrackSkillStatus,
  handleAiProductivityInstallTrackSkill,
  handleAiProductivityListLessons,
  handleAiProductivityGetLesson,
  handleAiProductivityDeleteLesson,
  handleAiProductivityLessonsBundle,
  handleAiProductivityLatestCandidate,
  handleAiProductivitySaveLessons,
  handleAiProductivityRetrospectiveBundle,
  handleAiProductivityGetRetrospective,
  handleAiProductivitySaveRetrospective,
  handleAiProductivityDeleteRetrospective,
  type InitRequestBody,
  type HookRequestBody,
  type TurnStartRequestBody,
  type TurnThoughtRequestBody,
  type InstallCursorHookRequestBody,
  type InstallMcpEntryRequestBody,
  type PatchRequirementBody,
  type PatchSubtaskBody,
  type RefreshBugsBody,
  type MergeSplitIterationsRequestBody,
  type AttachSummaryRequestBody,
  type SaveLessonsRequestBody,
  type SaveRetrospectiveRequestBody
} from '../routes/ai-productivity.js'

export interface DaemonHandle {
  /** 真实监听端口(端口冲突 fallback 后可能与 config.port 不同) */
  port: number
  host: string
  server: Server
  /** 优雅停机:停 watcher → 关闭监听 → resolve */
  stop: () => Promise<void>
}

/**
 * 仅 IDE / Hook 主链路要求 Bearer token;其它 ai-productivity 路由属于
 * Web 看板设置面板的功能,走 panel-origin 放行。
 */
function isAiProductivityPanelPath(pathname: string): boolean {
  if (!pathname.startsWith('/ai-productivity/')) return false
  if (
    pathname === '/ai-productivity/init' ||
    pathname === '/ai-productivity/status' ||
    pathname === '/ai-productivity/hook' ||
    pathname === '/ai-productivity/turn-start' ||
    pathname === '/ai-productivity/turn-thought' ||
    pathname === '/ai-productivity/attach-summary'
  )
    return false
  return true
}

/**
 * 启动 daemon HTTP 服务。
 *
 * - 仅监听 127.0.0.1
 * - 默认放行 loopback origin,IDE/Hook 主链路要求 Bearer token
 * - transcript-watcher 在 daemon 进程内常驻;daemon 退出时一并停
 * - config.webRoot 给定时,挂载看板 SPA 静态服务
 *
 * `AIPT_DISABLE_TRANSCRIPT_WATCHER=1` 时跳过 watcher.start()(仍构造实例,handler 链路不变):
 * 主要给「dev daemon 与 prod daemon 同时跑」的本地开发场景 — 两个 daemon 同时监听
 * `~/.claude/projects/*.jsonl` 会产生重复 iteration + transcript-state.json 竞争。
 * 关闭后 dev daemon 退化为「纯读 + Web 看板 + API」模式,真实采集仍交给 prod daemon。
 */
export async function startDaemon(config: ServerConfig): Promise<DaemonHandle> {
  const currentConfig = config

  const transcriptWatcher = new TranscriptWatcher({
    log: (msg) => console.log(msg)
  })

  const server = createServer(async (req, res) => {
    try {
      if (applyCors(res, currentConfig, req)) return
      await handleRequest(req, res, currentConfig, transcriptWatcher)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
  })

  const watcherDisabled = process.env.AIPT_DISABLE_TRANSCRIPT_WATCHER === '1'
  if (watcherDisabled) {
    console.log(
      '[transcript-watcher] disabled via AIPT_DISABLE_TRANSCRIPT_WATCHER=1 (read-only daemon)'
    )
  } else {
    transcriptWatcher.start()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(currentConfig.port, currentConfig.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : currentConfig.port
  console.log(`ai-productivity-tracker daemon listening on http://${currentConfig.host}:${port}`)

  const stop = async (): Promise<void> => {
    transcriptWatcher.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return { port, host: currentConfig.host, server, stop }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  transcriptWatcher: TranscriptWatcher
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const method = req.method ?? 'GET'
  const pathname = url.pathname

  if (method === 'GET' && pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        code: 'OK',
        message: '',
        data: {
          port: config.port,
          host: config.host,
          version: process.env.AIPT_VERSION ?? '0.0.0-dev',
          dataRoot: config.dataRoot,
          startedAt: new Date().toISOString()
        }
      })
    )
    return
  }

  // 看板路由(同源/允许 origin)免 token;IDE / Hook 仍要 token
  const panelBypass = isAiProductivityPanelPath(pathname) && isPanelOriginAllowed(config, req)

  // /ai-productivity/* 主链路统一鉴权(panel-bypass 例外)
  if (pathname.startsWith('/ai-productivity/') && !panelBypass) {
    const tokenFromQuery = url.searchParams.get('token')
    const token = extractToken(req) || tokenFromQuery || ''
    if (!token || !verifyToken(token, config.token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
  }

  if (await routeAiProductivity(req, res, config, transcriptWatcher, method, pathname, url)) return

  // 静态资源 fallback(看板 SPA)
  if (method === 'GET' && config.webRoot) {
    if (serveStatic(res, config.webRoot, pathname === '/' ? '/index.html' : pathname)) {
      return
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

async function routeAiProductivity(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  transcriptWatcher: TranscriptWatcher,
  method: string,
  pathname: string,
  url: URL
): Promise<boolean> {
  let params: Record<string, string> | null

  // ── IDE / Hook 主链路 ───────────────────────────────────────────
  if (method === 'POST' && pathname === '/ai-productivity/init') {
    const body = parseJson(await readBody(req))
    if (!body) return (badJsonResponse(res), true)
    await handleAiProductivityInit(res, config, body as InitRequestBody)
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/status') {
    handleAiProductivityStatus(res, config, {
      projectRoot: url.searchParams.get('projectRoot') ?? undefined
    })
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/hook') {
    const body = parseJson(await readBody(req))
    if (!body) return (badJsonResponse(res), true)
    await handleAiProductivityHook(res, config, body as HookRequestBody)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/turn-start') {
    const body = parseJson(await readBody(req))
    if (!body) return (badJsonResponse(res), true)
    handleAiProductivityTurnStart(res, body as TurnStartRequestBody)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/turn-thought') {
    const body = parseJson(await readBody(req))
    if (!body) return (badJsonResponse(res), true)
    handleAiProductivityTurnThought(res, body as TurnThoughtRequestBody)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/attach-summary') {
    const body = parseJson(await readBody(req))
    if (!body) return (badJsonResponse(res), true)
    await handleAiProductivityAttachSummary(res, body as AttachSummaryRequestBody)
    return true
  }

  // ── 看板 panel(panel-origin 放行)─────────────────────────────
  if (method === 'GET' && pathname === '/ai-productivity/watcher-status') {
    handleAiProductivityWatcherStatus(res, config, () => transcriptWatcher.getStatus())
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/storage-path') {
    handleAiProductivityStoragePath(res)
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/cursor-hook-status') {
    handleAiProductivityCursorHookStatus(res)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/install-cursor-hook') {
    const raw = await readBody(req)
    const body = raw ? parseJson(raw) : null
    await handleAiProductivityInstallCursorHook(res, body as InstallCursorHookRequestBody | null)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/install-mcp-entry') {
    const raw = await readBody(req)
    const body = raw ? parseJson(raw) : null
    await handleAiProductivityInstallMcpEntry(res, body as InstallMcpEntryRequestBody | null)
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/track-skill-status') {
    await handleAiProductivityTrackSkillStatus(res)
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/install-track-skill') {
    await handleAiProductivityInstallTrackSkill(res)
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/summary') {
    handleAiProductivitySummary(res)
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/formula') {
    handleAiProductivityGetFormula(res)
    return true
  }

  if (method === 'PATCH' && pathname === '/ai-productivity/formula') {
    const body = parseJson(await readBody(req)) as Record<string, unknown> | null
    handleAiProductivityPatchFormula(
      res,
      (body ?? {}) as Parameters<typeof handleAiProductivityPatchFormula>[1]
    )
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/jira-config') {
    handleAiProductivityGetJiraConfig(res)
    return true
  }

  if (method === 'PATCH' && pathname === '/ai-productivity/jira-config') {
    const body = parseJson(await readBody(req)) as Record<string, unknown> | null
    handleAiProductivityPatchJiraConfig(
      res,
      (body ?? {}) as Parameters<typeof handleAiProductivityPatchJiraConfig>[1]
    )
    return true
  }

  if (method === 'GET' && pathname === '/ai-productivity/requirements') {
    handleAiProductivityListRequirements(res, {
      owner: url.searchParams.get('owner') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      project: url.searchParams.get('project') ?? undefined,
      q: url.searchParams.get('q') ?? undefined
    })
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey')
  if (params) {
    if (method === 'GET') {
      handleAiProductivityGetRequirement(res, params.jiraKey!)
      return true
    }
    if (method === 'PATCH') {
      const body = parseJson(await readBody(req))
      handleAiProductivityPatchRequirement(
        res,
        params.jiraKey!,
        (body ?? {}) as PatchRequirementBody
      )
      return true
    }
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/iterations')
  if (params && method === 'GET') {
    handleAiProductivityListIterations(res, params.jiraKey!)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/merge-split-iterations')
  if (params && method === 'POST') {
    const raw = await readBody(req)
    const body = raw ? (parseJson(raw) as MergeSplitIterationsRequestBody | null) : null
    handleAiProductivityMergeSplitIterations(res, params.jiraKey!, body)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/subtasks/:subtaskId')
  if (params && method === 'PATCH') {
    const body = parseJson(await readBody(req))
    handleAiProductivityPatchSubtask(
      res,
      params.jiraKey!,
      params.subtaskId!,
      (body ?? {}) as PatchSubtaskBody
    )
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/refresh-bugs')
  if (params && method === 'POST') {
    const raw = await readBody(req)
    const body = raw ? (parseJson(raw) as RefreshBugsBody | null) : null
    await handleAiProductivityRefreshBugs(res, params.jiraKey!, body ?? {})
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/sync-jira-title')
  if (params && method === 'POST') {
    await handleAiProductivitySyncJiraTitle(res, params.jiraKey!)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/lessons-bundle')
  if (params && method === 'GET') {
    handleAiProductivityLessonsBundle(res, params.jiraKey!)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/latest-candidate')
  if (params && method === 'GET') {
    handleAiProductivityLatestCandidate(res, params.jiraKey!)
    return true
  }

  // ── 单需求复盘报告 (retrospective) v1.0.0-rc.23 ─────────────────
  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/retrospective-bundle')
  if (params && method === 'GET') {
    handleAiProductivityRetrospectiveBundle(res, params.jiraKey!)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/requirements/:jiraKey/retrospective')
  if (params) {
    if (method === 'GET') {
      handleAiProductivityGetRetrospective(res, params.jiraKey!)
      return true
    }
    if (method === 'POST') {
      const body = parseJson(await readBody(req)) as SaveRetrospectiveRequestBody | null
      handleAiProductivitySaveRetrospective(res, params.jiraKey!, body)
      return true
    }
    if (method === 'DELETE') {
      handleAiProductivityDeleteRetrospective(res, params.jiraKey!)
      return true
    }
  }

  // ── lessons 端点(v2.16.0+ panel-origin 放行)──────────────────
  if (method === 'GET' && pathname === '/ai-productivity/lessons') {
    handleAiProductivityListLessons(res, {
      jiraKey: url.searchParams.get('jiraKey') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      tag: url.searchParams.get('tag') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      scope: url.searchParams.get('scope') ?? undefined,
      projectSlug: url.searchParams.get('projectSlug') ?? undefined
    })
    return true
  }

  if (method === 'POST' && pathname === '/ai-productivity/lessons') {
    const body = parseJson(await readBody(req)) as SaveLessonsRequestBody | null
    handleAiProductivitySaveLessons(res, body)
    return true
  }

  params = matchRoute(pathname, '/ai-productivity/lessons/:id')
  if (params) {
    if (method === 'GET') {
      handleAiProductivityGetLesson(res, params.id!)
      return true
    }
    if (method === 'DELETE') {
      handleAiProductivityDeleteLesson(res, params.id!)
      return true
    }
  }

  return false
}
