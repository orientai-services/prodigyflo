import { defineConfig, devices } from '@playwright/test'

/**
 * E2E smoke suite. Prereqs:
 *   1. Postgres up + seeded (`npm run db:seed`) — the suite logs in as the
 *      seeded demo accounts but asserts structure, never seed-specific copy.
 *   2. `npm run build` — the webServer below runs `next start` only; it never
 *      builds. A stale/missing .next fails fast at server startup.
 *
 * AUTH_URL override: the repo's .env points AUTH_URL at the real deployment
 * host, which would break Auth.js redirects/cookies against localhost. We set
 * AUTH_URL/AUTH_TRUST_HOST in webServer.env instead. This wins because Next's
 * own dotenv loading (@next/env loadEnvConfig) never overwrites keys that are
 * already present in process.env — a variable set in the child process env
 * takes precedence over .env. e2e/auth.setup.ts double-checks this at runtime:
 * if .env leaked in, the post-login redirect would leave localhost:3499 and the
 * setup test fails with an explicit message.
 */

const PORT = 3499
export const BASE_URL = `http://localhost:${PORT}`

export const STAFF_STATE = 'e2e/.auth/staff.json'
export const PORTAL_STATE = 'e2e/.auth/portal.json'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Single worker: routes hit one shared dev database; keep runs deterministic.
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'staff',
      testMatch: /smoke\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STAFF_STATE },
    },
    {
      name: 'portal',
      testMatch: /portal\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: PORTAL_STATE },
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ...(process.env as Record<string, string>),
      AUTH_URL: BASE_URL,
      AUTH_TRUST_HOST: 'true',
    },
  },
})
