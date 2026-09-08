import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // DB-backed integration tests share one Postgres instance; running files in
    // parallel makes their fixtures collide.
    fileParallelism: false,
    // next-auth imports `next/server` extensionlessly; inlining routes it
    // through Vite so the aliases below apply.
    server: { deps: { inline: [/next-auth/, /@auth\/core/] } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` is a build-time guard; under Vitest the same modules are
      // imported directly, so it resolves to a no-op.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
      // `next` ships no ESM exports map, so extensionless subpath imports made
      // by next-auth (and by our own server modules) do not resolve under Vitest.
      'next/server': path.resolve(__dirname, 'node_modules/next/server.js'),
      'next/headers': path.resolve(__dirname, 'node_modules/next/headers.js'),
      'next/navigation': path.resolve(__dirname, 'node_modules/next/navigation.js'),
      'next/cache': path.resolve(__dirname, 'node_modules/next/cache.js'),
    },
  },
})
