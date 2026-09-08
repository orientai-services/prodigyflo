import { describe, expect, it } from 'vitest'
import {
  BOM,
  COACHING_HEADERS,
  MARKETING_CAMPAIGN_HEADERS,
  MARKETING_SOURCE_HEADERS,
  SCOREBOARD_HEADERS,
  coachingCsvRows,
  csvCell,
  csvResponse,
  exportFilename,
  marketingCampaignCsvRows,
  marketingSourceCsvRows,
  scoreboardCsvRows,
  toCsv,
} from '@/lib/export-csv'
import type { ScoreboardRow } from '@/lib/scoreboard'
import type { CampaignRollup, SourceRollup } from '@/lib/marketing-metrics'
import type { CoachingNoteRow } from '@/lib/coaching'

describe('csvCell', () => {
  it('passes plain strings and raw numbers through unquoted', () => {
    expect(csvCell('Alice')).toBe('Alice')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(33.333333)).toBe('33.333333')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(true)).toBe('true')
  })

  it('renders null/undefined as empty cells', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('renders dates as ISO 8601', () => {
    expect(csvCell(new Date('2026-08-25T12:34:56.000Z'))).toBe('2026-08-25T12:34:56.000Z')
  })

  it('quotes commas, quotes, and newlines per RFC 4180', () => {
    expect(csvCell('Acme, Inc.')).toBe('"Acme, Inc."')
    expect(csvCell('the "big" one')).toBe('"the ""big"" one"')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('cr\rlf')).toBe('"cr\rlf"')
  })

  it('neutralizes formula-injection prefixes with a quoted apostrophe', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`)
    expect(csvCell('+1234567890')).toBe(`"'+1234567890"`)
    expect(csvCell('-2+3')).toBe(`"'-2+3"`)
    expect(csvCell('@SUM(A1:A9)')).toBe(`"'@SUM(A1:A9)"`)
    expect(csvCell('\t=cmd')).toBe(`"'\t=cmd"`)
    expect(csvCell('\r=cmd')).toBe(`"'\r=cmd"`)
  })

  it('doubles quotes inside a neutralized formula cell', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`)
  })

  it('leaves negative numbers and dangerous chars mid-string alone', () => {
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(-0.5)).toBe('-0.5')
    expect(csvCell('a=b')).toBe('a=b')
    expect(csvCell('x @ y')).toBe('x @ y')
  })
})

describe('toCsv', () => {
  it('starts with a UTF-8 BOM and joins rows with CRLF', () => {
    const out = toCsv(['a', 'b'], [['x', 1], ['y, z', null]])
    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out).toBe(`${BOM}a,b\r\nx,1\r\n"y, z",\r\n`)
  })
})

describe('exportFilename', () => {
  it('stamps the request date, not build time', () => {
    expect(exportFilename('scoreboard', new Date('2026-08-25T23:59:00Z'))).toBe(
      'prodigyflo-scoreboard-2026-08-25.csv',
    )
    expect(exportFilename('coaching', new Date('2027-01-02T00:00:00Z'))).toBe(
      'prodigyflo-coaching-2027-01-02.csv',
    )
  })
})

describe('csvResponse', () => {
  it('returns a no-store CSV attachment', async () => {
    const res = csvResponse('prodigyflo-x-2026-08-25.csv', ['h'], [['v']])
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="prodigyflo-x-2026-08-25.csv"',
    )
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    // text() strips a leading BOM during decode — assert on the raw bytes.
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('h\r\nv\r\n')
  })
})

const scoreboardRow: ScoreboardRow = {
  id: 'u1',
  name: 'Reyes, Ana',
  teamName: 'Team West',
  capacity: 40,
  pipeline: 12,
  leaking: 1,
  qualifiedWon: 5,
  qualifiedLost: 4,
  closeRatePct: 55.6,
  wins: 5,
  hotWins: 3,
  revenueWon: 61250,
  avgAiProbOnWonPct: 84.2,
  aiAlignmentPct: 78.5,
  aiReadSample: 9,
  calls: 30,
  briefedCalls: 24,
  briefAdoptionPct: 80,
  adherencePct: 91.5,
  adherenceCalls: 20,
  fullFunnelCalls: 11,
  qaAvg: 8.3,
  qaCount: 6,
  coachingSessions: 2,
  points: 97,
  pointsLines: [],
  rank: 1,
}

