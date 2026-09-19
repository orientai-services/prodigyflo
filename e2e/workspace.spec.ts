import { test, expect, type Page } from '@playwright/test'
import bcrypt from 'bcryptjs'
import { db } from '../src/lib/db'
import { bootstrapOrganization } from '../src/lib/org/bootstrap'

const url = new URL(process.env.DATABASE_URL!)
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Workspace browser tests require a loopback synthetic database.')
const stamp = `browser-${Date.now()}`
const password = 'Synthetic-test-password-42!'
let org: string, clientA: string, clientB: string
async function login(page: Page, role: string) {
  await page.goto('/login')
  await page.locator('#email').fill(`${stamp}-${role}@example.test`)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL('**/board')
}
test.beforeAll(async () => {
  const result = await bootstrapOrganization(db, { name: 'Team Prodigy', slug: stamp })
  org = result.organizationId
  const pipeline = await db.pipeline.findFirstOrThrow({ where: { organizationId: org, isDefault: true }, include: { stages: { orderBy: { position: 'asc' } } } })
  for (const role of ['admin', 'closera', 'closerb', 'retired']) {
    const user = await db.user.create({ data: { organizationId: org, roleId: result.roleIdByKey.get(role === 'admin' ? 'SUPER_ADMIN' : 'CLOSER')!, name: role, email: `${stamp}-${role}@example.test`, passwordHash: await bcrypt.hash(password, 4), isActive: role !== 'retired' } })
    if (role === 'closera' || role === 'closerb') {
      const client = await db.client.create({ data: { organizationId: org, pipelineId: pipeline.id, currentStageId: pipeline.stages[0].id, ownerId: user.id, firstName: role === 'closera' ? 'Alice' : 'Brenda', lastName: 'Synthetic', email: `${role}@example.test`, phone: '7025550100' } })
      if (role === 'closera') clientA = client.id; else clientB = client.id
      await db.appointment.create({ data: { clientId: client.id, ownerId: user.id, type: 'PRESENTATION', startsAt: new Date('2090-01-15T18:00:00Z'), endsAt: new Date('2090-01-15T19:00:00Z') } })
    }
  }
})
test.afterAll(async () => { if (org) await db.organization.delete({ where: { id: org } }); await db.$disconnect() })
test('Super Admin sees the full calendar and shared Closer permissions', async ({ page }) => {
  await login(page, 'admin')
  await page.goto('/board?month=2090-01')
  await expect(page.getByText('Alice', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Brenda', { exact: false }).first()).toBeVisible()
  await expect(page.locator('a[href="/pipeline"]').first()).toBeVisible()
  await expect(page.locator('a[href="/engine"]')).toHaveCount(0)
  await page.goto('/settings/users')
  await expect(page.getByRole('heading', { name: 'Closer permissions' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save Closer permissions' })).toBeVisible()
})
test('Closer sees only assigned appointments and a complete 42-item profile with upload controls', async ({ page }) => {
  await login(page, 'closera')
  await page.goto('/board?month=2090-01')
  await expect(page.getByText('Alice', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('Brenda', { exact: false })).toHaveCount(0)
  await expect(page.locator('a[href="/pipeline"]')).toHaveCount(0)
  await page.goto(`/clients/${clientA}`)
  await expect(page.getByText('42 items', { exact: false })).toBeVisible()
  await expect(page.locator('.desk-table tbody tr')).toHaveCount(42)
  await expect(page.getByRole('button', { name: /upload/i }).first()).toBeVisible()
  const missing = page.locator('.desk-table tbody tr').filter({ hasText: 'Current payoff' })
  await expect(missing).toContainText('Missing')
  await missing.getByRole('button').click()
  await missing.getByRole('textbox', { name: 'Value for Current payoff' }).fill('12345')
  await missing.getByRole('button', { name: 'Save value' }).click()
  await expect(missing).toContainText('12345')
  await page.reload()
  await expect(page.locator('.desk-table tbody tr').filter({ hasText: 'Current payoff' })).toContainText('12345')
  const response = await page.goto(`/clients/${clientB}`)
  expect(response?.status()).toBe(404)
  await expect(page.getByText('Brenda Synthetic')).toHaveCount(0)
  await page.goto('/pipeline'); await expect(page).toHaveURL(/\/forbidden$/)
  await page.goto('/settings/users'); await expect(page).toHaveURL(/\/forbidden$/)
  await page.goto('/settings/profile'); await expect(page).toHaveURL(/\/settings\/profile$/)
})
test('inactive historical identities cannot sign in', async ({ page }) => {
  await page.goto('/login')
  await page.locator('#email').fill(`${stamp}-retired@example.test`)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'not recognized' })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})
