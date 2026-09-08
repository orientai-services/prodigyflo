import { expect, test } from '@playwright/test'
import { navigationFor, SUBROUTES } from '../src/lib/navigation'
import { expectCleanPage } from './helpers'

/**
 * Staff smoke walk: every route the navigation exposes, plus the sales
 * sub-suite and one client detail page. Fails on any HTTP error, auth bounce,
 * missing h1, console error, or uncaught page exception.
 */

// A synthetic "sees everything" user keeps the route list in lockstep with
// src/lib/navigation.ts without depending on seed data or the RBAC runtime.
const allSeeingUser = {
  role: 'ADMIN',
  permissions: { has: () => true },
} as unknown as Parameters<typeof navigationFor>[0]

const NAV_ROUTES = navigationFor(allSeeingUser).flatMap((section) => section.items.map((item) => item.href))

// Sales sub-pages outside the nav. Some may not have shipped yet — those are
// skipped on 404 instead of failing the suite.
const SALES_ROUTES = [
  ...new Set([
    '/sales/hot-leads',
    '/sales/qualifier',
    '/sales/nurture',
    '/sales/ops',
    '/sales/coaching',
    '/sales/huddle',
    // Every ⌘K "Go deeper" route too — these live outside the top nav, so
    // without this a palette-only page (e.g. /sales/accuracy) ships untested.
    ...SUBROUTES.map((r) => r.href),
  ]),
]

test.describe('staff smoke', () => {
  for (const route of NAV_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      await expectCleanPage(page, route)
    })
  }

  for (const route of SALES_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      await expectCleanPage(page, route, { optional: true })
    })
  }

  test('renders a client detail page', async ({ page }) => {
    await page.goto('/clients')
    // First real client detail link — anything /clients/<id>, excluding the
    // static /clients/new and /clients/import routes. No seed-name reliance.
    const hrefs = await page
      .locator('a[href^="/clients/"]')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''))
    const detail = hrefs.find((href) => /^\/clients\/(?!new$|import$)[^/?#]+$/.test(href))

    test.skip(!detail, 'no client rows in the database — seed before running e2e')

    await expectCleanPage(page, detail!)
    expect(new URL(page.url()).pathname).toBe(detail)
  })
})
