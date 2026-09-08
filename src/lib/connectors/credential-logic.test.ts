import { describe, expect, it } from 'vitest'
import { connectorDef, CONNECTORS, isInbound, type ConnectorDef } from '@/lib/connectors/catalog'
import {
  applyStatusTransition,
  buildCredentialFieldVMs,
  credentialCompletion,
  displayState,
  maskedCredential,
  nextConnectorStatus,
  outboundModeOf,
  outboundStateOf,
} from '@/lib/connectors/credential-logic'

/** A minimal outbound def factory for the pure status math. */
function defWith(over: Partial<ConnectorDef>): ConnectorDef {
  return {
    id: 'test-def',
    name: 'Test',
    tagline: '',
    category: 'Communications',
    direction: 'outbound',
    auth: 'api-key',
    availability: 'available',
    backing: { model: 'connector', kind: 'EMAIL' },
    glyph: 'x',
    accent: '#000',
    setup: [],
    credentialFields: [
      { key: 'apiKey', label: 'API key', secret: true },
      { key: 'fromAddress', label: 'From', secret: false },
    ],
    ...over,
  }
}

describe('maskedCredential', () => {
  it('renders last4 behind a bullet prefix', () => {
    expect(maskedCredential('7f2a')).toBe('••••-7f2a')
  })

  it('falls back to full bullets when last4 is missing', () => {
    expect(maskedCredential(null)).toBe('••••••••')
    expect(maskedCredential(undefined)).toBe('••••••••')
    expect(maskedCredential('')).toBe('••••••••')
  })
})

describe('credentialCompletion', () => {
  it('reports missing fields', () => {
    const out = credentialCompletion(defWith({}), ['apiKey'])
    expect(out.required).toEqual(['apiKey', 'fromAddress'])
    expect(out.missing).toEqual(['fromAddress'])
    expect(out.complete).toBe(false)
  })

  it('is complete only when every declared field is stored', () => {
    expect(credentialCompletion(defWith({}), ['apiKey', 'fromAddress']).complete).toBe(true)
  })

  it('ignores stored keys the def does not declare', () => {
    const out = credentialCompletion(defWith({}), ['apiKey', 'fromAddress', 'legacyToken'])
    expect(out.complete).toBe(true)
    expect(out.required).toHaveLength(2)
  })

  it('is never complete for a def without credential fields', () => {
    expect(credentialCompletion(defWith({ credentialFields: undefined }), ['anything']).complete).toBe(false)
    expect(credentialCompletion(defWith({ credentialFields: [] }), []).complete).toBe(false)
  })
})

describe('nextConnectorStatus', () => {
  it('flips to CONNECTED when complete and the def has shipped', () => {
    expect(nextConnectorStatus(defWith({}), ['apiKey', 'fromAddress'])).toBe('CONNECTED')
  })

  it('stays MOCK while any field is missing', () => {
    expect(nextConnectorStatus(defWith({}), ['apiKey'])).toBe('MOCK')
    expect(nextConnectorStatus(defWith({}), [])).toBe('MOCK')
  })

  it('stays MOCK for coming-soon defs even with a full credential set', () => {
    expect(nextConnectorStatus(defWith({ availability: 'coming-soon' }), ['apiKey', 'fromAddress'])).toBe('MOCK')
  })

  it('drops back to MOCK when a required field is deleted (delete → recompute path)', () => {
    // Simulates the delete flow: full set was CONNECTED, one field removed → MOCK.
    expect(nextConnectorStatus(defWith({}), ['fromAddress'])).toBe('MOCK')
  })
})

describe('applyStatusTransition', () => {
  it('lets the recompute replace configuration states', () => {
    expect(applyStatusTransition('MOCK', 'CONNECTED')).toBe('CONNECTED')
    expect(applyStatusTransition('CONNECTED', 'MOCK')).toBe('MOCK')
    expect(applyStatusTransition('NOT_CONFIGURED', 'MOCK')).toBe('MOCK')
  })

  it('never overwrites DISABLED or ERROR', () => {
    expect(applyStatusTransition('DISABLED', 'CONNECTED')).toBe('DISABLED')
    expect(applyStatusTransition('ERROR', 'CONNECTED')).toBe('ERROR')
  })
})

describe('outboundStateOf / outboundModeOf', () => {
  it('maps a missing row by catalog availability', () => {
    expect(outboundStateOf(null, 'available')).toBe('available')
    expect(outboundStateOf(null, 'coming-soon')).toBe('coming-soon')
    expect(outboundModeOf(null)).toBeNull()
  })

  it('folds MOCK and CONNECTED into the coarse connected state but splits them by mode', () => {
    const mock = { isEnabled: true, status: 'MOCK' as const }
    const live = { isEnabled: true, status: 'CONNECTED' as const }
    expect(outboundStateOf(mock, 'available')).toBe('connected')
    expect(outboundStateOf(live, 'available')).toBe('connected')
    expect(outboundModeOf(mock)).toBe('mock')
    expect(outboundModeOf(live)).toBe('live')
  })

  it('maps disabled, error and not-configured rows', () => {
    expect(outboundStateOf({ isEnabled: false, status: 'MOCK' }, 'available')).toBe('disabled')
    expect(outboundStateOf({ isEnabled: true, status: 'DISABLED' }, 'available')).toBe('disabled')
    expect(outboundStateOf({ isEnabled: true, status: 'ERROR' }, 'available')).toBe('error')
    expect(outboundStateOf({ isEnabled: true, status: 'NOT_CONFIGURED' }, 'available')).toBe('available')
    expect(outboundModeOf({ isEnabled: true, status: 'ERROR' })).toBeNull()
  })
})

