import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/setup-mongo.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Serialize test files in a single worker — they share the same mongodb-memory-server
    // instance and would otherwise stomp on each other's collections between beforeEach hooks.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // mongodb-memory-server downloads MongoDB on first run + integration tests
    // hit a real (in-memory) Mongo so allow a generous ceiling.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['dist/**', 'node_modules/**', '**/*.test.ts'],
    },
  },
});
