/**
 * Google Sheets adapter boundary. The real integration would live behind the
 * same interface; today only the deterministic mock ships, selected by
 * SHEETS_PROVIDER (default 'mock'). The UI labels mock mode explicitly.
 */

export type SheetRow = { rowNumber: number; values: Record<string, string> }

export interface SheetsProvider {
  readonly kind: 'mock' | 'google'
  /** Rows with rowNumber >= fromRow. Row 1 is the header and is never returned. */
  listRows(sheetId: string, tab: string, fromRow: number): Promise<SheetRow[]>
}

const MOCK_HEADERS = ['first_name', 'last_name', 'email', 'phone', 'utm_source', 'utm_campaign', 'notes'] as const

// Synthetic people only. Row numbers start at 2 (row 1 = header).
const MOCK_CELLS: string[][] = [
  ['Maria', 'Vasquez', 'maria.vasquez@example.test', '702-555-0141', 'google_sheet', 'spring-solar', 'Wants a call after 5pm'],
  ['Devon', 'Okafor', 'devon.okafor@example.test', '702-555-0172', 'google_sheet', 'spring-solar', ''],
  ['Priya', 'Natarajan', 'priya.n@example.test', '725-555-0113', 'google_sheet', 'referral-push', 'Referred by a neighbor'],
  ['Sam', 'Whitfield', '', '702-555-0186', 'google_sheet', 'spring-solar', 'No email on file'],
  ['Lucia', 'Ferreira', 'lucia.ferreira@example.test', '', 'google_sheet', 'es-radio', 'Spanish preferred'],
  ['Grant', 'Holloway', 'grant.holloway@example.test', '702-555-0119', 'google_sheet', 'referral-push', ''],
  ['Aisha', 'Rahman', 'aisha.rahman@example.test', '725-555-0164', 'google_sheet', 'spring-solar', 'Asked about financing'],
  ['Tobias', 'Lindqvist', 'tobias.l@example.test', '702-555-0158', 'google_sheet', 'es-radio', ''],
]

export class MockSheetsProvider implements SheetsProvider {
  readonly kind = 'mock' as const

  async listRows(_sheetId: string, _tab: string, fromRow: number): Promise<SheetRow[]> {
    return MOCK_CELLS.map((cells, i) => ({
      rowNumber: i + 2,
      values: Object.fromEntries(MOCK_HEADERS.map((h, col) => [h, cells[col] ?? ''])),
    })).filter((row) => row.rowNumber >= Math.max(fromRow, 2))
  }
}

export function sheetsProviderKind(): 'mock' | 'google' {
  return process.env.SHEETS_PROVIDER === 'google' ? 'google' : 'mock'
}

export function getSheetsProvider(): SheetsProvider {
  // Only the mock exists in the MVP; a 'google' setting still resolves to the
  // mock rather than pretending a real integration is configured.
  return new MockSheetsProvider()
}
