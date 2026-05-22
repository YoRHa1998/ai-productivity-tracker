/**
 * `@ai-productivity-tracker/server`
 *
 * 提供 daemon 启动函数 + 全部路由 / skill-sync;被 cli `daemon` 子命令消费,
 * 编译时 esbuild bundle 内联进 dist/cli.mjs。
 */

export { startDaemon, type DaemonHandle } from './http/server.js'
export type { ServerConfig } from './config.js'
export * from './skill-sync.js'
export * as routes from './routes/ai-productivity.js'
