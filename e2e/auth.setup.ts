import { expect, test as setup, type Page } from '@playwright/test'
import { BASE_URL, PORTAL_STATE, STAFF_STATE } from '../playwright.config'

/**
 * Logs in once per role and saves storageState; the staff/portal projects
 * depend on this and reuse the session instead of logging in per test.
 *
 * The post-login URL assertion doubles as the AUTH_URL override check: if the
 * .env AUTH_URL (real deployment host) leaked past webServer.env, Auth.js
 * would redirect off localhost:3499 and this fails loudly here rather than as
 * confusing downstream cookie errors.
 */

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: /sign in/i }).click()
  // The login server action redirects to the role home on success.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })

  const landed = page.url()
  expect(
    landed.startsWith(BASE_URL),
    `post-login redirect left the test origin (${landed}) — the .env AUTH_URL leaked past webServer.env`,
  ).toBeTruthy()
}

setup('authenticate: staff admin', async ({ page }) => {
  await login(page, 'admin@prodigyflo.ai', 'Demo!2345')
  await page.context().storageState({ path: STAFF_STATE })
})

setup('authenticate: portal client', async ({ page }) => {
  await login(page, 'client@prodigyflo.ai', 'Demo!2345')
  expect(new URL(page.url()).pathname.startsWith('/portal'), `client login landed on ${page.url()}`).toBeTruthy()
  await page.context().storageState({ path: PORTAL_STATE })
})
