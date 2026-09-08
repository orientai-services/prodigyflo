import type { IntakeSourceKind, ConnectorKind } from '@prisma/client'
import type { CrmFieldKey } from '@/lib/intake/mapping'

/**
 * The connector catalog — the single, declarative source of truth for every
 * integration ProdigyFlo can talk to. Adding a new connector is one entry in
 * CONNECTORS below: give it an id, a category, how it authenticates, and (for
 * inbound sources) a field-mapping preset + a sample payload. The hub UI, the
 * provisioning flow, and the mapping tester all read from here, so a new
 * connector needs no bespoke UI and no new endpoint — it rides the existing
 * HMAC intake pipeline (/api/intake/[slug]) the moment it is listed.
 *
 * Two backings exist:
 *  - inbound  → creates an IntakeSource (leads flow IN through the intake
 *               pipeline: signature-verified webhook, field mapping, dedupe).
 *  - outbound → creates/enables a Connector (a service ProdigyFlo calls OUT
 *               to; most are credential-bound and ship as 'mock'/'coming-soon'
 *               until keys exist).
 */

export type ConnectorCategory =
  | 'CRM'
  | 'Advertising'
  | 'Spreadsheet'
  | 'Automation'
  | 'Generic'
  | 'Communications'
  | 'Payments'
  | 'AI'

export type ConnectorAuth =
  | 'webhook-hmac' // inbound: we mint a signing secret, they sign each POST
  | 'webhook-token' // inbound: they present a static shared-token header (GoHighLevel)
  | 'sheet' // inbound: polled Google Sheet
  | 'file' // inbound: manual CSV upload
  | 'oauth' // outbound: OAuth handshake (credential-bound)
  | 'api-key' // outbound: bearer/api key (credential-bound)
  | 'none'

export type ConnectorAvailability = 'available' | 'beta' | 'coming-soon'
export type ConnectorDirection = 'inbound' | 'outbound' | 'bidirectional'

export type ConnectorBacking =
  | { model: 'intakeSource'; kind: IntakeSourceKind }
  | { model: 'connector'; kind: ConnectorKind }

/** One credential input on an outbound connector — stored encrypted in the vault. */
export type CredentialField = {
  /** Stable key — persisted on ConnectorCredential.fieldKey; never rename. */
  key: string
  label: string
  /** Secret values render write-only: password inputs in, masked ••••-last4 out. */
  secret: boolean
  placeholder?: string
  /**
   * Optional fields do NOT gate MOCK → CONNECTED. They enrich an already-live
   * connector (e.g. Meta's Ad Account / Business Manager ids power the campaign
   * manager but are not needed for lead capture). Omitted defaults to required.
   */
  optional?: boolean
}

