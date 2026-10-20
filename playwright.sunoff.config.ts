import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'

// Source integration uses the production desk/calendar flags with loopback fixtures only.
export default defineConfig({
  testDir: './e2e', testMatch: 'sunoff-assigned.spec.ts', workers: 1, timeout: 60_000,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3499', trace: 'retain-on-failure' },
  webServer: { command: 'npx next start -p 3499', url: 'http://localhost:3499/login', reuseExistingServer: false,
    env: { ...(process.env as Record<string, string>), AUTH_URL: 'http://localhost:3499', AUTH_TRUST_HOST: 'true',
      AUTH_SECRET: 'synthetic-workspace-e2e-only', PRODIGYFLO_FINAL_DESK: 'true', CALL_CENTER_CALENDAR: 'true' } },
})
