import { describe, expect, it } from 'vitest'
import { missingPacketKinds, QUEUE_BUCKETS, queueReasons } from '@/lib/daily-desk-queue'

describe('queueReasons', () => {
  it('emits the four desk buckets independently', () => {
    const reasons = queueReasons({
      ownerId: null,
      hasUpcomingAppointment: false,
      missingDocLabels: ['UCC Fixture / Lien', 'Utility bill'],
      cysBlockers: ['"Email" is missing.'],
    })
    expect(reasons.map((r) => r.bucket)).toEqual([...QUEUE_BUCKETS])
  })

  it('stays quiet when the file is owned, booked, documented, and CYS-clean', () => {
    expect(
      queueReasons({
        ownerId: 'u1',
        hasUpcomingAppointment: true,
        missingDocLabels: [],
        cysBlockers: [],
      }),
    ).toEqual([])
  })
})

describe('missingPacketKinds', () => {
  it('treats UCC / deed / permit / production as missing when no file exists', () => {
    const missing = missingPacketKinds([
      { requirementKey: 'photo_id', detectedTypeKey: null, label: null, hasFile: true },
    ])
    expect(missing).toContain('UCC Fixture / Lien')
    expect(missing).toContain('Homeownership Deed')
    expect(missing).toContain('County Permit Record')
    expect(missing).toContain('Solar Production Report')
    expect(missing).not.toContain('Government ID')
  })
})
