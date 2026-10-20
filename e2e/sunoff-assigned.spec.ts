import { test, expect } from '@playwright/test'
import bcrypt from 'bcryptjs'
import { db } from '../src/lib/db'
import { bootstrapOrganization } from '../src/lib/org/bootstrap'
import { encryptSecret } from '../src/lib/crypto'
import { facebookFormEventBody } from '../src/lib/call-center/meta-route'

const stamp = `sunoff-browser-${Date.now()}`, password = 'Synthetic-only-browser-42!'
let org = '', leadId = '', day = '', month = ''
test.beforeAll(async () => {
  if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Synthetic loopback DB required')
  const boot = await bootstrapOrganization(db, { name: 'SunOff source test', slug: stamp }); org = boot.organizationId
  const roleId = boot.roleIdByKey.get('SUPER_ADMIN')!
  const owner = await db.user.create({ data: { organizationId: org, roleId, name: 'Source Owner', email: `${stamp}@example.test`, passwordHash: await bcrypt.hash(password, 4) } })
  const rep = await db.user.create({ data: { organizationId: org, roleId, name: 'Gatsby', email: `${stamp}-rep@example.test`, passwordHash: 'synthetic-unused' } })
  leadId = `sunoff:${org}:browser`
  const startsAt = new Date(); startsAt.setUTCDate(startsAt.getUTCDate() + 1); startsAt.setUTCHours(17, 0, 0, 0)
  day = startsAt.toISOString().slice(0, 10); month = day.slice(0, 7)
  const secrets = { phoneLast4: '0123', phoneSecret: encryptSecret('+17025550123'), emailSecret: encryptSecret('synthetic@example.test') }
  await db.callCenterLead.create({ data: { id: leadId, organizationId: org, pageId: 'sunoff', source: 'FORM', language: 'EN', status: 'BOOKED', lockedBy: rep.id,
    phoneLast4: secrets.phoneLast4, phoneSecret: secrets.phoneSecret!, emailSecret: secrets.emailSecret!,
    leadAttribution: { sunoff: { id: 'browser', active: true, userId: '63', repKey: 'gatsby', stage: 'Scheduled', managed: true } },
    events: { create: { type: 'FORM', body: facebookFormEventBody({ leadgenId: 'browser', name: 'Alex Source', zip: '89117' }) } } } })
  await db.callCenterSlot.create({ data: { id: `sunoff:${org}:browser:visit`, organizationId: org, leadId, repKey: 'gatsby', startsAt, endsAt: new Date(startsAt.getTime() + 90 * 60000), heldBy: 'sunoff', language: 'EN' } })
  expect(owner.id).not.toBe(rep.id)
})
test.afterAll(async () => { if (org) await db.organization.delete({ where: { id: org } }); await db.$disconnect() })
test('source lead opens with native calling, source pills and stable desktop/mobile calendars', async ({ page }) => {
  await page.goto('/login'); await page.locator('#email').fill(`${stamp}@example.test`); await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL('**/board')
  await page.goto(`/call-center?lead=${encodeURIComponent(leadId)}`)
  await expect(page.locator('.who')).toContainText('Alex Source')
  await expect(page.locator('.who [aria-label="Source: SunOff"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Call', exact: true }).first()).toBeEnabled()
  await page.screenshot({ path: process.env.PF_QA_OUTPUT ? `${process.env.PF_QA_OUTPUT}/sunoff-lead-desktop.png` : 'test-results/sunoff-lead-desktop.png' })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/call-center?s=booked&view=day&date=${day}`)
    await expect(page.locator('.cal-block').filter({ hasText: 'Alex Source' })).toBeVisible()
    await expect(page.locator('.cal-block [aria-label="Source: SunOff"]').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.screenshot({ path: process.env.PF_QA_OUTPUT ? `${process.env.PF_QA_OUTPUT}/sunoff-calendar-${width}.png` : `test-results/sunoff-calendar-${width}.png` })
    await page.goto(`/board?month=${month}`)
    await expect(page.getByText('Alex Source', { exact: false }).first()).toBeVisible()
    const chip = page.locator('.chip').filter({ hasText: 'Alex Source' }).first()
    await expect(chip.locator('[aria-label="Source: SunOff"]')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await chip.click(); await expect(page).toHaveURL(/\/call-center\?lead=/)
  }
})
