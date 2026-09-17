import { describe, expect, it } from 'vitest'
import { parseIntakeBooking } from './appointment'

describe('parseIntakeBooking', () => {
  it('reads SCS data.booking.scheduled_at', () => {
    const b = parseIntakeBooking({
      lead_id: 'abc',
      data: {
        booking: {
          scheduled_at: '2026-09-17T18:30:00.000Z',
          ends_at: '2026-09-17T18:55:00.000Z',
          calendly_event_uri: 'https://api.calendly.com/scheduled_events/ab14c097',
          timezone: 'America/Los_Angeles',
        },
      },
    })
    expect(b?.startsAt.toISOString()).toBe('2026-09-17T18:30:00.000Z')
    expect(b?.endsAt.toISOString()).toBe('2026-09-17T18:55:00.000Z')
    expect(b?.externalEventId).toContain('ab14c097')
    expect(b?.timezone).toBe('America/Los_Angeles')
  })

  it('returns null when no start time is present', () => {
    expect(parseIntakeBooking({ lead_id: 'abc', data: { status: 'booked' } })).toBeNull()
    expect(parseIntakeBooking(null)).toBeNull()
  })
})
