/**
 * 由 esbuild bundle 时通过 `define: { __AIPT_VERSION__: JSON.stringify(version) }` 注入,
 * tsx dev 模式下走 fallback。
 */
declare const __AIPT_VERSION__: string

export const VERSION: string =
  typeof __AIPT_VERSION__ !== 'undefined' ? __AIPT_VERSION__ : '0.0.0-dev'
