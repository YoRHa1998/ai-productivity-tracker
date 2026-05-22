/**
 * 独立化项目里没有平台账号体系。
 *
 * 看板"owner"字段(谁创建/拥有这个需求)以 OS 当前用户名兜底,无需用户登录。
 * 远期(v1.x)若需要多人协作可以扩展为读 git config user.name 或外部账号体系,
 * 当前 stub 返回 daemon /status 中可暴露的 osUser(暂时空串,前端会优雅显示「-」)。
 */
export interface SessionInfo {
  name: string
  email?: string
}

export async function fetchCurrentSession(): Promise<SessionInfo> {
  // 浏览器侧无法直接读 OS 用户名;留给前端从 localStorage 读用户自定义昵称(可选)。
  if (typeof window !== 'undefined') {
    const cached = window.localStorage.getItem('aipt:owner-name')
    if (cached && cached.trim()) return { name: cached.trim() }
  }
  return { name: '' }
}
