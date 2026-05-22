import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.{spec,test}.ts', 'packages/*/__tests__/**/*.{spec,test}.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/__tests__/**',
        '**/*.spec.ts',
        '**/*.test.ts'
      ]
    }
  }
})
