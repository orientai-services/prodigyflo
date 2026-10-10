/**
 * Voice quality for browser calls (docs/DIALER_POWER.md, Lane B).
 *
 * Pure logic only: no browser, no SDK, no database. The voice provider and
 * the "Test connection" panel feed it numbers; it decides which Twilio edge
 * to use, whether low-data mode helps, what the call-bar light shows, and
 * what to tell the rep in plain words. Keeping it pure is what lets the
 * thresholds be tested without a microphone or a network.
 *
 * It also holds the answer the TwiML App gives a preflight test call (see
 * `isPreflightRequest`), so the server side of "Test connection" is tested
 * here too.
 */

// ── Edges ─────────────────────────────────────────────────────────────────────

/** Twilio's public edge locations (Voice JS SDK 2.x names). */
export const EDGES = [
  'ashburn',
  'dublin',
  'frankfurt',
  'roaming',
  'sao-paulo',
  'singapore',
  'sydney',
  'tokyo',
  'umatilla',
] as const
export type Edge = (typeof EDGES)[number]

export function isEdge(value: unknown): value is Edge {
  return typeof value === 'string' && (EDGES as readonly string[]).includes(value)
}

export const EDGE_LABELS: Record<Edge, string> = {
  ashburn: 'US East (Ashburn)',
  dublin: 'Europe (Dublin)',
  frankfurt: 'Europe (Frankfurt)',
  roaming: 'Nearest (automatic)',
  'sao-paulo': 'South America (São Paulo)',
  singapore: 'Asia (Singapore)',
  sydney: 'Australia (Sydney)',
  tokyo: 'Asia (Tokyo)',
  umatilla: 'US West (Umatilla)',
}

// Western North America: the zones whose media is shorter to Oregon than to
// Virginia. Everything else under America/ that isn't South American goes
// east first.
const AMERICAS_WEST = new Set([
  'America/Los_Angeles', 'America/Vancouver', 'America/Tijuana', 'America/Ensenada', 'America/Santa_Isabel',
  'America/Phoenix', 'America/Denver', 'America/Boise', 'America/Edmonton', 'America/Yellowknife',
  'America/Whitehorse', 'America/Dawson', 'America/Dawson_Creek', 'America/Fort_Nelson', 'America/Creston',
  'America/Inuvik', 'America/Cambridge_Bay', 'America/Anchorage', 'America/Juneau', 'America/Sitka',
  'America/Nome', 'America/Yakutat', 'America/Metlakatla', 'America/Adak', 'America/Hermosillo',
  'America/Mazatlan', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Shiprock',
  'US/Pacific', 'US/Mountain', 'US/Arizona', 'US/Alaska', 'US/Hawaii', 'US/Aleutian',
  'Canada/Pacific', 'Canada/Mountain', 'Canada/Yukon', 'Pacific/Honolulu', 'PST8PDT', 'MST7MDT', 'MST',
])

const SOUTH_AMERICA = new Set([
  'America/Sao_Paulo', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Caracas',
  'America/La_Paz', 'America/Montevideo', 'America/Asuncion', 'America/Guayaquil', 'America/Cayenne',
  'America/Paramaribo', 'America/Guyana', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Maceio', 'America/Bahia', 'America/Manaus', 'America/Cuiaba', 'America/Campo_Grande',
  'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Eirunepe', 'America/Santarem',
  'America/Araguaina', 'America/Noronha', 'America/Punta_Arenas', 'America/Buenos_Aires', 'America/Cordoba',
  'America/Mendoza', 'America/Jujuy', 'America/Catamarca', 'America/Rosario',
])

// Gulf and Levant zones sit between Europe and Asia; roaming finds the
// nearer one better than a fixed guess would.
const MIDDLE_EAST = new Set([
  'Asia/Dubai', 'Asia/Muscat', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Riyadh', 'Asia/Aden',
  'Asia/Baghdad', 'Asia/Tehran', 'Asia/Jerusalem', 'Asia/Tel_Aviv', 'Asia/Beirut', 'Asia/Amman',
  'Asia/Damascus', 'Asia/Gaza', 'Asia/Hebron', 'Asia/Nicosia', 'Asia/Famagusta', 'Asia/Baku',
  'Asia/Tbilisi', 'Asia/Yerevan',
])

const EAST_ASIA = new Set([
  'Asia/Tokyo', 'Asia/Seoul', 'Asia/Pyongyang', 'Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin',
  'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei', 'Asia/Vladivostok', 'Asia/Sakhalin', 'Japan', 'ROK', 'PRC',
])

