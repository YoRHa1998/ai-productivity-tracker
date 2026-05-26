import { defineConfig, presetAttributify, presetIcons, presetUno } from 'unocss'

/**
 * UnoCSS 仅服务新外壳 / 图表卡 / Layout 类原子样式与按需图标。
 *
 * 现有 `aip-shared.css` 及 Tab 内 BEM 类不强制迁移,继续可读;UnoCSS 通过 attributify 模式
 * 允许 `<div m="4" p-x="2" flex>` 简写,避免重复手写 padding/margin/flex 等高频组合。
 *
 * presetIcons + @iconify-json/lucide 实现 `<i class="i-lucide-home" />` 按需取图标,
 * 单包内只编译被引用过的图标,产物零冗余;icons 默认走 mask 方式 currentColor 染色。
 */
export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons({
      scale: 1.1,
      cdn: undefined,
      collections: {
        // lucide 是 ~1500 个图标的开源 set;按需扫描,只打包被引用过的
        lucide: () => import('@iconify-json/lucide/icons.json').then((m) => m.default)
      },
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle'
      }
    })
  ],
  theme: {
    colors: {
      aurora1: '#6ea7f5',
      aurora2: '#86c5e8',
      aurora3: '#f0a6c8',
      aurora4: '#9fe5d4',
      glass: 'rgba(255,255,255,0.04)'
    },
    fontFamily: {
      mono: '"SF Mono", Menlo, Monaco, Consolas, monospace'
    }
  },
  shortcuts: {
    'aurora-text':
      'bg-gradient-to-r from-aurora1 via-aurora2 to-aurora4 bg-clip-text text-transparent',
    'aurora-bg': 'bg-gradient-to-br from-aurora1 via-aurora2 to-aurora4'
  },
  // 扫描所有 .vue / .ts 文件;包含 attributify
  content: {
    pipeline: {
      include: [/\.(vue|ts|tsx|html)($|\?)/]
    }
  }
})
