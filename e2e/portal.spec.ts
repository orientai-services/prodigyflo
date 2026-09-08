import { test } from '@playwright/test'
import { expectCleanPage } from './helpers'

/**
 * Client portal smoke walk, authenticated as the seeded portal client. The
 * portal is a single-page app today (/portal plus API routes); add hrefs here
 * as portal routes ship.
 */

const PORTAL_ROUTES = ['/portal']

test.describe('portal smoke', () => {
  for (const route of PORTAL_ROUTES) {
    test(`renders ${route}`, async ({ page }) => {
      await expectCleanPage(page, route)
    })
  }
})