/**
 * The edges to try, nearest first, from the browser's IANA time zone. The
 * zone is a cheap location hint that needs no permission; a full test
 * replaces the guess with a measurement (see `edgePlan`).
 */
export function edgesForTimeZone(tz: string | null | undefined): Edge[] {
  const zone = (tz ?? '').trim()
  if (!zone) return ['roaming']
  if (AMERICAS_WEST.has(zone)) return ['umatilla', 'ashburn']
  if (SOUTH_AMERICA.has(zone) || zone.startsWith('America/Argentina/') || zone.startsWith('Brazil/') || zone.startsWith('Chile/')) {
    return ['sao-paulo', 'ashburn']
  }
  if (zone.startsWith('America/') || zone.startsWith('US/') || zone.startsWith('Canada/') || zone === 'EST5EDT' || zone === 'CST6CDT' || zone === 'EST') {
    return ['ashburn', 'umatilla']
  }
  if (zone.startsWith('Europe/') || zone.startsWith('Atlantic/') || zone === 'GB' || zone === 'Eire') {
    return ['dublin', 'frankfurt']
  }
  if (MIDDLE_EAST.has(zone)) return ['roaming']
  if (EAST_ASIA.has(zone)) return ['tokyo', 'singapore']
  if (zone.startsWith('Asia/') || zone.startsWith('Indian/')) return ['singapore', 'tokyo']
  if (zone.startsWith('Australia/') || zone === 'Pacific/Auckland' || zone === 'Pacific/Chatham' || zone === 'NZ' || zone === 'Pacific/Fiji') {
    return ['sydney']
  }
  return ['roaming']
}

/**
 * The ordered `edge` list handed to `Device`: the best edge from the last
 * full test first (a measurement beats a guess), then the time-zone guess.
 * The SDK falls through the list when an edge can't be reached.
 */
export function edgePlan(tz: string | null | undefined, measured?: string | null): Edge[] {
  const guess = edgesForTimeZone(tz)
  if (!isEdge(measured)) return guess
  return [measured, ...guess.filter((e) => e !== measured)]
}

// Neighbours worth measuring after the guess, by the guess's first edge.
const TEST_NEIGHBOURS: Record<Edge, Edge[]> = {
  umatilla: ['ashburn', 'sao-paulo'],
  ashburn: ['umatilla', 'sao-paulo'],
  'sao-paulo': ['ashburn', 'umatilla'],
  dublin: ['frankfurt', 'ashburn'],
  frankfurt: ['dublin', 'ashburn'],
  singapore: ['tokyo', 'sydney'],
  tokyo: ['singapore', 'sydney'],
  sydney: ['singapore', 'tokyo'],
  roaming: ['ashburn', 'dublin'],
}

/** The up-to-3 edges a full test measures: the plan first, then its neighbours. */
export function testEdges(tz: string | null | undefined, measured?: string | null): Edge[] {
  const plan = edgePlan(tz, measured)
  const out: Edge[] = []
  for (const e of [...plan, ...TEST_NEIGHBOURS[plan[0]], ...TEST_NEIGHBOURS[edgesForTimeZone(tz)[0]]]) {
    if (!out.includes(e)) out.push(e)
    if (out.length === 3) break
  }
  return out
}

// ── Bitrate ───────────────────────────────────────────────────────────────────

/** Opus average bitrate caps: normal, and low-data for weak or metered links. */
export const BITRATE_NORMAL = 32_000
export const BITRATE_LOW_DATA = 16_000

export function maxBitrate(lowData: boolean): number {
  return lowData ? BITRATE_LOW_DATA : BITRATE_NORMAL
}

// ── Test connection ───────────────────────────────────────────────────────────

/** One edge's preflight, reduced to what the recommendation needs. */
export type EdgeResult = {
  edge: Edge
  ok: boolean
  /** Round trip in ms (average). */
  rttMs: number | null
  /** Jitter in ms (average). */
  jitterMs: number | null
  /** Packets lost, 0–100. */
  lossPct: number | null
  /** Mean opinion score, 1–4.5 (average). */
  mos: number | null
  /** Media needed a TURN relay; null when unknown. */
  turn: boolean | null
  /** The SDK warned about too few bytes flowing, or none arrived at all. */
  bandwidthBad: boolean
  /** Plain-words reason when the test didn't complete. */
  error?: string | null
}

/** The slice of the SDK's `PreflightTest.Report` this module reads. */
export type PreflightReportLike = {
  edge?: string
  isTurnRequired?: boolean
  stats?: {
    rtt: { average: number }
    jitter: { average: number }
    mos: { average: number }
  }
  samples?: Array<{ packetsLost?: number; packetsReceived?: number }>
  warnings?: Array<{ name: string }>
}

