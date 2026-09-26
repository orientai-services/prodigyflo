/**
 * Company-level operating status for a named installer or lender.
 *
 * A match selects a court record or a checked "no filing" note.
 * It does not copy another client's facts, and it does not say this
 * contract was assumed, rejected, or released.
 * An unknown name stays unconfirmed. Never invent a bankruptcy.
 *
 * Checked 2026-09-26. A later filing replaces the old note only after
 * the case number is added here.
 */

export type PartyStanding =
  | 'chapter7'
  | 'chapter11_wound_down'
  | 'chapter11_emerged'
  | 'operating'
  | 'acquired'

export type PartyRecord = {
  label: string
  standing: PartyStanding
  chip: string
  record: string
  asOf: string
}

export const PARTY_STATUS_AS_OF = '2026-09-26'

const SPLIT = 'The installer’s workmanship warranty and the finance contract are different parties. A bankruptcy does not by itself cancel the loan or lease, and it does not prove this client’s claim.'

type Entry = { test: RegExp; record: PartyRecord }

const ENTRIES: Entry[] = [
  {
    test: /titan solar power nv/i,
    record: {
      label: 'Titan Solar Power NV, Inc.',
      standing: 'chapter7',
      chip: 'Chapter 7 liquidation',
      asOf: PARTY_STATUS_AS_OF,
      record: `Titan Solar Power NV, Inc. is a Chapter 7 debtor in the Titan cases, District of Arizona, case 2:24-bk-05025-MCW. The lead case is PM & M Electric, Inc. dba Titan Solar Power, 2:24-bk-04978-MCW, filed June 20, 2024. Chapter 7 is a liquidation. ${SPLIT}`,
    },
  },
  {
    test: /titan solar|pm\s*&\s*m electric/i,
    record: {
      label: 'Titan Solar Power',
      standing: 'chapter7',
      chip: 'Chapter 7 liquidation',
      asOf: PARTY_STATUS_AS_OF,
      record: `Titan Solar Power filed Chapter 7 through PM & M Electric, Inc. dba Titan Solar Power, District of Arizona, case 2:24-bk-04978-MCW, on June 20, 2024. Related Titan companies are in the same jointly administered cases. Chapter 7 is a liquidation. ${SPLIT}`,
    },
  },
  {
    test: /freedom forever|freedom solar/i,
    record: {
      label: 'Freedom Forever',
      standing: 'chapter7',
      chip: 'Chapter 7 reported',
      asOf: PARTY_STATUS_AS_OF,
      record: `Freedom Forever filed Chapter 11 on April 15, 2026, District of Delaware, case 26-10522. A September 2026 report says that case converted to Chapter 7 on August 7, 2026. Confirm the conversion on the docket before telling the client the company is liquidated. ${SPLIT}`,
    },
  },
  {
    test: /pink energy|power\s*home solar|powerhome/i,
    record: {
      label: 'Pink Energy',
      standing: 'chapter7',
      chip: 'Chapter 7 liquidation',
      asOf: PARTY_STATUS_AS_OF,
      record: `Pink Energy, formerly Power Home Solar, filed Chapter 7 on October 7, 2022, Western District of North Carolina, case 22-50228. The company was liquidated. ${SPLIT}`,
    },
  },
  {
    test: /sunpower/i,
    record: {
      label: 'SunPower',
      standing: 'chapter11_wound_down',
      chip: 'Chapter 11, wound down',
      asOf: PARTY_STATUS_AS_OF,
      record: `SunPower Corporation filed Chapter 11 on August 5, 2024, District of Delaware, case 24-11649. A liquidating plan became effective November 14, 2024. The residential lease and PPA book was reported to move to a servicer. The name on this contract stays the name printed on the agreement. This is not a finding that this client’s contract was assumed or rejected.`,
    },
  },
  {
    test: /sunnova/i,
    record: {
      label: 'Sunnova',
      standing: 'chapter11_wound_down',
      chip: 'Chapter 11, wound down',
      asOf: PARTY_STATUS_AS_OF,
      record: `Sunnova filed Chapter 11 on June 8, 2025, Southern District of Texas, case 25-90160. The case was a sale and wind-down. A plan became effective November 14, 2025. Servicing of the book was reported to move. ${SPLIT}`,
    },
  },
  {
    test: /mosaic/i,
    record: {
      label: 'Mosaic',
      standing: 'chapter11_emerged',
      chip: 'Chapter 11, exited',
      asOf: PARTY_STATUS_AS_OF,
      record: `Solar Mosaic filed Chapter 11 in June 2025 and exited in September 2025. Servicing of the loan book changed hands. This note does not name the successor, because the public reports disagree. ${SPLIT}`,
    },
  },
  {
    test: /sunlight/i,
    record: {
      label: 'Sunlight Financial',
      standing: 'chapter11_emerged',
      chip: 'Chapter 11, emerged',
      asOf: PARTY_STATUS_AS_OF,
      record: `Sunlight Financial filed Chapter 11 in Delaware, case 23-11794. The plan became effective December 6, 2023, and the company emerged. This is not a liquidation. ${SPLIT}`,
    },
  },
  {
    test: /goodleap|loanpal/i,
    record: {
      label: 'GoodLeap',
      standing: 'operating',
      chip: 'No filing in registry',
      asOf: PARTY_STATUS_AS_OF,
      record: 'No bankruptcy of GoodLeap, or of its earlier name Loanpal, is in this registry. GoodLeap was still originating loans and appearing in other companies’ cases in 2026. That is not a finding that this loan is enforceable.',
    },
  },
  {
    test: /sunrun/i,
    record: {
      label: 'Sunrun',
      standing: 'operating',
      chip: 'No filing in registry',
      asOf: PARTY_STATUS_AS_OF,
      record: 'No bankruptcy filing for Sunrun is in this registry. Sunrun published second-quarter 2026 results on August 5, 2026. This was checked against that public record as of September 18, 2026. It is not a prediction.',
    },
  },
  {
    test: /vivint/i,
    record: {
      label: 'Vivint Solar',
      standing: 'acquired',
      chip: 'Acquired, not a bankruptcy',
      asOf: PARTY_STATUS_AS_OF,
      record: 'Vivint Solar was acquired by Sunrun. This registry has no bankruptcy filing under the Vivint Solar name. An older contract can still print Vivint.',
    },
  },
  {
    test: /\btesla\b/i,
    record: {
      label: 'Tesla',
      standing: 'operating',
      chip: 'No filing in registry',
      asOf: PARTY_STATUS_AS_OF,
      record: 'No bankruptcy of Tesla or Tesla Energy is in this registry as of September 26, 2026.',
    },
  },
  {
    test: /adt solar/i,
    record: {
      label: 'ADT Solar',
      standing: 'operating',
      chip: 'Exited, not a bankruptcy',
      asOf: PARTY_STATUS_AS_OF,
      record: 'ADT Solar exited residential solar in January 2024. This registry does not show a bankruptcy filing for that exit. The workmanship warranty is still the installer’s obligation, and the finance contract is a separate party.',
    },
  },
]

export function partyStatus(name: string | null | undefined): PartyRecord | null {
  const text = (name ?? '').trim()
  if (!text || text.toUpperCase() === 'MISSING' || text.toLowerCase() === 'not on file') return null
  return ENTRIES.find(entry => entry.test.test(text))?.record ?? null
}

export function partyStatusLine(name: string | null | undefined): string {
  const found = partyStatus(name)
  if (!found) return 'Not confirmed. Do not invent a bankruptcy or a successor.'
  return found.record
}
