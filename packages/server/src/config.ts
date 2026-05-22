/**
 * Daemon 进程配置(运行时注入)。
 *
 * 比起源仓库 `apps/local-agent-service/src/types.ts ServiceConfig` 大幅精简,
 * 只保留 ai-productivity 域真正用到的字段。
 */
export interface ServerConfig {
  /** 监听端口,默认 17350 */
  port: number
  /** 监听地址,固定 127.0.0.1 */
  host: string
  /** Bearer token(IDE/Hook 鉴权用);看板同源访问免 token */
  token: string
  /** 额外放行的 Origin(默认空数组,只放 loopback) */
  allowedOrigins: string[]
  /** 数据根目录,缺省时由 core/store/paths.ts 解析 */
  dataRoot?: string
  /** dist/web/ 看板静态资源根目录;缺省时 daemon 不挂载静态路由(MCP-only 模式) */
  webRoot?: string
}