export type ConnectorDef = {
  /** Stable slug — persisted on IntakeSource.connectorDefId; never rename. */
  id: string
  name: string
  tagline: string
  category: ConnectorCategory
  direction: ConnectorDirection
  auth: ConnectorAuth
  availability: ConnectorAvailability
  backing: ConnectorBacking
  /** One-emoji glyph for the catalog card (favicon-style, no asset needed). */
  glyph: string
  /** Brand-ish accent for the card chip (used as an inline style, token-safe). */
  accent: string
  /** Inbound only: default { crmField: incomingKey } mapping, dot-paths allowed. */
  fieldPreset?: Partial<Record<CrmFieldKey, string>>
  /** Inbound only: which incoming key holds the stable external id (idempotency). */
  externalIdKey?: string
  /** Inbound only: a representative payload for the live mapping tester. */
  samplePayload?: Record<string, unknown>
  /** Human setup steps shown on the connector's detail page. */
  setup: string[]
  /**
   * Outbound only: the credential inputs the vault stores for this service.
   * Every field must be present for the connector to flip MOCK → CONNECTED —
   * and only when the def is 'available'; 'coming-soon' defs accept credentials
   * but stay in mock mode until their adapter ships.
   */
  credentialFields?: CredentialField[]
  /**
   * Inbound defs whose IntakeSource is provisioned automatically by a dedicated
   * webhook route (Instagram → /api/meta/instagram), NOT the self-serve Connect
   * flow. A per-source signing secret would be meaningless (Meta signs with the
   * app secret via X-Hub-Signature-256), so Connect refuses these.
   */
  managed?: boolean
  docsUrl?: string
}

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'gohighlevel',
    name: 'GoHighLevel',
    tagline: 'Push new contacts and opportunities straight into the CRM.',
    category: 'CRM',
    direction: 'inbound',
    auth: 'webhook-token',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'GO_HIGH_LEVEL' },
    glyph: '🚀',
    accent: '#2ea3f2',
    fieldPreset: {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phone: 'phone',
    },
    externalIdKey: 'contact_id',
    samplePayload: {
      contact_id: 'aBc123XyZ',
      first_name: 'Jane',
      last_name: 'Doe',
      full_name: 'Jane Doe',
      email: 'jane.doe@example.com',
      phone: '+17025551234',
      tags: ['solar', 'inbound'],
      source: 'Facebook Lead Form',
    },
    setup: [
      'In GoHighLevel: Automation → Workflows → open (or create) the workflow that should hand data to ProdigyFlo.',
      'Set a Trigger for the event you want forwarded — e.g. Contact Created, Form Submitted, Opportunity Status Changed, or Funnel/Website pageview. (Do NOT use the "Inbound webhook" trigger — that is GoHighLevel receiving, not sending.)',
      'Add an Action → search "Webhook" → Webhook. Method POST, URL = the endpoint URL above.',
      'Add two headers: X-Connector-Token = the token below, and Content-Type = application/json.',
      'Set the body to Custom JSON and map GoHighLevel merge fields to these keys: contact_id {{contact.id}}, first_name, last_name, email, phone (the GoHighLevel field preset is already applied here).',
      'Save, Publish, then Test workflow — the event lands in Setup → Connectors → this connector, and in the Inbound workspace.',
    ],
    docsUrl: 'https://highlevel.stoplight.io/docs/integrations/',
  },
  {
    id: 'generic-webhook',
    name: 'Generic Webhook / API',
    tagline: 'Any system that can POST JSON — you define the field mapping.',
    category: 'Generic',
    direction: 'inbound',
    auth: 'webhook-token',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'GENERIC_WEBHOOK' },
    glyph: '🧩',
    accent: '#6366f1',
    externalIdKey: 'id',
    samplePayload: {
      id: 'lead-0001',
      email: 'lead@example.com',
      first_name: 'Sam',
      last_name: 'Rivera',
      phone: '+17025550100',
    },
    setup: [
      'Point your system at the endpoint URL above with an HTTP POST and a JSON object body.',
      'Authenticate with the header X-Connector-Token = the token below (constant-time checked). No request signing needed.',
      'Open the mapping panel and map each of your JSON keys (dot-paths like data.email are allowed) to a CRM field.',
      'Use the live tester to paste a real payload and confirm the mapping before going live.',
    ],
  },
  {
    id: 'zapier',
    name: 'Zapier',
    tagline: 'Connect 6,000+ apps by forwarding their events to ProdigyFlo.',
    category: 'Automation',
    direction: 'inbound',
    auth: 'webhook-token',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'ZAPIER' },
    glyph: '⚡',
    accent: '#ff4a00',
    externalIdKey: 'id',
    samplePayload: {
      id: 'zap-77af',
      email: 'newlead@example.com',
      first_name: 'Alex',
      last_name: 'Kim',
      phone: '+17025550142',
    },
    setup: [
      'Create a Zap with any trigger, then add a "Webhooks by Zapier" → POST action.',
      'Set the URL to the endpoint above and the payload type to JSON.',
      'Add a header X-Connector-Token = the token below (a static value Zapier can send directly — no code step needed).',
      'Map your trigger fields into the JSON body, then map those keys to CRM fields here.',
    ],
    docsUrl: 'https://zapier.com/apps/webhook/integrations',
  },
  {
    id: 'meta-lead-ads',
    name: 'Meta Lead Ads',
    tagline: 'Instant forms from Facebook & Instagram campaigns.',
    category: 'Advertising',
    direction: 'inbound',
    auth: 'webhook-hmac',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'META_LEAD_ADS' },
    glyph: '📣',
    accent: '#0866ff',
    fieldPreset: {
      firstName: 'first_name',
      lastName: 'last_name',
      email: 'email',
      phone: 'phone_number',
    },
    externalIdKey: 'leadgen_id',
    samplePayload: {
      leadgen_id: '1023344556677',
      first_name: 'Priya',
      last_name: 'Nomvete',
      email: 'priya@example.com',
      phone_number: '+17025550175',
      campaign_name: 'Q3 Relief Awareness',
    },
    setup: [
      'The Meta Ads workspace also has a dedicated manager under Marketing → Meta Ads.',
      'Leads can flow in here via the signed webhook, or through the Meta connector when credentials are configured.',
      'Meta Ads API credentials stored in the vault override any META_* environment variables — the Meta workspace prefers vault credentials when both exist.',
    ],
  },
  {
    id: 'meta-ads-api',
    name: 'Meta Ads',
    tagline: 'Connect Facebook & Instagram Lead Ads — leads flow straight into the CRM.',
    category: 'Advertising',
    direction: 'bidirectional',
    auth: 'api-key',
    availability: 'available',
    backing: { model: 'connector', kind: 'META_ADS' },
    glyph: '🔗',
    accent: '#0866ff',
    credentialFields: [
      { key: 'appId', label: 'App ID', secret: false, placeholder: '1072957135381673' },
      { key: 'appSecret', label: 'App Secret', secret: true, placeholder: 'App Dashboard → App settings → Basic' },
      { key: 'systemUserToken', label: 'System User access token', secret: true, placeholder: 'Never-expiring token with leads_retrieval + ads_read' },
      { key: 'adAccountId', label: 'Ad Account ID', secret: false, optional: true, placeholder: 'act_1742876583597558 (or just the digits)' },
      { key: 'businessId', label: 'Business Manager ID', secret: false, optional: true, placeholder: '1387324766125848' },
    ],
    setup: [
      'Paste the Meta App ID and App Secret from developers.facebook.com → your app → App settings → Basic.',
      'Create a System User under Business Settings → Users → System users, assign it the Page and the ad account, then generate a never-expiring token carrying leads_retrieval, ads_read, ads_management, pages_show_list and pages_manage_ads — paste it as the System User access token.',
      'Lead capture goes live the moment App ID, App Secret and the System User token are saved; the Ad Account ID and Business Manager ID additionally light up the campaign manager under Marketing → Meta Ads.',
      'Finish by pasting the webhook Callback URL and Verify token shown under Marketing → Meta Ads into the Meta App Dashboard → Webhooks → Page → leadgen, then subscribe the Page. Credentials are held encrypted in the vault and never leave the server.',
    ],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads/',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    tagline: 'Turn Instagram DMs, comments & story replies into CRM leads.',
    category: 'Advertising',
    direction: 'inbound',
    auth: 'webhook-hmac',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'GENERIC_WEBHOOK' },
    managed: true,
    glyph: '📸',
    accent: '#E1306C',
    externalIdKey: 'eventId',
    samplePayload: {
      object: 'instagram',
      entry: [
        { id: '17841400000000000', messaging: [{ sender: { id: '6123456789' }, message: { mid: 'aWdEd...', text: 'Interested in solar — how much?' } }] },
      ],
    },
    setup: [
      'Instagram DMs, comments and story replies flow into the CRM through the SAME Meta app as Lead Ads — no separate credentials to store here.',
      'Your System User token must additionally carry instagram_basic, instagram_manage_messages and instagram_manage_comments (these go through Meta App Review alongside leads_retrieval).',
      'In Meta App Dashboard → Webhooks → Instagram, paste the callback URL https://prodigyflo.ai/api/meta/instagram and the Verify token shown under Marketing → Meta Ads, then subscribe to messages and comments.',
      'Connect your Instagram business account to the Solar Contract Services Page. Instagram leads carry a name + @handle + message (not an email/phone); repeat messagers dedupe to one client.',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform/webhooks',
  },
  {
    id: 'google-sheet',
    name: 'Google Sheets',
    tagline: 'Poll a response sheet — one row becomes one lead.',
    category: 'Spreadsheet',
    direction: 'inbound',
    auth: 'sheet',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'GOOGLE_SHEET' },
    glyph: '📊',
    accent: '#0f9d58',
    setup: [
      'Create the source, then set the Sheet ID and tab in its settings.',
      'Each new row is pulled on the sync schedule and mapped to a lead by column header.',
      'Map the column headers to CRM fields in the mapping panel.',
    ],
  },
  {
    id: 'web-form',
    name: 'Web Form',
    tagline: 'A signed endpoint for your own site or landing pages.',
    category: 'Generic',
    direction: 'inbound',
    auth: 'webhook-token',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'WEB_FORM' },
    glyph: '📝',
    accent: '#3d46c4',
    externalIdKey: 'id',
    samplePayload: { id: 'form-1', email: 'you@example.com', first_name: 'Jordan', phone: '+17025550188' },
    setup: [
      'POST your form submissions as JSON to the endpoint above.',
      'Sign each request with X-Intake-Signature (HMAC-SHA256 of the body) using the signing secret.',
      'Map your form field names to CRM fields.',
    ],
  },
  {
    id: 'csv-import',
    name: 'CSV Import',
    tagline: 'Bulk-load a list once — no live connection.',
    category: 'Spreadsheet',
    direction: 'inbound',
    auth: 'file',
    availability: 'available',
    backing: { model: 'intakeSource', kind: 'CSV_IMPORT' },
    glyph: '📁',
    accent: '#6b7280',
    setup: [
      'Create the source and upload a CSV; each row maps to a lead by column header.',
      'Map the columns to CRM fields, then run the import.',
    ],
  },

  // ── Outbound services (credential-bound; catalog-visible, mostly staged) ──
  {
    id: 'gohighlevel-api',
    name: 'GoHighLevel API',
    tagline: 'Pull contacts and opportunities out of a GoHighLevel location.',
    category: 'CRM',
    direction: 'outbound',
    auth: 'api-key',
    availability: 'available',
    backing: { model: 'connector', kind: 'GO_HIGH_LEVEL' },
    glyph: '🛰️',
    accent: '#2ea3f2',
    credentialFields: [
      { key: 'apiToken', label: 'Private Integration token', secret: true, placeholder: 'pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
      { key: 'locationId', label: 'Location ID', secret: false, placeholder: 've9EPM428h8vShlRW1KT' },
    ],
    setup: [
      'In GoHighLevel, open the sub-account (location) you want to import from, then go to Settings → Private Integrations.',
      'Create a Private Integration and grant it at least the "View Contacts" and "View Opportunities" scopes; copy the token it mints (it starts with "pit-" and is shown once).',
      'Find your Location ID under Settings → Business Profile (it also appears in the sub-account URL after /location/).',
      'Store both in the Credentials card here — the token is held encrypted and never leaves the server.',
      'Run the import below. Contacts flow through the same field mapping and dedupe as the GoHighLevel webhook, so re-running is safe: already-imported records report as duplicates, never copies.',
    ],
    docsUrl: 'https://highlevel.stoplight.io/docs/integrations/',
  },
  {
    id: 'twilio-sms',
    name: 'Twilio SMS',
    tagline: 'Two-way texting from the client timeline.',
    category: 'Communications',
    direction: 'bidirectional',
    auth: 'api-key',
    availability: 'available',
    backing: { model: 'connector', kind: 'TWILIO_SMS' },
    glyph: '💬',
    accent: '#f22f46',
    credentialFields: [
      { key: 'accountSid', label: 'Account SID', secret: false, placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'authToken', label: 'Auth Token', secret: true, placeholder: 'Your Twilio auth token' },
      { key: 'fromNumber', label: 'From number', secret: false, placeholder: '+17025550100' },
    ],
    setup: [
      'In the Twilio Console, copy your Account SID and Auth Token from the account dashboard.',
      'Buy or pick an SMS-capable number and enter it as the From number (E.164, e.g. +17025550100).',
      'Store all three in the Credentials card — once complete, messaging flips from mock to live sending.',
    ],
    docsUrl: 'https://www.twilio.com/docs',
  },
  {
    id: 'twilio-voice',
    name: 'Twilio Voice',
    tagline: 'Click-to-call and call recording.',
    category: 'Communications',
    direction: 'bidirectional',
    auth: 'api-key',
    availability: 'coming-soon',
    backing: { model: 'connector', kind: 'TWILIO_VOICE' },
    glyph: '📞',
    accent: '#f22f46',
    credentialFields: [
      { key: 'accountSid', label: 'Account SID', secret: false, placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'authToken', label: 'Auth Token', secret: true, placeholder: 'Your Twilio auth token' },
      { key: 'fromNumber', label: 'From number', secret: false, placeholder: '+17025550100' },
    ],
    setup: [
      'The voice adapter is still in the works — this connector stays in mock mode for now.',
      'You can store your Twilio voice credentials today; they are held encrypted and go live the moment the adapter ships.',
    ],
  },
  {
    id: 'email-service',
    name: 'Email (SMTP / API)',
    tagline: 'Send and receive email against the client record.',
    category: 'Communications',
    direction: 'bidirectional',
    auth: 'api-key',
    availability: 'available',
    backing: { model: 'connector', kind: 'EMAIL' },
    glyph: '✉️',
    accent: '#0ea5e9',
    credentialFields: [
      { key: 'apiKey', label: 'Resend API key', secret: true, placeholder: 're_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      { key: 'fromAddress', label: 'From address', secret: false, placeholder: 'team@yourdomain.com' },
    ],
    setup: [
      'Create an API key at resend.com (API Keys → Create) and verify your sending domain there.',
      'Enter the key and the From address in the Credentials card — once both are stored, email flips from mock to live sending.',
    ],
    docsUrl: 'https://resend.com/docs',
  },
  {
    id: 'stripe-payments',
    name: 'Payments',
    tagline: 'Collect and reconcile payments on a deal.',
    category: 'Payments',
    direction: 'outbound',
    auth: 'api-key',
    availability: 'coming-soon',
    backing: { model: 'connector', kind: 'PAYMENT' },
    glyph: '💳',
    accent: '#635bff',
    credentialFields: [
      { key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_xxxxxxxxxxxxxxxxxxxxxxxx' },
    ],
    setup: [
      'The payments adapter is still in the works — this connector stays in mock mode for now.',
      'You can store your processor secret key today; it is held encrypted and goes live the moment the adapter ships.',
    ],
  },
]

// ── Lookups ──────────────────────────────────────────────────────────────────

const BY_ID = new Map(CONNECTORS.map((c) => [c.id, c]))

export function connectorDef(id: string | null | undefined): ConnectorDef | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}

/** The def a stored IntakeSource maps to: by connectorDefId, else by kind. */
export function defForIntakeKind(kind: IntakeSourceKind, connectorDefId?: string | null): ConnectorDef | null {
  const byDef = connectorDef(connectorDefId)
  if (byDef) return byDef
  return CONNECTORS.find((c) => c.backing.model === 'intakeSource' && c.backing.kind === kind) ?? null
}

export function defForConnectorKind(kind: ConnectorKind): ConnectorDef | null {
  return CONNECTORS.find((c) => c.backing.model === 'connector' && c.backing.kind === kind) ?? null
}

export const CONNECTOR_CATEGORIES: ConnectorCategory[] = [
  'CRM',
  'Advertising',
  'Spreadsheet',
  'Automation',
  'Generic',
  'Communications',
  'Payments',
  'AI',
]

export function isInbound(def: ConnectorDef): def is ConnectorDef & { backing: { model: 'intakeSource'; kind: IntakeSourceKind } } {
  return def.backing.model === 'intakeSource'
}