export function edgeResultFromReport(edge: Edge, report: PreflightReportLike): EdgeResult {
  let lost = 0
  let received = 0
  for (const s of report.samples ?? []) {
    lost += Math.max(0, s.packetsLost ?? 0)
    received += Math.max(0, s.packetsReceived ?? 0)
  }
  const flowing = lost + received > 0
  const bytesWarning = (report.warnings ?? []).some((w) => /bytes/.test(w.name))
  const stats = report.stats
  return {
    edge,
    ok: Boolean(stats),
    rttMs: stats ? round(stats.rtt.average) : null,
    jitterMs: stats ? round(stats.jitter.average) : null,
    lossPct: flowing ? round((lost / (lost + received)) * 100, 2) : null,
    mos: stats ? round(stats.mos.average, 2) : null,
    turn: typeof report.isTurnRequired === 'boolean' ? report.isTurnRequired : null,
    bandwidthBad: bytesWarning || !flowing,
    error: stats ? null : 'The test call connected but sent no audio back.',
  }
}

/** One analyser frame of the microphone: RMS and peak, both 0–1 linear. */
export type MicFrame = { rms: number; peak: number }

export type MicReading = {
  /** Average level in dBFS across the frames (silence floors at −100). */
  averageDbfs: number
  /** Share of frames that hit full scale, 0–1. */
  clippedFraction: number
  frames: number
}

export const MIC_FLOOR_DBFS = -100
export const CLIP_PEAK = 0.99

export function dbfs(rms: number): number {
  if (!(rms > 0)) return MIC_FLOOR_DBFS
  return Math.max(MIC_FLOOR_DBFS, 20 * Math.log10(rms))
}

export function summarizeMicFrames(frames: MicFrame[]): MicReading {
  if (frames.length === 0) return { averageDbfs: MIC_FLOOR_DBFS, clippedFraction: 0, frames: 0 }
  let sum = 0
  let clipped = 0
  for (const f of frames) {
    sum += dbfs(f.rms)
    if (f.peak >= CLIP_PEAK) clipped += 1
  }
  return { averageDbfs: round(sum / frames.length, 1), clippedFraction: round(clipped / frames.length, 3), frames: frames.length }
}

export type Verdict = 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Failed'

export function verdictFor(mos: number | null): Verdict {
  if (mos === null || !Number.isFinite(mos)) return 'Failed'
  if (mos >= 4.1) return 'Excellent'
  if (mos >= 3.8) return 'Good'
  if (mos >= 3.1) return 'Fair'
  return 'Poor'
}

export type Recommendation = {
  verdict: Verdict
  /** The edge the numbers came from (the best, or the least bad). */
  measured: EdgeResult | null
  /** Lowest-RTT edge with loss ≤ 2 % and MOS ≥ 3.8, or null when none qualifies. */
  bestEdge: Edge | null
  lowData: boolean
  /** Media needed a TURN relay. Advice only: forcing relay needs TURN credentials from the server. */
  relay: boolean
  vpnSuspected: boolean
  micSilent: boolean
  micClipping: boolean
  /** Plain-English advice, most important first. */
  tips: string[]
}

export const THRESHOLDS = {
  bestMaxLossPct: 2,
  bestMinMos: 3.8,
  lowDataLossPct: 3,
  lowDataJitterMs: 30,
  vpnRttMs: 300,
  micSilentDbfs: -50,
  micClipFraction: 0.05,
} as const

/**
 * What to change after a test. Thresholds are the contract's (DIALER_POWER
 * Lane B §3); the copy is what a rep reads, so it names the fix, not the stat.
 */