describe('scoreboardCsvRows', () => {
  it('shapes one row per closer, aligned with SCOREBOARD_HEADERS', () => {
    const rows = scoreboardCsvRows([scoreboardRow])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveLength(SCOREBOARD_HEADERS.length)
    const byHeader = Object.fromEntries(SCOREBOARD_HEADERS.map((h, i) => [h, rows[0][i]]))
    expect(byHeader.rank).toBe(1)
    expect(byHeader.closer).toBe('Reyes, Ana')
    expect(byHeader.team).toBe('Team West')
    expect(byHeader.close_rate_pct).toBe(55.6)
    expect(byHeader.revenue_won).toBe(61250)
    expect(byHeader.coaching_sessions).toBe(2)
  })

  it('leaves null rates as empty cells in the rendered CSV', () => {
    const row = { ...scoreboardRow, closeRatePct: null, qaAvg: null, teamName: null }
    const csv = toCsv(SCOREBOARD_HEADERS, scoreboardCsvRows([row]))
    const line = csv.split('\r\n')[1]
    // The comma inside the name is quoted, so columns cannot shift.
    expect(line.startsWith('1,"Reyes, Ana",,97')).toBe(true)
  })
})

describe('marketingSourceCsvRows', () => {
  it('rounds rates to one decimal and keeps null rates empty', () => {
    const source: SourceRollup = {
      id: 's1', name: 'Referrals', channel: 'REFERRAL', isActive: true,
      leads: 3, qualified: 1, won: 0, qualifiedRate: 33.333333, wonRate: 0,
    }
    const silent: SourceRollup = {
      id: 's2', name: 'Billboard', channel: 'OFFLINE', isActive: false,
      leads: 0, qualified: 0, won: 0, qualifiedRate: null, wonRate: null,
    }
    const rows = marketingSourceCsvRows([source, silent])
    expect(rows[0]).toEqual(['Referrals', 'REFERRAL', true, 3, 1, 33.3, 0, 0])
    expect(rows[1]).toEqual(['Billboard', 'OFFLINE', false, 0, 0, null, 0, null])
    expect(rows[0]).toHaveLength(MARKETING_SOURCE_HEADERS.length)
  })
})

describe('marketingCampaignCsvRows', () => {
  it('shapes funnel + spend columns, rounding money to cents', () => {
    const campaign: CampaignRollup = {
      id: 'c1', name: 'Q3 "Solar" Push', channel: 'PAID_SOCIAL', sourceName: 'Meta Ads',
      status: 'ACTIVE', leads: 10, qualified: 4, won: 1,
      qualifiedRate: 40, wonRate: 10, spend: 1234.5678, impressions: 50000,
      clicks: 750, adLeads: 12, ctr: 1.5, costPerLead: 123.45678, costPerQualified: null,
    }
    const rows = marketingCampaignCsvRows([campaign])
    expect(rows[0]).toEqual([
      'Q3 "Solar" Push', 'Meta Ads', 'PAID_SOCIAL', 'ACTIVE', 10, 4,
      40, 1, 10, 1234.57, 50000, 750, 1.5, 12, 123.46, null,
    ])
    expect(rows[0]).toHaveLength(MARKETING_CAMPAIGN_HEADERS.length)
  })
})

describe('coachingCsvRows', () => {
  it('flattens subject/author/client names and keeps multiline bodies intact', () => {
    const note: CoachingNoteRow = {
      id: 'n1', kind: 'CALL_QA', score: 8,
      strengths: 'Great discovery', improvements: 'Slow the close',
      body: 'Line one\nLine two', createdAt: new Date('2026-08-20T10:00:00.000Z'),
      subject: { id: 'u1', name: 'Ana Reyes' },
      author: { id: 'u2', name: 'Sam Lead' },
      client: { id: 'cl1', firstName: 'Pat', lastName: 'Doe' },
    }
    const bare: CoachingNoteRow = {
      ...note, id: 'n2', kind: 'ONE_ON_ONE', score: null,
      strengths: null, improvements: null, client: null, body: 'Weekly 1-on-1',
    }
    const rows = coachingCsvRows([note, bare])
    expect(rows[0]).toEqual([
      note.createdAt, 'CALL_QA', 'Ana Reyes', 'Sam Lead', 8, 'Pat Doe',
      'Great discovery', 'Slow the close', 'Line one\nLine two',
    ])
    expect(rows[1]).toEqual([
      note.createdAt, 'ONE_ON_ONE', 'Ana Reyes', 'Sam Lead', null, null, null, null, 'Weekly 1-on-1',
    ])
    expect(rows[0]).toHaveLength(COACHING_HEADERS.length)
    // Multiline body survives round-trip quoting.
    const csv = toCsv(COACHING_HEADERS, rows)
    expect(csv).toContain('"Line one\nLine two"')
  })
})
