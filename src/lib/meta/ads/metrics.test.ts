import { describe, expect, it } from 'vitest'
import {
  accountStatusWords, billingUrl, computeMetrics, fundingTracksPayments, fundingWords, healthFlags, leadsFromActions,
  minorToCents, minorToMajor, sumsFromInsight, zeroLeadStreak,
} from './metrics'

describe('metrics', () => {
  it('ratios are null on zero, never NaN or Infinity', () => {
    const m = computeMetrics({ spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, leads: 0, landingPageViews: 0 })
    expect([m.cpl, m.ctr, m.cpc, m.cpm, m.frequency]).toEqual([null, null, null, null, null])
  })
  it('computes CPL, link CTR (%), CPC, CPM and frequency', () => {
    const m = computeMetrics({ spend: 100, impressions: 20000, reach: 8000, clicks: 400, linkClicks: 300, leads: 8, landingPageViews: 200 })
    expect(m.cpl).toBe(12.5)
    expect(m.ctr).toBe(1.5)
    expect(m.cpc).toBe(0.33)
    expect(m.cpm).toBe(5)
    expect(m.frequency).toBe(2.5)
  })
  it("prefers Meta's own frequency for a window", () => {
    expect(computeMetrics({ spend: 1, impressions: 10, reach: 5, clicks: 0, linkClicks: 0, leads: 0, landingPageViews: 0, frequency: 1.234 }).frequency).toBe(1.23)
  })
  it('leads: lead_grouped first, else lead (fixed order)', () => {
    expect(leadsFromActions([{ action_type: 'lead', value: '9' }, { action_type: 'onsite_conversion.lead_grouped', value: '4' }])).toBe(4)
    expect(leadsFromActions([{ action_type: 'lead', value: '9' }])).toBe(9)
    expect(leadsFromActions([{ action_type: 'link_click', value: '9' }])).toBe(0)
    expect(leadsFromActions(undefined)).toBe(0)
  })
  it('reads an insight row; spend is already in major units', () => {
    const s = sumsFromInsight({ spend: '12.34', impressions: '1000', reach: '700', clicks: '30', inline_link_clicks: '20', actions: [{ action_type: 'landing_page_view', value: '15' }, { action_type: 'lead', value: '2' }] })
    expect(s).toMatchObject({ spend: 12.34, impressions: 1000, reach: 700, clicks: 30, linkClicks: 20, leads: 2, landingPageViews: 15 })
  })
})

describe('units and words', () => {
  it('minor units → major, zero-decimal currencies untouched', () => {
    expect(minorToMajor('12345', 'USD')).toBe(123.45)
    expect(minorToMajor('500', 'JPY')).toBe(500)
    expect(minorToMajor(null)).toBeNull()
    expect(minorToMajor('x')).toBeNull()
    expect(minorToCents('-150')).toBe(BigInt(-150))
    expect(minorToCents('1.5')).toBeNull()
  })
  it('status words', () => {
    expect(accountStatusWords(1)).toEqual({ words: 'Active', tone: 'ok' })
    expect(accountStatusWords(3)).toEqual({ words: 'Unpaid', tone: 'bad' })
    expect(accountStatusWords(9)).toEqual({ words: 'Grace period', tone: 'bad' })
    expect(accountStatusWords(7)).toEqual({ words: 'In review', tone: 'warn' })
    expect(accountStatusWords(55)).toEqual({ words: 'Unknown (code 55)', tone: 'warn' })
  })
  it('funding words and the detector rule', () => {
    expect(fundingWords(1)).toBe('Card')
    expect(fundingWords(13)).toBe('PayPal')
    expect(fundingWords(77)).toBe('Other')
    expect(fundingTracksPayments(1)).toBe(true)
    expect(fundingTracksPayments(17)).toBe(true)
    expect(fundingTracksPayments(2)).toBe(false)
  })
  it('billing link is built from the allowed digits only', () => {
    expect(billingUrl('act_1742876583597558')).toBe('https://business.facebook.com/billing_hub/accounts/details?asset_id=1742876583597558')
    expect(billingUrl('act_mock_x')).toBe('https://business.facebook.com/billing_hub/accounts')
  })
})

describe('health badges', () => {
  it('zero-lead streak counts trailing spend days without leads', () => {
    expect(zeroLeadStreak([
      { date: '2026-10-01', spend: 10, leads: 2 },
      { date: '2026-10-02', spend: 10, leads: 0 },
      { date: '2026-10-03', spend: 10, leads: 0 },
    ])).toBe(2)
    expect(zeroLeadStreak([{ date: '2026-10-03', spend: 0, leads: 0 }])).toBe(0)
  })
  it('high frequency and low CTR', () => {
    const m = computeMetrics({ spend: 50, impressions: 5000, reach: 1500, clicks: 40, linkClicks: 30, leads: 1, landingPageViews: 0 })
    expect(healthFlags(m)).toEqual({ highFrequency: true, lowCtr: true })
    const few = computeMetrics({ spend: 5, impressions: 500, reach: 400, clicks: 1, linkClicks: 1, leads: 0, landingPageViews: 0 })
    expect(healthFlags(few).lowCtr).toBe(false) // under 1,000 impressions
  })
})
