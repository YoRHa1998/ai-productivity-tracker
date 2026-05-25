import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue()],
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
          marked: ['marked']
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
