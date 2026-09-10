import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'path'

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'file:./test.db'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 10_000,
    // Integration suites share one SQLite file — parallel files cause write contention
    fileParallelism: false,
    env: { DATABASE_URL: testDatabaseUrl },
    globalSetup: ['./tests/global-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