export function recommend(input: { edges: EdgeResult[]; mic?: MicReading | null }): Recommendation {
  const measuredEdges = input.edges.filter((e) => e.ok && e.rttMs !== null && e.mos !== null)
  const qualifying = measuredEdges
    .filter((e) => (e.lossPct ?? 0) <= THRESHOLDS.bestMaxLossPct && (e.mos ?? 0) >= THRESHOLDS.bestMinMos)
    .sort((a, b) => (a.rttMs ?? Infinity) - (b.rttMs ?? Infinity))
  const best = qualifying[0] ?? null
  const measured = best ?? [...measuredEdges].sort((a, b) => (b.mos ?? 0) - (a.mos ?? 0))[0] ?? null

  const lowData = measured
    ? (measured.lossPct ?? 0) > THRESHOLDS.lowDataLossPct ||
      (measured.jitterMs ?? 0) > THRESHOLDS.lowDataJitterMs ||
      measured.bandwidthBad
    : false
  const relay = measured?.turn === true
  const vpnSuspected = measuredEdges.length > 0 && measuredEdges.every((e) => (e.rttMs ?? 0) > THRESHOLDS.vpnRttMs)
  const mic = input.mic ?? null
  const micSilent = mic ? mic.frames > 0 && mic.averageDbfs < THRESHOLDS.micSilentDbfs : false
  const micClipping = mic ? mic.clippedFraction > THRESHOLDS.micClipFraction : false
  const verdict = verdictFor(measured?.mos ?? null)

  const tips: string[] = []
  if (!measured) {
    tips.push("We couldn't reach the phone service. Check the internet, then try again. A company firewall can block calls.")
  }
  if (micSilent) tips.push("We couldn't hear your microphone. Check it isn't muted, or pick another one above.")
  if (micClipping) tips.push('Your microphone is too loud and will sound distorted. Move it a little away from your mouth.')
  if (vpnSuspected) tips.push('Every server is far away for this connection. If you use a VPN, turn it off for calls.')
  if (lowData) tips.push('Your connection is losing or delaying audio. Low-data mode will keep calls clearer.')
  if (relay) tips.push("Your network blocks direct calls, so audio takes a detour. If calls cut out, ask IT to allow Twilio's voice traffic.")
  if (measured && !best && verdict !== 'Failed') {
    tips.push('No server gave clean audio. Plug in a cable or move closer to the Wi-Fi.')
  }
  if (tips.length === 0) tips.push('Your connection is ready for calls.')

  return { verdict, measured, bestEdge: best?.edge ?? null, lowData, relay, vpnSuspected, micSilent, micClipping, tips }
}

// ── The live light in the call bar ────────────────────────────────────────────

export type LiveLevel = 'good' | 'warn' | 'bad'

// SDK `warning` names (Call 'warning' / 'warning-cleared').
export const RED_WARNINGS = ['ice-connectivity-lost', 'high-packet-loss', 'high-packets-lost-fraction', 'low-mos', 'constant-audio-input-level', 'constant-audio-output-level'] as const
export const AMBER_WARNINGS = ['high-rtt', 'high-jitter'] as const

// One tip per warning, most urgent first. The bar shows only the first.
const TIPS: Array<[string, string]> = [
  ['ice-connectivity-lost', 'The connection dropped. Reconnecting…'],
  ['high-packet-loss', 'Your internet is dropping audio. Move closer to the Wi-Fi or plug in a cable.'],
  ['high-packets-lost-fraction', 'Your internet is dropping audio. Move closer to the Wi-Fi or plug in a cable.'],
  ['constant-audio-input-level', "They may not hear you. Check your headset isn't muted."],
  ['constant-audio-output-level', "You may not hear them. Check the speaker or volume."],
  ['low-mos', 'Call quality is poor. Pause video or downloads on this network.'],
  ['low-bytes-received', 'Audio from them stopped arriving. Check the internet.'],
  ['low-bytes-sent', 'Your audio stopped going out. Check the internet.'],
  ['high-jitter', 'Audio may sound choppy. Pause video or downloads on this network.'],
  ['high-rtt', 'There is a delay on the line. A VPN can cause this.'],
]

/** The light, its one tip, from the warnings active right now. */
export function liveQuality(active: Iterable<string>): { level: LiveLevel; tip: string | null } {
  const names = new Set(active)
  // Amber covers RTT and jitter, and any warning this list doesn't know yet.
  const level: LiveLevel = RED_WARNINGS.some((n) => names.has(n)) ? 'bad' : names.size > 0 ? 'warn' : 'good'
  const tip = TIPS.find(([name]) => names.has(name))?.[1] ?? (names.size > 0 ? 'Call quality dropped.' : null)
  return { level, tip }
}

// ── Preflight on the server ───────────────────────────────────────────────────

/**
 * `Device.runPreflight` connects to the TwiML App with no custom params at
 * all. Every real browser call carries `target` and `line` (voice-provider),
 * so a request with neither, from an identity the webhook has already
 * verified, is a connection test. It gets `preflightTwiml()`, which never
 * dials anything.
 */
export function isPreflightRequest(params: Record<string, string | undefined>): boolean {
  return !params.target && !params.line && !params.override
}

/** Seconds a preflight call stays up: long enough for ~8 one-second samples. */
export const PREFLIGHT_SECONDS = 8

/** Silence, then hang up. No <Dial>, no <Say>: the rep hears nothing and nothing reaches the phone network. */
export function preflightTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="${PREFLIGHT_SECONDS}"/><Hangup/></Response>`
}

function round(n: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
