import { expect, test, type Page, type Response } from '@playwright/test'

/**
 * Shared walk logic: navigate to a route and assert it renders like a healthy
 * page — HTTP OK, no auth bounce, a visible h1 (every page ships a PageHeader
 * or an equivalent heading), and zero console errors / uncaught exceptions.
 * Assertions are structural on purpose: nothing here depends on seed copy.
 */

export type WalkOptions = {
  /** Route may not exist yet — skip the test on a 404 instead of failing. */
  optional?: boolean
}

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`)
  })
  return errors
}

export async function expectCleanPage(page: Page, route: string, opts: WalkOptions = {}): Promise<void> {
  const errors = collectPageErrors(page)

  const response: Response | null = await page.goto(route)
  expect(response, `no response navigating to ${route}`).not.toBeNull()

  if (opts.optional && response!.status() === 404) {
    test.skip(true, `${route} is not shipped yet (404) — skipping`)
  }

  expect(response!.ok(), `${route} responded ${response!.status()}`).toBeTruthy()

  // An auth bounce returns 200 for /login or /forbidden — that is a failure of
  // the walked route, not a pass.
  const landed = new URL(page.url()).pathname
  expect(landed, `${route} bounced to ${landed} (auth/permission regression)`).not.toMatch(/^\/(login|forbidden)/)

  await expect(page.locator('h1').first(), `${route} has no visible h1/PageHeader`).toBeVisible()

  // Give client islands a beat to hydrate and surface late errors. networkidle
  // can never settle on pages that poll, so cap it and move on.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})

  expect(errors, `console errors on ${route}:\n${errors.join('\n')}`).toEqual([])
}
