/**
 * The shared contract between the telephony backend and the UI (plan §3,
 * docs/TELEPHONY_LIVE.md). Types and constants only: no `server-only`, no
 * imports from server modules, so client components can import it freely.
 */

export type DialTarget =
  | { kind: 'client'; id: string }
  | { kind: 'lead'; id: string } // CallCenterLead id
  | { kind: 'missed'; id: string } // VoiceCall id: call back an unknown caller

export type CallerLine = { id: string; display: string; label: string; isDefault: boolean }

export type VoiceSetup =
  | {
      ready: true
      identity: string
      lines: CallerLine[]
      canPickLine: boolean
      voiceLimited: boolean
      recordOutbound: boolean
      mode: 'twilio' | 'mock'
    }
  | { ready: false; reason: string } // plain English, shown as-is (also when VOICE_BROWSER_ENABLED is off)

export type VoiceToken = { token: string; identity: string; expiresAt: string } // ISO

export type OutboundPurpose = 'servicing' | 'marketing'

export type OutboundBlockCode =
  | 'INVALID_NUMBER'
  | 'NO_NUMBER'
  | 'NOT_IN_SCOPE'
  | 'LOCKED_BY_OTHER'
  | 'SUPPRESSED'
  | 'OPTED_OUT'
  | 'NO_CONSENT'
  | 'OUTSIDE_HOURS'
  | 'UNKNOWN_TIMEZONE'
  | 'VOICE_LIMITED_BUSY'
  | 'NO_LINE'
  | 'NOT_CONFIGURED'
  | 'NO_PERMISSION'
  | 'CHECK_FAILED'

export type DialCheck =
  | {
      ok: true
      who: string // name, or masked number
      purpose: OutboundPurpose
      calleeLocalTime: string // "2:14 pm"
      calleeZone: string // IANA, or "several zones"
      line: CallerLine | null // null in P0a (tel: flow)
      basis: string // "Consent on file (form 1234, Oct 2)"
      overrideToken?: string // present only after an approved hours override
      /**
       * E.164 for the tel: flow (line null). Only for telephony:manage holders,
       * who may see full numbers; everyone else dials from a page that already
       * shows the number, or from the contact's record.
       */
      dial?: string
    }
  | {
      ok: false
      code: OutboundBlockCode
      reason: string
      canOverride: 'hours' | null // 'hours' only inside the legal ceiling (§2.7)
    }

/** Custom params on Device.connect(). The server trusts nothing else from the browser. */
export type ConnectParams = {
  target: string // 'client:<id>' | 'lead:<id>' | 'missed:<id>'
  line: string // PhoneNumber id
  override?: string // overrideToken from checkDial
}

/** <Parameter>s on an incoming browser leg. */
export const INCOMING_PARAMS = ['pfCallId', 'pfCaller', 'pfLine', 'pfTarget'] as const

export type MissedCallVM = {
  id: string
  at: string
  lineLabel: string
  caller: string
  target: DialTarget | null
  reason: 'no-answer' | 'hung-up' | 'voicemail' | 'busy' | 'failed'
  voicemail: { src: string; seconds: number } | null
  /** The caller pressed 1 for a callback. These sort first. */
  callbackRequested?: boolean
  /** Twilio's transcription of the voicemail, when there is one. */
  transcript?: string | null
}

/** How a missed call was closed (VoiceCall.handledDisposition). */
export const MISSED_DISPOSITIONS = ['called_back', 'no_answer', 'spam', 'wrong_number', 'handled'] as const
export type MissedDisposition = (typeof MISSED_DISPOSITIONS)[number]

export type CarrierState = { status: string; source: 'twilio' | 'manual' | 'unknown'; note: string }

export type TwilioStatusVM = {
  mode: 'mock' | 'twilio'
  /** 'platform' when the viewer is the platform owner looking at the platform account. */
  scope: 'platform' | 'org'
  account: string // "AC…1234", never the token
  balance: string | null // "$41.20"; null unless scope is 'platform' or the org's own vault account
  numbers: { inTwilio: number | null; here: number; drift: number } // inTwilio null for scope 'org' on the platform account
  profile: CarrierState
  a2p: CarrierState // this org's Messaging Service
  voiceLimited: { on: boolean; mode: 'auto' | 'on' | 'off'; why: string; canChange: boolean }
  mediaAuth: { state: 'on' | 'off' | 'unknown'; checkedAt: string | null }
  env: { name: string; set: boolean }[] // empty unless scope is 'platform'
  recentErrors: { code: string; meaning: string; count: number; lastAt: string }[] // this org's calls and texts only, unless scope is 'platform'
  checkedAt: string | null
}

export type SyncRowVM = {
  sid: string
  display: string // full E.164 only when the viewer may see it, else "•••-•••-1234"
  friendlyName: string
  state: 'new' | 'here' | 'other-account' | 'released-here' | 'unassigned'
  assignedOrg: { id: string; name: string } | null // platform owner only
  otherAccount: string | null // name only for the platform owner, else "another account"
  voiceUrlHost: string | null
  pointsHere: boolean
  capabilities: { voice: boolean; sms: boolean; mms: boolean }
}
export type SyncPreviewVM = { account: string; platform: boolean; organizationName: string; rows: SyncRowVM[] }
export type SyncResultVM = {
  imported: number
  updated: number
  repointed: number
  skipped: { sid: string; reason: string }[]
}

export type SuppressionVM = {
  id: string
  last4: string
  reason: string
  by: string | null
  sms: { at: string; source: string } | null
  call: { at: string; source: string } | null
}
export type CallingRulesVM = {
  recordOutbound: boolean
  windowStart: number
  windowEnd: number
  /** Transcribe voicemails (default on). Absent on save = leave as it is. */
  transcribeVoicemail?: boolean
} // strict DNC is the only mode in P0