describe('displayState', () => {
  it('splits mock mode out of connected for the UI pills', () => {
    expect(displayState('connected', 'mock')).toBe('mock')
    expect(displayState('connected', 'live')).toBe('connected')
    expect(displayState('connected', null)).toBe('connected')
  })

  it('passes every other state through untouched', () => {
    expect(displayState('available', null)).toBe('available')
    expect(displayState('disabled', 'mock')).toBe('disabled')
    expect(displayState('error', 'mock')).toBe('error')
    expect(displayState('coming-soon', null)).toBe('coming-soon')
  })
})

describe('buildCredentialFieldVMs', () => {
  it('joins declared fields to stored rows with masked material only', () => {
    const def = defWith({})
    const vms = buildCredentialFieldVMs(def.credentialFields, [
      { fieldKey: 'apiKey', last4: 'x9k2', updatedLabel: '2 hours ago' },
    ])
    expect(vms).toEqual([
      {
        key: 'apiKey',
        label: 'API key',
        secret: true,
        placeholder: null,
        configured: true,
        masked: '••••-x9k2',
        updatedLabel: '2 hours ago',
      },
      {
        key: 'fromAddress',
        label: 'From',
        secret: false,
        placeholder: null,
        configured: false,
        masked: null,
        updatedLabel: null,
      },
    ])
  })

  it('never carries anything beyond last4 into a VM', () => {
    const vms = buildCredentialFieldVMs(defWith({}).credentialFields, [
      { fieldKey: 'apiKey', last4: '1234' },
    ])
    const serialized = JSON.stringify(vms)
    expect(serialized).not.toContain('ciphertext')
    expect(serialized).not.toContain('authTag')
    expect(vms[0].masked).toBe('••••-1234')
  })

  it('ignores stored rows for keys the def no longer declares', () => {
    const vms = buildCredentialFieldVMs(defWith({}).credentialFields, [
      { fieldKey: 'legacyToken', last4: '0000' },
    ])
    expect(vms.every((v) => !v.configured)).toBe(true)
  })

  it('returns an empty list for defs without credential fields', () => {
    expect(buildCredentialFieldVMs(undefined, [])).toEqual([])
  })
})

describe('catalog credential declarations', () => {
  it('declares credential fields on exactly the six outbound defs', () => {
    const withCreds = CONNECTORS.filter((d) => d.credentialFields?.length).map((d) => d.id).sort()
    expect(withCreds).toEqual(['email-service', 'gohighlevel-api', 'meta-ads-api', 'stripe-payments', 'twilio-sms', 'twilio-voice'])
  })

  it('only outbound-backed defs declare credential fields', () => {
    for (const def of CONNECTORS) {
      if (def.credentialFields?.length) expect(isInbound(def)).toBe(false)
    }
  })

  it('Meta Ads connects on the lead-capture fields alone (ads-only fields are optional)', () => {
    const meta = connectorDef('meta-ads-api')!
    // The three required fields go live; the ad-account/business ids are optional.
    const leadCapture = credentialCompletion(meta, ['appId', 'appSecret', 'systemUserToken'])
    expect(leadCapture.complete).toBe(true)
    expect(leadCapture.required).toEqual(['appId', 'appSecret', 'systemUserToken'])
    expect(nextConnectorStatus(meta, ['appId', 'appSecret', 'systemUserToken'])).toBe('CONNECTED')
    // Missing a required field keeps it in MOCK.
    expect(credentialCompletion(meta, ['appId', 'appSecret']).complete).toBe(false)
  })

  it('ships email + twilio-sms as available; voice + payments stay coming-soon', () => {
    expect(connectorDef('email-service')!.availability).toBe('available')
    expect(connectorDef('twilio-sms')!.availability).toBe('available')
    expect(connectorDef('twilio-voice')!.availability).toBe('coming-soon')
    expect(connectorDef('stripe-payments')!.availability).toBe('coming-soon')
  })

  it('declares the agreed field keys', () => {
    expect(connectorDef('twilio-sms')!.credentialFields!.map((f) => f.key)).toEqual([
      'accountSid',
      'authToken',
      'fromNumber',
    ])
    expect(connectorDef('email-service')!.credentialFields!.map((f) => f.key)).toEqual(['apiKey', 'fromAddress'])
    expect(connectorDef('stripe-payments')!.credentialFields!.map((f) => f.key)).toEqual(['secretKey'])
  })

  it('marks every token-like field secret and every routing field non-secret', () => {
    for (const def of CONNECTORS) {
      for (const f of def.credentialFields ?? []) {
        if (['authToken', 'apiKey', 'secretKey'].includes(f.key)) expect(f.secret).toBe(true)
        if (['fromNumber', 'fromAddress', 'accountSid'].includes(f.key)) expect(f.secret).toBe(false)
      }
    }
  })
})
