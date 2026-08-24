import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxConcurrency: 1,
    fileParallelism: false,
  },
});
