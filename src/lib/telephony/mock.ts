import type { PhoneNumberKind } from '@prisma/client'
import type {
  AvailableNumber,
  PurchaseInput,
  PurchaseResult,
  ReleaseResult,
  SearchNumbersInput,
  TelephonyProvider,
} from './provider'
import { formatE164 } from './provider'

/**
 * The deterministic mock carrier — the default adapter, exactly like
 * MockSmsProvider. It lets the whole flow (search → quote → wallet debit →
 * routing → console) be built, tested and demoed before a Twilio account
 * exists, and every screen that shows a mock number labels it as one.
 *
 * Every number it mints lives in the 555-01xx block, which the North American
 * numbering plan reserves for fiction. A mock line can therefore never collide
 * with, or accidentally dial, a real subscriber.
 */

const TOLL_FREE_PREFIXES = ['800', '833', '844', '855', '866', '877', '888']

const REGION_BY_AREA: Record<string, { region: string; locality: string }> = {
  '702': { region: 'NV', locality: 'Las Vegas' },
  '725': { region: 'NV', locality: 'Las Vegas' },
  '775': { region: 'NV', locality: 'Reno' },
  '213': { region: 'CA', locality: 'Los Angeles' },
  '310': { region: 'CA', locality: 'Santa Monica' },
  '619': { region: 'CA', locality: 'San Diego' },
  '760': { region: 'CA', locality: 'Palm Springs' },
  '512': { region: 'TX', locality: 'Austin' },
  '210': { region: 'TX', locality: 'San Antonio' },
  '305': { region: 'FL', locality: 'Miami' },
  '813': { region: 'FL', locality: 'Tampa' },
  '407': { region: 'FL', locality: 'Orlando' },
  '480': { region: 'AZ', locality: 'Phoenix' },
  '801': { region: 'UT', locality: 'Salt Lake City' },
}

function describe(areaCode: string): { region: string | null; locality: string | null } {
  const hit = REGION_BY_AREA[areaCode]
  return hit ? { region: hit.region, locality: hit.locality } : { region: null, locality: null }
}

/** Stable per-(prefix, index) line number inside the fictional 555-01xx block. */
function fictionalLine(index: number): string {
  return `555${String(100 + (index % 100)).padStart(4, '0')}`
}

export function mockSearch(input: SearchNumbersInput): AvailableNumber[] {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20)
  const tollFree = input.kind === 'TOLL_FREE'
  const prefixes = tollFree
    ? TOLL_FREE_PREFIXES
    : [(input.areaCode ?? '').replace(/\D/g, '').slice(0, 3) || '702']

  // The generator cycles through a finite set of fictional lines, so the
  // candidate space is bounded — and so is the loop. The guard comes FIRST:
  // an unsatisfiable `contains` filter takes the `continue` below on every
  // pass, and a guard placed after it would never be reached.
  const MAX_CANDIDATES = prefixes.length * 100

  const out: AvailableNumber[] = []
  for (let i = 0; out.length < limit && i < MAX_CANDIDATES; i += 1) {
    const prefix = prefixes[i % prefixes.length]
    if (prefix.length !== 3) break
    const e164 = `+1${prefix}${fictionalLine(Math.floor(i / prefixes.length))}`
    if (input.contains) {
      const needle = input.contains.replace(/\D/g, '')
      if (needle && !e164.includes(needle)) continue
    }
    const place = tollFree ? { region: null, locality: null } : describe(prefix)
    out.push({
      e164,
      friendly: formatE164(e164),
      kind: input.kind,
      areaCode: prefix,
      region: input.region ?? place.region,
      locality: place.locality,
      capabilities: { sms: true, mms: !tollFree, voice: true },
    })
  }
  return out
}

export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock'
  readonly isMock = true

  async searchNumbers(input: SearchNumbersInput): Promise<AvailableNumber[]> {
    return mockSearch(input)
  }

  async purchase(input: PurchaseInput): Promise<PurchaseResult> {
    const areaCode = /^\+1(\d{3})/.exec(input.e164)?.[1] ?? null
    const kind: PhoneNumberKind =
      areaCode && TOLL_FREE_PREFIXES.includes(areaCode) ? 'TOLL_FREE' : 'LOCAL'
    const place = areaCode ? describe(areaCode) : { region: null, locality: null }
    return {
      ok: true,
      number: {
        e164: input.e164,
        // Shaped like a Twilio PN SID so nothing downstream has to special-case it.
        providerSid: `PNMOCK${input.e164.replace(/\D/g, '')}`,
        capabilities: { sms: true, mms: kind === 'LOCAL', voice: true },
        areaCode,
        region: place.region,
        locality: place.locality,
      },
    }
  }

  async release(): Promise<ReleaseResult> {
    return { ok: true }
  }
}
