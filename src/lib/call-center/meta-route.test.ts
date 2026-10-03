import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SCS_ENGLISH_FORM_ID,
  SCS_ENGLISH_PAGE_ID,
  callCenterLeadId,
  callCenterMetaRoute,
  callCenterPersonName,
  claimLeadgenId,
  facebookFormEventBody,
  phoneLast4FromFields,
} from './meta-route'

describe('call center meta route', () => {
  it('sends the SCS English Page to Call Center', () => {
    expect(callCenterMetaRoute({ pageId: SCS_ENGLISH_PAGE_ID, formId: '1' })).toBe('call-center')
    expect(callCenterMetaRoute({ pageId: ` ${SCS_ENGLISH_PAGE_ID} `, formId: null })).toBe('call-center')
  })

  it('sends the SCS English form to Call Center even from another page', () => {
    expect(callCenterMetaRoute({ pageId: '999000111', formId: SCS_ENGLISH_FORM_ID })).toBe('call-center')
  })

  it('leaves every other page on the existing client path', () => {
    expect(callCenterMetaRoute({ pageId: '111', formId: '222' })).toBe('client')
    expect(callCenterMetaRoute({ pageId: null, formId: null })).toBe('client')
    expect(callCenterMetaRoute({})).toBe('client')
  })

  it('does not open a second row for a duplicate leadgen id', () => {
    const first = claimLeadgenId([], '1864578424713034')
    expect(first.created).toBe(true)
    const second = claimLeadgenId(first.stored, '1864578424713034')
    expect(second.created).toBe(false)
    expect(second.stored).toEqual(['1864578424713034'])
    expect(callCenterLeadId('org-1', '1864578424713034')).toBe(callCenterLeadId('org-1', '1864578424713034'))
  })

  it('keeps only the last four digits of a phone number', () => {
    const fields = {
      full_name: 'Pat Example',
      phone_number: '+1 (702) 555-0199',
      email: 'secret-person@example.test',
      zip_code: '89117',
    }
    expect(phoneLast4FromFields(fields)).toBe('0199')
    const body = facebookFormEventBody({
      leadgenId: 'lg-1',
      name: callCenterPersonName(fields),
      zip: '89117',
    })
    expect(body).toContain('Facebook form')
    expect(body).toContain('Pat Example')
    expect(body).not.toContain('7025550199')
    expect(body).not.toContain('555-0199')
    expect(body).not.toContain('secret-person@example.test')
    expect(callCenterPersonName({ full_name: '+1 (702) 555-0199' })).toBe('Facebook lead')
  })

  it('keeps the signature check and the not-configured response on the webhook', () => {
    const route = readFileSync(path.join(process.cwd(), 'src/app/api/meta/leads/route.ts'), 'utf8')
    expect(route).toContain("error: 'Invalid signature.'")
    expect(route).toContain("error: 'Meta Ads not configured.'")
    expect(route).toContain('status: 503')
    expect(route).toContain('callCenterMetaRoute')
    expect(route).toContain('igniteLead')
    expect(route).not.toMatch(/twilio/i)
    expect(route).not.toMatch(/process\.env/)
  })
})
