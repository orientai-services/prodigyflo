import { defineConfig, devices } from '@playwright/test'

// Synthetic fixture suite; never use the demo seed or production dependencies.
export default defineConfig({
  testDir: './e2e', testMatch: 'workspace.spec.ts', fullyParallel: false, workers: 1,
  forbidOnly: !!process.env.CI, retries: 0, timeout: 60_000,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3499', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx next start -p 3499', url: 'http://localhost:3499/login', reuseExistingServer: false,
    env: { ...(process.env as Record<string, string>), AUTH_URL: 'http://localhost:3499', AUTH_TRUST_HOST: 'true', AUTH_SECRET: 'synthetic-workspace-e2e-only' },
  },
})
