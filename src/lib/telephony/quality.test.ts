import { describe, expect, it } from 'vitest'
import {
  BITRATE_LOW_DATA,
  BITRATE_NORMAL,
  type EdgeResult,
  dbfs,
  edgePlan,
  edgeResultFromReport,
  edgesForTimeZone,
  isPreflightRequest,
  liveQuality,
  maxBitrate,
  preflightTwiml,
  recommend,
  summarizeMicFrames,
  testEdges,
  verdictFor,
} from './quality'

function edge(over: Partial<EdgeResult> & Pick<EdgeResult, 'edge'>): EdgeResult {
  return { ok: true, rttMs: 50, jitterMs: 5, lossPct: 0, mos: 4.3, turn: false, bandwidthBad: false, error: null, ...over }
}

describe('edgesForTimeZone', () => {
  it('sends the American west to Umatilla first, Ashburn next', () => {
    expect(edgesForTimeZone('America/Los_Angeles')).toEqual(['umatilla', 'ashburn'])
    expect(edgesForTimeZone('America/Phoenix')).toEqual(['umatilla', 'ashburn'])
    expect(edgesForTimeZone('Pacific/Honolulu')).toEqual(['umatilla', 'ashburn'])
  })
  it('sends the east and central Americas to Ashburn', () => {
    expect(edgesForTimeZone('America/New_York')[0]).toBe('ashburn')
    expect(edgesForTimeZone('America/Chicago')[0]).toBe('ashburn')
    expect(edgesForTimeZone('America/Mexico_City')[0]).toBe('ashburn')
  })
  it('sends South America to São Paulo', () => {
    expect(edgesForTimeZone('America/Bogota')[0]).toBe('sao-paulo')
    expect(edgesForTimeZone('America/Sao_Paulo')[0]).toBe('sao-paulo')
    expect(edgesForTimeZone('America/Argentina/Buenos_Aires')[0]).toBe('sao-paulo')
  })
  it('maps Europe, Asia and Oceania', () => {
    expect(edgesForTimeZone('Europe/Madrid')[0]).toBe('dublin')
    expect(edgesForTimeZone('Asia/Tokyo')[0]).toBe('tokyo')
    expect(edgesForTimeZone('Asia/Manila')[0]).toBe('singapore')
    expect(edgesForTimeZone('Australia/Sydney')).toEqual(['sydney'])
  })
  it('falls back to roaming for anything else', () => {
    expect(edgesForTimeZone('Africa/Lagos')).toEqual(['roaming'])
    expect(edgesForTimeZone('Asia/Dubai')).toEqual(['roaming'])
    expect(edgesForTimeZone('')).toEqual(['roaming'])
    expect(edgesForTimeZone(undefined)).toEqual(['roaming'])
  })
})

describe('edgePlan', () => {
  it('puts the measured edge first and keeps the guess as fallback', () => {
    expect(edgePlan('America/Los_Angeles', 'ashburn')).toEqual(['ashburn', 'umatilla'])
    expect(edgePlan('America/Bogota', 'umatilla')).toEqual(['umatilla', 'sao-paulo', 'ashburn'])
  })
  it('ignores a stored value that is not an edge', () => {
    expect(edgePlan('America/Los_Angeles', 'mars')).toEqual(['umatilla', 'ashburn'])
    expect(edgePlan('America/Los_Angeles', null)).toEqual(['umatilla', 'ashburn'])
  })
})

describe('testEdges', () => {
  it('measures the plan first, then neighbours, three at most', () => {
    expect(testEdges('America/Los_Angeles')).toEqual(['umatilla', 'ashburn', 'sao-paulo'])
    expect(testEdges('Europe/Paris')).toEqual(['dublin', 'frankfurt', 'ashburn'])
    expect(testEdges('Africa/Lagos')).toEqual(['roaming', 'ashburn', 'dublin'])
    expect(testEdges('America/Los_Angeles', 'sao-paulo')).toEqual(['sao-paulo', 'umatilla', 'ashburn'])
  })
})

describe('maxBitrate', () => {
  it('caps at 16 kbps in low-data mode and 32 kbps otherwise', () => {
    expect(maxBitrate(true)).toBe(BITRATE_LOW_DATA)
    expect(maxBitrate(false)).toBe(BITRATE_NORMAL)
    expect(BITRATE_LOW_DATA).toBe(16000)
    expect(BITRATE_NORMAL).toBe(32000)
  })
})

