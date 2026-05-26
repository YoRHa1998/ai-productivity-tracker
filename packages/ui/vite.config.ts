import { defineConfig, type PluginOption } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { fileURLToPath } from 'node:url'

// UnoCSS 的 vite plugin 在 monorepo 中可能被 vitest 拉的 vite@5 干扰类型推导,
// 显式 cast 到 vite@6 的 PluginOption 避免 vue-tsc 报跨版本类型不兼容。
export default defineConfig({
  plugins: [UnoCSS() as PluginOption, vue()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    // 看板产物直接落到 cli 包内,daemon 通过 webRoot 静态托管
    outDir: '../cli/dist/web',
    emptyOutDir: true,
    // npm tarball 默认不含 sourcemap;本地排错可 AIPT_BUILD_SOURCEMAP=1 pnpm build
    sourcemap: process.env.AIPT_BUILD_SOURCEMAP === '1',
    rollupOptions: {
      output: {
        manualChunks: {
          'element-plus': ['element-plus'],
          // echarts/core + 按需 chart/component 单独拆 chunk,首屏 lazy 加载
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          'vue-echarts': ['vue-echarts']
        }
      }
    }
  },
  server: {
    port: 17351,
    proxy: {
      // 开发态把 /ai-productivity 请求代理到本地 daemon
      '/ai-productivity': {
        target: process.env.AIPT_DAEMON_URL ?? 'http://127.0.0.1:17350',
        changeOrigin: true
      },
      '/status': {
        target: process.env.AIPT_DAEMON_URL ?? 'http://127.0.0.1:17350',
        changeOrigin: true
      }
    }
  }
})