describe('verdictFor', () => {
  it('uses the contract bands', () => {
    expect(verdictFor(4.1)).toBe('Excellent')
    expect(verdictFor(4.09)).toBe('Good')
    expect(verdictFor(3.8)).toBe('Good')
    expect(verdictFor(3.79)).toBe('Fair')
    expect(verdictFor(3.1)).toBe('Fair')
    expect(verdictFor(3.09)).toBe('Poor')
    expect(verdictFor(null)).toBe('Failed')
  })
})

describe('recommend', () => {
  it('picks the lowest RTT among edges with loss ≤ 2 % and MOS ≥ 3.8', () => {
    const r = recommend({
      edges: [
        edge({ edge: 'umatilla', rttMs: 30, lossPct: 2.5, mos: 4.3 }), // too lossy
        edge({ edge: 'ashburn', rttMs: 80, lossPct: 1, mos: 4.2 }),
        edge({ edge: 'sao-paulo', rttMs: 60, lossPct: 0, mos: 3.7 }), // MOS too low
      ],
    })
    expect(r.bestEdge).toBe('ashburn')
    expect(r.verdict).toBe('Excellent')
    expect(r.lowData).toBe(false)
  })
  it('returns no best edge when none qualifies, and judges by the least bad one', () => {
    const r = recommend({ edges: [edge({ edge: 'ashburn', lossPct: 5, mos: 3.3 }), edge({ edge: 'umatilla', lossPct: 6, mos: 3.0 })] })
    expect(r.bestEdge).toBeNull()
    expect(r.measured?.edge).toBe('ashburn')
    expect(r.verdict).toBe('Fair')
    expect(r.lowData).toBe(true)
  })
  it('recommends low-data for loss over 3 %, jitter over 30 ms, or bad bandwidth', () => {
    expect(recommend({ edges: [edge({ edge: 'ashburn', lossPct: 3.1, mos: 3.5 })] }).lowData).toBe(true)
    expect(recommend({ edges: [edge({ edge: 'ashburn', lossPct: 3, mos: 3.5 })] }).lowData).toBe(false)
    expect(recommend({ edges: [edge({ edge: 'ashburn', jitterMs: 31 })] }).lowData).toBe(true)
    expect(recommend({ edges: [edge({ edge: 'ashburn', jitterMs: 30 })] }).lowData).toBe(false)
    expect(recommend({ edges: [edge({ edge: 'ashburn', bandwidthBad: true })] }).lowData).toBe(true)
  })
  it('flags relay when TURN was needed', () => {
    expect(recommend({ edges: [edge({ edge: 'ashburn', turn: true })] }).relay).toBe(true)
    expect(recommend({ edges: [edge({ edge: 'ashburn', turn: null })] }).relay).toBe(false)
  })
  it('suspects a VPN only when every edge is over 300 ms', () => {
    expect(recommend({ edges: [edge({ edge: 'ashburn', rttMs: 320 }), edge({ edge: 'umatilla', rttMs: 400 })] }).vpnSuspected).toBe(true)
    expect(recommend({ edges: [edge({ edge: 'ashburn', rttMs: 320 }), edge({ edge: 'umatilla', rttMs: 290 })] }).vpnSuspected).toBe(false)
  })
  it('flags a silent mic below −50 dBFS and clipping over 5 % of frames', () => {
    const base = [edge({ edge: 'ashburn' })]
    expect(recommend({ edges: base, mic: { averageDbfs: -51, clippedFraction: 0, frames: 100 } }).micSilent).toBe(true)
    expect(recommend({ edges: base, mic: { averageDbfs: -49, clippedFraction: 0, frames: 100 } }).micSilent).toBe(false)
    expect(recommend({ edges: base, mic: { averageDbfs: -20, clippedFraction: 0.06, frames: 100 } }).micClipping).toBe(true)
    expect(recommend({ edges: base, mic: { averageDbfs: -20, clippedFraction: 0.05, frames: 100 } }).micClipping).toBe(false)
  })
  it('fails plainly when no edge connected', () => {
    const r = recommend({ edges: [{ ...edge({ edge: 'ashburn' }), ok: false, rttMs: null, mos: null, error: 'x' }] })
    expect(r.verdict).toBe('Failed')
    expect(r.bestEdge).toBeNull()
    expect(r.tips[0]).toMatch(/couldn't reach/i)
  })
  it('says ready when nothing is wrong', () => {
    expect(recommend({ edges: [edge({ edge: 'ashburn' })], mic: { averageDbfs: -30, clippedFraction: 0, frames: 50 } }).tips).toEqual([
      'Your connection is ready for calls.',
    ])
  })
})

describe('edgeResultFromReport', () => {
  it('reads averages, loss from samples, and TURN', () => {
    const r = edgeResultFromReport('ashburn', {
      isTurnRequired: true,
      stats: { rtt: { average: 41.6 }, jitter: { average: 3.2 }, mos: { average: 4.312 } },
      samples: [
        { packetsLost: 0, packetsReceived: 50 },
        { packetsLost: 2, packetsReceived: 48 },
      ],
      warnings: [],
    })
    expect(r).toMatchObject({ edge: 'ashburn', ok: true, rttMs: 42, jitterMs: 3, mos: 4.31, lossPct: 2, turn: true, bandwidthBad: false })
  })
  it('marks bandwidth bad when no packets arrived or the SDK warned about bytes', () => {
    expect(edgeResultFromReport('ashburn', { samples: [] }).bandwidthBad).toBe(true)
    expect(edgeResultFromReport('ashburn', { samples: [] }).ok).toBe(false)
    const warned = edgeResultFromReport('ashburn', {
      stats: { rtt: { average: 40 }, jitter: { average: 1 }, mos: { average: 4.3 } },
      samples: [{ packetsLost: 0, packetsReceived: 50 }],
      warnings: [{ name: 'low-bytes-received' }],
    })
    expect(warned.bandwidthBad).toBe(true)
  })
})

describe('mic level', () => {
  it('converts RMS to dBFS with a −100 floor', () => {
    expect(dbfs(1)).toBe(0)
    expect(Math.round(dbfs(0.1))).toBe(-20)
    expect(dbfs(0)).toBe(-100)
  })
  it('averages frames and counts clipped ones', () => {
    const r = summarizeMicFrames([
      { rms: 0.1, peak: 0.5 },
      { rms: 0.01, peak: 1 },
    ])
    expect(r.averageDbfs).toBe(-30)
    expect(r.clippedFraction).toBe(0.5)
    expect(summarizeMicFrames([]).averageDbfs).toBe(-100)
  })
})

describe('liveQuality', () => {
  it('is green with no warnings', () => {
    expect(liveQuality([])).toEqual({ level: 'good', tip: null })
  })
  it('is red for packet loss, low MOS, constant audio and ICE lost', () => {
    for (const name of ['high-packet-loss', 'low-mos', 'constant-audio-input-level', 'ice-connectivity-lost']) {
      expect(liveQuality([name]).level).toBe('bad')
    }
  })
  it('is amber for RTT and jitter, with one tip', () => {
    expect(liveQuality(['high-rtt'])).toMatchObject({ level: 'warn' })
    expect(liveQuality(['high-jitter']).tip).toMatch(/choppy/)
  })
  it('shows the most urgent tip when several are active', () => {
    expect(liveQuality(['high-rtt', 'high-packet-loss']).tip).toMatch(/dropping audio/)
  })
})

describe('preflight on the server', () => {
  it('treats a connect with no target, line or override as a test', () => {
    expect(isPreflightRequest({ CallSid: 'CA1', From: 'client:pf_a_b' })).toBe(true)
    expect(isPreflightRequest({ target: 'lead:x', line: 'l1' })).toBe(false)
    expect(isPreflightRequest({ line: 'l1' })).toBe(false)
    expect(isPreflightRequest({ target: 'lead:x' })).toBe(false)
    expect(isPreflightRequest({ override: 'tok' })).toBe(false)
  })
  it('answers with silence and a hang-up, never a dial', () => {
    const xml = preflightTwiml()
    expect(xml).toContain('<Pause length="8"/>')
    expect(xml).toContain('<Hangup/>')
    expect(xml).not.toMatch(/<Dial|<Number|<Client|<Say/)
  })
})
