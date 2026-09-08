/**
 * ProdigyFlo demo seed — synthetic data only.
 *
 * Deterministic: a fixed-seed PRNG drives every random choice so re-running
 * produces the same dataset. No real people, phone numbers, or financial data.
 */
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import {
  AppointmentStatus,
  AppointmentType,
  AttributionTouch,
  CallOutcome,
  ClientStatus,
  CommunicationChannel,
  CommunicationDirection,
  CommunicationStatus,
  ConnectorKind,
  ConnectorStatus,
  ConsentType,
  CreditPullStatus,
  DealStatus,
  DocumentStatus,
  FinancingStatus,
  PaymentPath,
  PaymentStatus,
  PrismaClient,
  QualificationOutcome,
  RoleKey,
  StageKey,
  SubmissionDestination,
  SubmissionStatus,
  SurveyStatus,
  TaskPriority,
  TaskStatus,
  VerificationStatus,
  VerificationType,
} from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import nodePath from 'node:path'
import { seedIntake, DEMO_INTAKE_SECRET } from './seeds/intake'
import { seedDocuments } from './seeds/documents'
import { seedAutomation } from './seeds/automation'
import { seedOps } from './seeds/ops'
import { seedPortal } from './seeds/portal'
import { seedCloseops } from './seeds/closeops'
import { DEFAULT_STAGES } from '../src/lib/pipeline'
import { bootstrapOrganization, INTAKE_SURVEY_NAME, LEAD_SOURCE_DEFS } from '../src/lib/org/bootstrap'

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

// ── deterministic RNG ────────────────────────────────────────
let _s = 0x9e3779b9
function rand(): number {
  _s |= 0
  _s = (_s + 0x6d2b79f5) | 0
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min
const chance = (p: number) => rand() < p
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000)
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000)
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

/**
 * Demo documents are written to local storage for real, under the same opaque
 * `<hex>.bin` keys the upload route produces. Fabricating a key that no file
 * backs would make every preview and download dead on arrival.
 */
const STORAGE_DIR = nodePath.resolve(process.cwd(), process.env.FILE_STORAGE_LOCAL_DIR ?? 'storage/documents')

function storeDemoDocument(clientId: string, reqKey: string, body: string) {
  mkdirSync(STORAGE_DIR, { recursive: true })
  // Derived, not random, so re-seeding overwrites instead of accumulating files.
  const key = `${createHash('sha256').update(`${clientId}:${reqKey}`).digest('hex').slice(0, 32)}.bin`
  const buf = Buffer.from(body, 'utf8')
  writeFileSync(nodePath.join(STORAGE_DIR, key), buf)
  return { key, checksum: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length }
}

const FIRST = ['Marisol', 'Devon', 'Priya', 'Elias', 'Naomi', 'Tomas', 'Ingrid', 'Rashad', 'Lucia', 'Bennett', 'Yusuf', 'Camille', 'Otto', 'Freya', 'Malik', 'Rosa', 'Dmitri', 'Amara', 'Soren', 'Delia', 'Hugo', 'Neve', 'Kwame', 'Talia', 'Emmett', 'Zaid', 'Marguerite', 'Cato', 'Linnea', 'Osric']
const LAST = ['Aldana', 'Whitfield', 'Ramaswamy', 'Bergstrom', 'Okonkwo', 'Vasquez', 'Lindqvist', 'Coleridge', 'Marchetti', 'Fairbanks', 'Halloran', 'Nakamura', 'Ferreira', 'Ostrowski', 'Delacroix', 'Mbeki', 'Sandoval', 'Thorne', 'Kowalczyk', 'Reyes-Hall', 'Ashworth', 'Bellweather', 'Castellanos', 'Duplantis', 'Everhart']
const CITIES: Record<string, [string, string][]> = {
  WEST: [['Sacramento', 'CA'], ['Fresno', 'CA'], ['Bakersfield', 'CA'], ['Riverside', 'CA'], ['Modesto', 'CA']],
  SW: [['Las Vegas', 'NV'], ['Henderson', 'NV'], ['Phoenix', 'AZ'], ['Tucson', 'AZ'], ['Albuquerque', 'NM']],
  SE: [['Orlando', 'FL'], ['Tampa', 'FL'], ['Jacksonville', 'FL'], ['Atlanta', 'GA'], ['Charlotte', 'NC']],
}
const STREETS = ['Juniper Hollow', 'Cattail Ridge', 'Sundial', 'Pelican Bend', 'Marlow', 'Quarry Stone', 'Fernbank', 'Copperline', 'Wexford', 'Bramblewood']
const LOST_REASONS = ['Price objection', 'Chose a competitor', 'Went unresponsive', 'Spouse declined', 'Timing not right', 'Could not produce documents']
const HOLD_REASONS = ['Client traveling', 'Awaiting spouse availability', 'Pending external document', 'Requested pause until next month']
const DQ_REASONS = ['Outside service area', 'No qualifying contract on file', 'Affordability below threshold', 'Duplicate record']
const OBJECTIONS = ['Needs to think it over', 'Concerned about timeline', 'Wants a second opinion', 'Fee is higher than expected']

async function main() {
  console.log('→ resetting demo data')
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditEvent","Notification","ConnectorLog","Connector","AIRecommendation",
      "Submission","Deal","AttributionEvent","Campaign","LeadSource","Note","Task",
      "Message","Call","Communication","DocumentReview","ClientDocument",
      "DocumentRequirement","DocumentPackage","FinancingApplication","PaymentMethod",
      "Presentation","Appointment","AvailabilitySlot","Assignment","Contract",
      "QualificationReview","CreditPull","Verification","Consent","SurveyResponse",
      "Survey","StageHistory","ClientAddress","Client","PipelineStage","Pipeline",
      "UserSession","User","RolePermission","Role","Permission","Team","Region","Organization"
    RESTART IDENTITY CASCADE
  `)

  // ── org structure via the shared bootstrap ─────────────────
  // Permissions, org row, roles, pipeline+stages, intake survey, submission
  // package, lead sources, and starter templates all come from the same
  // bootstrap that provisions real accounts. The demo data layers on top.
  console.log('→ bootstrap organization (permissions, roles, pipeline, survey, package, sources)')
  const { organizationId, roleIdByKey: roleId } = await bootstrapOrganization(db, {
    name: 'Meridian Client Solutions',
    slug: 'meridian',
    timezone: 'America/Los_Angeles',
    settings: {
      terminology: {
        // Spec §9: organization-configurable terminology rather than a
        // hard-coded interpretation of undefined terms.
        dimCloser: 'DIM Closer',
        factLead: 'Fact Lead',
        factAppointment: 'Fact Appointment',
      },
      slaWarningPct: 80,
      minimumSampleForRanking: 10,
    },
  })
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId } })

  // Fetch the bootstrapped structure the demo data builds on.
  const pipeline = await db.pipeline.findFirstOrThrow({
    where: { organizationId: org.id, isDefault: true },
  })
  const stages = await db.pipelineStage.findMany({ where: { pipelineId: pipeline.id } })
  const stageId = new Map(stages.map((s) => [s.key, s.id]))
  const survey = await db.survey.findFirstOrThrow({
    where: { organizationId: org.id, name: INTAKE_SURVEY_NAME },
  })
  const docPackage = await db.documentPackage.findFirstOrThrow({
    where: { organizationId: org.id, isDefault: true },
  })
  const requirements = await db.documentRequirement.findMany({
    where: { packageId: docPackage.id },
    orderBy: { position: 'asc' },
  })
  const sourceRows = await db.leadSource.findMany({ where: { organizationId: org.id } })
  // Def order, not query order — the deterministic RNG picks sources by index.
  const leadSources = LEAD_SOURCE_DEFS.map((d) => sourceRows.find((r) => r.key === d.key)!)

  // ── regions & teams ────────────────────────────────────────
  console.log('→ regions, teams, users')
  const regionDefs = [
    { code: 'WEST', name: 'West', tz: 'America/Los_Angeles' },
    { code: 'SW', name: 'Southwest', tz: 'America/Phoenix' },
    { code: 'SE', name: 'Southeast', tz: 'America/New_York' },
  ]
  const regions = []
  for (const r of regionDefs) {
    regions.push(
      await db.region.create({
        data: { organizationId: org.id, name: r.name, code: r.code, timezone: r.tz },
      }),
    )
  }

  const pw = await bcrypt.hash('Demo!2345', 10)
  const mkUser = (data: Record<string, unknown>) =>
    db.user.create({ data: { organizationId: org.id, passwordHash: pw, ...data } as never })

  const superAdmin = await mkUser({
    roleId: roleId.get('SUPER_ADMIN'),
    isOwner: true, // dev parity with the production owner concept
    email: 'super@prodigyflo.ai',
    name: 'Avery Sloane',
    title: 'Platform Owner',
    phone: '+1 555 0100',
    languages: ['en'],
  })
  const admin = await mkUser({
    roleId: roleId.get('ADMIN'),
    email: 'admin@prodigyflo.ai',
    name: 'Beatriz Ocampo',
    title: 'Director of Operations',
    phone: '+1 555 0101',
    languages: ['en', 'es'],
  })
  const marketing = await mkUser({
    roleId: roleId.get('MARKETING'),
    email: 'marketing@prodigyflo.ai',
    name: 'Kai Petrov',
    title: 'Growth Lead',
    phone: '+1 555 0102',
    languages: ['en'],
  })

  const collectors = []
  for (const [i, name] of ['Nadia Kirk', 'Emeka Bass', 'Solveig Ranta'].entries()) {
    collectors.push(
      await mkUser({
        roleId: roleId.get('DOCUMENT_COLLECTOR'),
        email: `collector${i + 1}@prodigyflo.ai`,
        name,
        title: 'Document Collector (outsourced)',
        phone: `+1 555 020${i}`,
        languages: i === 1 ? ['en', 'es'] : ['en'],
      }),
    )
  }

  const regionalManagers: Awaited<ReturnType<typeof mkUser>>[] = []
  const teams: { id: string; regionId: string; managerId: string }[] = []
  const closers: { id: string; teamId: string; regionId: string; name: string; languages: string[] }[] = []

  const rmNames = ['Corinne Vale', 'Desmond Achebe', 'Ilse Brandt']
  const smNames = [
    ['Priyanka Raval', 'Tobias Lund'],
    ['Marisela Cruz', 'Grant Ellery'],
    ['Noor Haddad', 'Vance Ridley'],
  ]
  const closerPool = [...FIRST]

  for (const [ri, region] of regions.entries()) {
    const rm = await mkUser({
      roleId: roleId.get('REGIONAL_MANAGER'),
      email: `rm.${region.code.toLowerCase()}@prodigyflo.ai`,
      name: rmNames[ri],
      title: `Regional Manager — ${region.name}`,
      regionId: region.id,
      phone: `+1 555 03${ri}0`,
      languages: ['en'],
    })
    regionalManagers.push(rm)

    for (const [ti, smName] of smNames[ri].entries()) {
      const team = await db.team.create({
        data: { organizationId: org.id, regionId: region.id, name: `${region.name} Team ${ti + 1}` },
      })
      const sm = await mkUser({
        roleId: roleId.get('SALES_MANAGER'),
        email: `sm.${region.code.toLowerCase()}${ti + 1}@prodigyflo.ai`,
        name: smName,
        title: 'Sales Manager',
        regionId: region.id,
        teamId: team.id,
        managerId: rm.id,
        phone: `+1 555 04${ri}${ti}`,
        languages: ti === 0 ? ['en', 'es'] : ['en'],
      })
      await db.team.update({ where: { id: team.id }, data: { managerId: sm.id } })
      teams.push({ id: team.id, regionId: region.id, managerId: sm.id })

      for (let ci = 0; ci < 3; ci++) {
        const first = closerPool.shift() ?? `Closer${ci}`
        const last = pick(LAST)
        const langs = chance(0.4) ? ['en', 'es'] : ['en']
        const closer = await mkUser({
          roleId: roleId.get('CLOSER'),
          email: `${first.toLowerCase()}.${region.code.toLowerCase()}${ti}${ci}@prodigyflo.ai`,
          name: `${first} ${last}`,
          title: 'Closer',
          regionId: region.id,
          teamId: team.id,
          managerId: sm.id,
          maxWorkload: int(18, 32),
          languages: langs,
          licensedIn: [region.code === 'SE' ? 'FL' : region.code === 'SW' ? 'NV' : 'CA'],
          specialties: chance(0.5) ? ['contract-review'] : ['financing'],
          phone: `+1 555 1${ri}${ti}${ci}0`,
        })
        closers.push({ id: closer.id, teamId: team.id, regionId: region.id, name: closer.name, languages: langs })

        for (let wd = 1; wd <= 5; wd++) {
          await db.availabilitySlot.create({
            data: { userId: closer.id, weekday: wd, startMinute: 9 * 60, endMinute: 17 * 60 },
          })
        }
      }
    }
  }
  console.log(`   ${closers.length} closers across ${teams.length} teams`)

  // ── marketing ──────────────────────────────────────────────
  console.log('→ campaigns')
  const campaignDefs = [
    { src: 'meta_ads', name: 'Q3 Relief Awareness — Spanish', spend: 18400, imp: 412_000, clicks: 9_800 },
    { src: 'meta_ads', name: 'Q3 Relief Awareness — English', spend: 22150, imp: 508_000, clicks: 11_400 },
    { src: 'google_search', name: 'Brand + Contract Terms', spend: 15600, imp: 96_000, clicks: 7_200 },
    { src: 'google_search', name: 'Competitor Comparison', spend: 9400, imp: 51_000, clicks: 3_100 },
    { src: 'door_knock', name: 'Southwest Territory Sweep', spend: 6200, imp: 0, clicks: 0 },
    { src: 'referral', name: 'Client Referral Bonus', spend: 3100, imp: 0, clicks: 0 },
  ]
  const campaigns = []
  for (const c of campaignDefs) {
    const src = leadSources.find((s) => s.key === c.src)!
    campaigns.push(
      await db.campaign.create({
        data: {
          organizationId: org.id,
          leadSourceId: src.id,
          name: c.name,
          channel: src.channel,
          status: 'active',
          startedAt: daysAgo(120),
          budget: c.spend * 1.2,
          spend: c.spend,
          impressions: c.imp,
          clicks: c.clicks,
          utmCampaign: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        },
      }),
    )
  }

  // ── connectors ─────────────────────────────────────────────
  console.log('→ connectors')
  const connectorDefs: { kind: ConnectorKind; name: string; status: ConnectorStatus }[] = [
    { kind: 'CREDIT_BUREAU', name: 'Soft Credit Provider', status: 'MOCK' },
    { kind: 'TWILIO_VOICE', name: 'Twilio Voice', status: 'MOCK' },
    { kind: 'TWILIO_SMS', name: 'Twilio SMS', status: 'MOCK' },
    { kind: 'IMESSAGE', name: 'iMessage Bridge', status: 'NOT_CONFIGURED' },
    { kind: 'EMAIL', name: 'Transactional Email', status: 'MOCK' },
    { kind: 'CALENDAR', name: 'Calendar Sync', status: 'MOCK' },
    { kind: 'META_ADS', name: 'Meta Lead Ads', status: 'MOCK' },
    { kind: 'PAYMENT', name: 'Payment Processor', status: 'MOCK' },
    { kind: 'FINANCING', name: 'Financing Partner', status: 'MOCK' },
    { kind: 'CYS', name: 'CYS Submission', status: 'MOCK' },
    { kind: 'ATTORNEY', name: 'Attorney Review Service', status: 'MOCK' },
    { kind: 'FILE_STORAGE', name: 'Document Storage', status: 'MOCK' },
    { kind: 'AI_PROVIDER', name: 'AI Provider', status: 'MOCK' },
  ]
  for (const c of connectorDefs) {
    const conn = await db.connector.create({
      data: {
        organizationId: org.id,
        kind: c.kind,
        name: c.name,
        status: c.status,
        isEnabled: c.status !== 'NOT_CONFIGURED',
        config: { mode: c.status === 'MOCK' ? 'mock' : 'unconfigured' },
        lastSyncAt: c.status === 'MOCK' ? hoursAgo(int(1, 20)) : null,
        lastSyncStatus: c.status === 'MOCK' ? 'ok' : null,
        webhookUrl: ['TWILIO_SMS', 'META_ADS', 'CYS'].includes(c.kind) ? `https://prodigyflo.ai/api/webhooks/${c.kind.toLowerCase()}` : null,
      },
    })
    await db.connectorLog.createMany({
      data: Array.from({ length: 3 }, (_, i) => ({
        connectorId: conn.id,
        level: i === 2 && c.kind === 'META_ADS' ? 'warn' : 'info',
        event: i === 2 && c.kind === 'META_ADS' ? 'sync.partial' : 'sync.completed',
        detail: { records: int(4, 90), durationMs: int(120, 2400) },
        createdAt: hoursAgo(i * 8 + 1),
      })),
    })
  }

  // ── clients ────────────────────────────────────────────────
  console.log('→ clients')
  // Distribution across the lifecycle, weighted toward the middle of the funnel.
  const distribution: [StageKey, number][] = [
    [StageKey.NEW_LEAD, 22],
    [StageKey.SURVEY_STARTED, 14],
    [StageKey.SURVEY_COMPLETED, 12],
    [StageKey.INFO_VERIFICATION, 11],
    [StageKey.CONSENT_PENDING, 9],
    [StageKey.CREDIT_PULL_PENDING, 7],
    [StageKey.CREDIT_PULL_COMPLETED, 8],
    [StageKey.QUALIFICATION_REVIEW, 10],
    [StageKey.QUALIFIED, 8],
    [StageKey.NOT_QUALIFIED, 12],
    [StageKey.APPOINTMENT_SCHEDULING, 7],
    [StageKey.APPOINTMENT_SCHEDULED, 9],
    [StageKey.PRESENTATION_COMPLETED, 8],
    [StageKey.FOLLOW_UP, 11],
    [StageKey.PAYMENT_SELECTION, 6],
    [StageKey.DOCUMENT_COLLECTION, 10],
    [StageKey.COMMUNICATION_EVIDENCE_REVIEW, 5],
    [StageKey.ATTORNEY_DOCUMENT_REVIEW, 5],
    [StageKey.DEAL_READY_FOR_SUBMISSION, 4],
    [StageKey.SUBMITTED, 6],
    [StageKey.CORRECTIONS_REQUESTED, 4],
    [StageKey.APPROVED, 5],
    [StageKey.CLOSED_WON, 24],
    [StageKey.CLOSED_LOST, 26],
    [StageKey.ON_HOLD, 7],
  ]

  const stageOrder = new Map(DEFAULT_STAGES.map((s) => [s.key, s.position]))
  const reached = (current: StageKey, target: StageKey) => {
    // Terminal "won" paths have passed through everything.
    if (current === StageKey.CLOSED_WON || current === StageKey.APPROVED) return true
    const c = stageOrder.get(current) ?? 0
    const t = stageOrder.get(target) ?? 0
    if (current === StageKey.NOT_QUALIFIED) return t <= (stageOrder.get(StageKey.QUALIFICATION_REVIEW) ?? 0)
    if (current === StageKey.CLOSED_LOST || current === StageKey.ON_HOLD) return t <= int(6, 18)
    return c >= t
  }

  let clientCount = 0
  const seededClientIds: string[] = []
  const totals = { won: 0, lost: 0 }

  for (const [stageKey, count] of distribution) {
    for (let n = 0; n < count; n++) {
      const region = pick(regions)
      const regionTeams = teams.filter((t) => t.regionId === region.id)
      const team = pick(regionTeams)
      const teamClosers = closers.filter((c) => c.teamId === team.id)
      const closer = pick(teamClosers)
      const [city, state] = pick(CITIES[region.code])
      const first = pick(FIRST)
      const last = pick(LAST)
      const source = pick(leadSources)
      const campaign = campaigns.find((c) => c.leadSourceId === source.id) ?? null
      const spanish = chance(0.35)

      const ageDays = int(2, 150)
      const createdAt = daysAgo(ageDays)
      const stageEnteredAt = daysAgo(Math.max(0, int(0, Math.min(ageDays, 20))))
      const assignsCloser = reached(stageKey, StageKey.QUALIFIED)
      const value = int(3200, 14500)

      const client = await db.client.create({
        data: {
          organizationId: org.id,
          pipelineId: pipeline.id,
          currentStageId: stageId.get(stageKey)!,
          regionId: region.id,
          teamId: assignsCloser ? team.id : null,
          ownerId: assignsCloser ? closer.id : null,
          firstName: first,
          lastName: last,
          email: `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@example.com`,
          phone: `+1 555 ${int(1000, 9999)}`,
          preferredLanguage: spanish ? 'es' : 'en',
          preferredContact: pick(['phone', 'email', 'text']),
          status:
            stageKey === StageKey.CLOSED_WON ? ClientStatus.CLOSED_WON
              : stageKey === StageKey.CLOSED_LOST ? ClientStatus.CLOSED_LOST
              : stageKey === StageKey.NOT_QUALIFIED ? ClientStatus.DISQUALIFIED
              : stageKey === StageKey.ON_HOLD ? ClientStatus.ON_HOLD
              : ClientStatus.ACTIVE,
          leadSourceId: source.id,
          campaignId: campaign?.id ?? null,
          utmSource: source.key,
          utmMedium: source.channel,
          utmCampaign: campaign?.utmCampaign ?? null,
          estimatedValue: value,
          probability:
            stageKey === StageKey.CLOSED_WON ? 100
              : stageKey === StageKey.CLOSED_LOST || stageKey === StageKey.NOT_QUALIFIED ? 0
              : Math.min(95, 8 + (stageOrder.get(stageKey) ?? 0) * 4),
          expectedCloseAt: daysAhead(int(5, 60)),
          lostReason: stageKey === StageKey.CLOSED_LOST ? pick(LOST_REASONS) : null,
          holdReason: stageKey === StageKey.ON_HOLD ? pick(HOLD_REASONS) : null,
          disqualifiedReason: stageKey === StageKey.NOT_QUALIFIED ? pick(DQ_REASONS) : null,
          stageEnteredAt,
          firstContactAt: reached(stageKey, StageKey.SURVEY_STARTED) ? daysAgo(ageDays - 1) : null,
          lastActivityAt: daysAgo(int(0, 6)),
          createdAt,
        },
      })
      clientCount++
      seededClientIds.push(client.id)
      if (stageKey === StageKey.CLOSED_WON) totals.won++
      if (stageKey === StageKey.CLOSED_LOST) totals.lost++

      await db.clientAddress.create({
        data: {
          clientId: client.id,
          line1: `${int(100, 9899)} ${pick(STREETS)} ${pick(['Ct', 'Way', 'Ln', 'Dr'])}`,
          city,
          state,
          postalCode: String(int(10000, 99999)),
        },
      })

      // Attribution: first + last touch
      await db.attributionEvent.createMany({
        data: [
          {
            clientId: client.id,
            campaignId: campaign?.id ?? null,
            leadSourceId: source.id,
            touch: AttributionTouch.FIRST,
            channel: source.channel,
            utmSource: source.key,
            utmMedium: source.channel,
            utmCampaign: campaign?.utmCampaign ?? null,
            landingPath: '/survey',
            occurredAt: createdAt,
          },
          {
            clientId: client.id,
            campaignId: campaign?.id ?? null,
            leadSourceId: source.id,
            touch: AttributionTouch.LAST,
            channel: source.channel,
            utmSource: source.key,
            landingPath: '/survey',
            occurredAt: new Date(createdAt.getTime() + 3_600_000),
          },
        ],
      })

      // Stage history along the path travelled
      const path = DEFAULT_STAGES.filter((s) => reached(stageKey, s.key)).sort((a, b) => a.position - b.position)
      let cursor = createdAt.getTime()
      let prev: StageKey | null = null
      for (const s of path) {
        const dwell = int(2, 72) * 3_600_000
        await db.stageHistory.create({
          data: {
            clientId: client.id,
            stageId: stageId.get(s.key)!,
            fromKey: prev,
            toKey: s.key,
            enteredAt: new Date(cursor),
            exitedAt: s.key === stageKey ? null : new Date(cursor + dwell),
            durationMinutes: s.key === stageKey ? null : Math.round(dwell / 60000),
            changedById: assignsCloser ? closer.id : admin.id,
            automated: chance(0.25),
          },
        })
        cursor += dwell
        prev = s.key
      }

      // Survey
      if (reached(stageKey, StageKey.SURVEY_STARTED)) {
        const done = reached(stageKey, StageKey.SURVEY_COMPLETED)
        await db.surveyResponse.create({
          data: {
            surveyId: survey.id,
            clientId: client.id,
            status: done ? SurveyStatus.COMPLETED : SurveyStatus.IN_PROGRESS,
            currentStep: done ? 5 : int(1, 4),
            answers: {
              firstName: first,
              lastName: last,
              email: client.email,
              phone: client.phone,
              preferredLanguage: spanish ? 'es' : 'en',
              city,
              state,
              counterparty: pick(['Helios Home Energy', 'Brightline Residential', 'Vantage Solar Partners', 'Cardinal Home Systems']),
              monthlyAmount: int(120, 420),
              termMonths: pick([180, 240, 300]),
              signedYear: int(2016, 2024),
              employmentStatus: pick(['employed', 'self-employed', 'retired']),
              householdIncome: int(48_000, 165_000),
              monthlyObligations: int(400, 2600),
              availability: [pick(['weekday mornings', 'weekday evenings', 'weekends'])],
              primaryConcern: pick(['Payment keeps going up', 'Was told something different at the door', 'Trying to sell the house', 'Cannot reach the company']),
            },
            startedAt: daysAgo(ageDays - 1),
            completedAt: done ? daysAgo(Math.max(0, ageDays - 2)) : null,
          },
        })
      }

      // Contract (from survey answers)
      if (reached(stageKey, StageKey.SURVEY_COMPLETED) && chance(0.85)) {
        await db.contract.create({
          data: {
            clientId: client.id,
            counterparty: pick(['Helios Home Energy', 'Brightline Residential', 'Vantage Solar Partners', 'Cardinal Home Systems']),
            productType: pick(['lease', 'PPA', 'loan']),
            signedAt: daysAgo(int(400, 2800)),
            termMonths: pick([180, 240, 300]),
            monthlyAmount: int(120, 420),
            escalatorPct: pick([0, 1.9, 2.9, 3.5]),
            extractionSource: chance(0.5) ? 'ai' : 'manual',
          },
        })
      }

      // Verifications
      if (reached(stageKey, StageKey.INFO_VERIFICATION)) {
        for (const t of [VerificationType.EMAIL, VerificationType.PHONE, VerificationType.IDENTITY]) {
          const verified = t === VerificationType.IDENTITY ? chance(0.7) : chance(0.92)
          await db.verification.create({
            data: {
              clientId: client.id,
              type: t,
              status: verified ? VerificationStatus.VERIFIED : VerificationStatus.PENDING,
              maskedValue: t === VerificationType.EMAIL ? client.email.replace(/^(..).*@/, '$1•••@') : `•••-•••-${client.phone.slice(-4)}`,
              method: t === VerificationType.IDENTITY ? 'document_review' : 'one_time_code',
              verifiedAt: verified ? daysAgo(int(1, 20)) : null,
            },
          })
        }
      }

      // Consent — always precedes any credit activity
      if (reached(stageKey, StageKey.CONSENT_PENDING)) {
        const consentDefs: [ConsentType, string][] = [
          [ConsentType.SOFT_CREDIT_PULL, 'Determine eligibility for the services requested by the consumer'],
          [ConsentType.TCPA_CONTACT, 'Contact the consumer about their active file'],
          [ConsentType.ESIGN_DISCLOSURE, 'Deliver and execute documents electronically'],
          [ConsentType.PRIVACY_POLICY, 'Acknowledge the privacy notice'],
        ]
        for (const [type, purpose] of consentDefs) {
          await db.consent.create({
            data: {
              clientId: client.id,
              type,
              granted: true,
              textVersion: 'v1.2.0',
              text: `I authorize Meridian Client Solutions to ${purpose.toLowerCase()}. I understand I may withdraw this consent at any time.`,
              purpose,
              ipHash: 'seeded',
              userAgent: 'seed',
              grantedAt: daysAgo(int(2, 40)),
            },
          })
        }
      }

      // Credit pull
      if (reached(stageKey, StageKey.CREDIT_PULL_PENDING)) {
        const done = reached(stageKey, StageKey.CREDIT_PULL_COMPLETED)
        await db.creditPull.create({
          data: {
            clientId: client.id,
            provider: 'mock',
            status: done ? CreditPullStatus.COMPLETED : CreditPullStatus.PENDING,
            permissiblePurpose: 'Written instructions of the consumer',
            scoreBand: done ? pick(['540-579', '580-619', '620-659', '660-699', '700-739', '740-799']) : null,
            scoreRangeLow: done ? int(540, 740) : null,
            scoreRangeHigh: done ? int(741, 800) : null,
            tradelines: done ? int(3, 18) : null,
            derogatoryMarks: done ? int(0, 4) : null,
            utilizationPct: done ? int(4, 92) : null,
            monthlyObligations: done ? int(400, 2600) : null,
            externalRef: done ? `MOCK-${int(100000, 999999)}` : null,
            requestedAt: daysAgo(int(3, 30)),
            completedAt: done ? daysAgo(int(1, 25)) : null,
            expiresAt: done ? daysAhead(60) : null,
          },
        })
      }

      // Qualification review — always human-decided
      if (reached(stageKey, StageKey.QUALIFICATION_REVIEW)) {
        const decided = stageKey !== StageKey.QUALIFICATION_REVIEW
        const outcome = !decided
          ? QualificationOutcome.PENDING
          : stageKey === StageKey.NOT_QUALIFIED
            ? QualificationOutcome.NOT_QUALIFIED
            : QualificationOutcome.QUALIFIED
        const aiOutcome = chance(0.85) ? outcome : QualificationOutcome.NEEDS_MORE_INFO
        const reviewer = pick([admin, ...regionalManagers])
        await db.qualificationReview.create({
          data: {
            clientId: client.id,
            outcome,
            reviewerId: decided ? reviewer.id : null,
            reviewedAt: decided ? daysAgo(int(1, 25)) : null,
            aiRecommendedOutcome: aiOutcome,
            aiConfidence: int(58, 94),
            aiReasons: [
              { source: 'survey', text: 'Reported monthly obligation is consistent with the uploaded contract.' },
              { source: 'credit', text: 'Score band falls inside the configured eligibility range.' },
            ],
            missingEvidence: chance(0.3) ? [{ key: 'proof_income', label: 'Proof of income not yet received' }] : [],
            rulesEvaluated: [
              { rule: 'service_area', result: 'pass' },
              { rule: 'affordability_ratio', result: chance(0.85) ? 'pass' : 'fail' },
              { rule: 'contract_on_file', result: 'pass' },
            ],
            overrideReason: decided && aiOutcome !== outcome ? 'Reviewer confirmed missing evidence was supplied by phone.' : null,
            decisionNotes: decided ? 'Reviewed contract, credit summary, and survey answers.' : null,
          },
        })
      }

      // Assignment + AI designator record
      if (assignsCloser) {
        const aiRec = await db.aIRecommendation.create({
          data: {
            clientId: client.id,
            type: 'CLOSER_ASSIGNMENT',
            status: chance(0.8) ? 'ACCEPTED' : 'OVERRIDDEN',
            provider: 'mock',
            summary: `Recommended ${closer.name} for this client.`,
            facts: [
              { label: 'Region', value: region.name, source: 'client.region' },
              { label: 'Language', value: spanish ? 'Spanish' : 'English', source: 'client.preferredLanguage' },
            ],
            inferences: [{ label: 'Fit', value: 'Strong match on language and territory' }],
            recommendation: { closerId: closer.id, closerName: closer.name },
            confidence: int(62, 93),
            reasons: [
              { factor: 'region', detail: `Licensed in ${region.name}` },
              { factor: 'language', detail: spanish ? 'Speaks Spanish' : 'Language match' },
              { factor: 'workload', detail: 'Below workload cap' },
              { factor: 'close_rate', detail: `Historical close rate ${int(18, 44)}%` },
            ],
            reviewedById: admin.id,
            reviewedAt: daysAgo(int(1, 20)),
          },
        })
        await db.assignment.create({
          data: {
            clientId: client.id,
            assigneeId: closer.id,
            assignedById: admin.id,
            role: RoleKey.CLOSER,
            isActive: true,
            reason: 'Region, language, and workload match',
            aiRecommendationId: aiRec.id,
            wasOverride: aiRec.status === 'OVERRIDDEN',
            overrideReason: aiRec.status === 'OVERRIDDEN' ? 'Manager reassigned for territory balance.' : null,
            assignedAt: daysAgo(int(1, 30)),
          },
        })
      }

      // Onboarding analysis
      if (reached(stageKey, StageKey.SURVEY_COMPLETED) && chance(0.7)) {
        await db.aIRecommendation.create({
          data: {
            clientId: client.id,
            type: 'ONBOARDING_ANALYSIS',
            status: 'PENDING_REVIEW',
            provider: 'mock',
            summary: `${first} ${last} reports a ${pick(['lease', 'PPA', 'loan'])} with a rising monthly payment and wants a clear exit path.`,
            facts: [
              { label: 'Monthly payment', value: `$${int(120, 420)}`, source: 'survey.monthlyAmount' },
              { label: 'Term', value: `${pick([180, 240, 300])} months`, source: 'survey.termMonths' },
            ],
            inferences: [
              { label: 'Urgency', value: 'Moderate — no hard deadline stated' },
              { label: 'Decision maker', value: 'Likely joint with spouse' },
            ],
            recommendation: { nextBestAction: 'Confirm identity documents before the presentation' },
            confidence: int(55, 90),
            missingInformation: chance(0.5) ? [{ key: 'proof_income', label: 'Proof of income' }] : [],
            complianceFlags: chance(0.15) ? [{ level: 'review', text: 'Client reports the sale was conducted in Spanish; confirm document language matches.' }] : [],
          },
        })
      }

      // Appointments & presentation
      if (reached(stageKey, StageKey.APPOINTMENT_SCHEDULED)) {
        const past = reached(stageKey, StageKey.PRESENTATION_COMPLETED)
        const appt = await db.appointment.create({
          data: {
            clientId: client.id,
            ownerId: closer.id,
            type: AppointmentType.PRESENTATION,
            status: past
              ? chance(0.85) ? AppointmentStatus.COMPLETED : AppointmentStatus.NO_SHOW
              : AppointmentStatus.CONFIRMED,
            startsAt: past ? daysAgo(int(1, 30)) : daysAhead(int(0, 12)),
            endsAt: past ? daysAgo(int(1, 30)) : daysAhead(int(0, 12)),
            timezone: region.timezone,
            location: chance(0.5) ? 'Client residence' : null,
            meetingUrl: chance(0.5) ? 'https://meet.example.com/mock-room' : null,
            confirmedAt: daysAgo(int(1, 20)),
            outcome: past ? pick(['Presented — considering', 'Presented — moving forward', 'No show']) : null,
            noShowRecordedAt: past && chance(0.15) ? daysAgo(int(1, 20)) : null,
            prepBrief: past ? { headline: "Rising payment, wants clarity on exit options", watchFor: ["Spouse must be present"] } : undefined,
          },
        })
        if (past && chance(0.85)) {
          await db.presentation.create({
            data: {
              clientId: client.id,
              appointmentId: appt.id,
              presenterId: closer.id,
              completedAt: daysAgo(int(1, 28)),
              checklist: [
                { key: 'contract_reviewed', label: 'Contract reviewed with client', done: true },
                { key: 'fees_disclosed', label: 'Fees disclosed in writing', done: true },
                { key: 'timeline_explained', label: 'Timeline explained', done: chance(0.8) },
              ],
              notes: 'Walked through the current agreement and the proposed path.',
              objections: chance(0.6) ? [{ text: pick(OBJECTIONS) }] : [],
              followUpAt: daysAhead(int(1, 10)),
            },
          })
        }
      }

      // Payment & financing
      if (reached(stageKey, StageKey.PAYMENT_SELECTION)) {
        const path = pick([PaymentPath.CARD, PaymentPath.ACH, PaymentPath.FINANCING, PaymentPath.CASH])
        const won = stageKey === StageKey.CLOSED_WON
        await db.paymentMethod.create({
          data: {
            clientId: client.id,
            path,
            status: won ? PaymentStatus.PAID_IN_FULL : chance(0.5) ? PaymentStatus.DEPOSIT_PAID : PaymentStatus.PENDING,
            provider: 'mock',
            providerToken: `tok_mock_${int(100000, 999999)}`,
            brand: path === PaymentPath.CARD ? pick(['visa', 'mastercard']) : null,
            last4: String(int(1000, 9999)),
            amount: value,
            depositAmount: Math.round(value * 0.25),
            receiptRef: won ? `RCPT-${int(10000, 99999)}` : null,
            selectedAt: daysAgo(int(1, 25)),
            paidAt: won ? daysAgo(int(1, 20)) : null,
          },
        })
        if (path === PaymentPath.FINANCING) {
          await db.financingApplication.create({
            data: {
              clientId: client.id,
              provider: 'mock',
              status: won ? FinancingStatus.APPROVED : pick([FinancingStatus.PENDING, FinancingStatus.APPROVED, FinancingStatus.ADDITIONAL_INFO_REQUIRED, FinancingStatus.DECLINED]),
              requestedAmount: value,
              approvedAmount: won ? value : null,
              termMonths: pick([24, 36, 48]),
              aprPct: pick([9.99, 12.99, 15.99]),
              monthlyPayment: Math.round(value / 36),
              externalRef: `FIN-${int(100000, 999999)}`,
              submittedAt: daysAgo(int(2, 25)),
              decisionAt: won ? daysAgo(int(1, 20)) : null,
              additionalInfoRequested: chance(0.2) ? [{ key: 'paystub', label: 'Most recent pay stub' }] : [],
            },
          })
        }
      }

      // Documents
      if (reached(stageKey, StageKey.DOCUMENT_COLLECTION)) {
        const collector = chance(0.4) ? pick(collectors) : null
        const complete = reached(stageKey, StageKey.DEAL_READY_FOR_SUBMISSION)
        for (const req of requirements) {
          const received = complete || chance(0.6)
          const status = complete
            ? DocumentStatus.APPROVED
            : received
              ? pick([DocumentStatus.RECEIVED, DocumentStatus.UNDER_REVIEW, DocumentStatus.APPROVED, DocumentStatus.REJECTED])
              : DocumentStatus.REQUESTED
          const stored = received
            ? storeDemoDocument(
                client.id,
                req.key,
                [
                  req.name.toUpperCase(),
                  '',
                  `Provided by: ${client.firstName} ${client.lastName}`,
                  `Document type: ${req.category}`,
                  `Reference: ${req.key.toUpperCase()}-${client.id.slice(-6)}`,
                  '',
                  'Synthetic demo document. No real personal or financial data.',
                  '',
                ].join('\n'),
              )
            : null
          const doc = await db.clientDocument.create({
            data: {
              clientId: client.id,
              requirementId: req.id,
              collectorId: collector?.id ?? null,
              status,
              fileName: stored ? `${req.key}.txt` : null,
              storageKey: stored?.key ?? null,
              mimeType: stored ? 'text/plain' : null,
              sizeBytes: stored?.sizeBytes ?? null,
              checksum: stored?.checksum ?? null,
              scanStatus: received ? 'clean' : 'pending',
              rejectionReason: status === DocumentStatus.REJECTED ? pick(['Image is unreadable', 'Wrong document supplied', 'Expired document']) : null,
              requestedAt: daysAgo(int(3, 30)),
              receivedAt: received ? daysAgo(int(1, 20)) : null,
              slaDueAt: daysAhead(int(-3, 7)),
              expiresAt: req.expiresAfterDays ? daysAhead(200) : null,
            },
          })
          if (status === DocumentStatus.APPROVED || status === DocumentStatus.REJECTED) {
            await db.documentReview.create({
              data: {
                documentId: doc.id,
                reviewerId: admin.id,
                decision: status,
                reason: status === DocumentStatus.REJECTED ? 'Rejected on first review' : null,
                reviewedAt: daysAgo(int(1, 18)),
              },
            })
          }
        }
      }

      // Deal + submission
      if (reached(stageKey, StageKey.DEAL_READY_FOR_SUBMISSION)) {
        const won = stageKey === StageKey.CLOSED_WON
        const deal = await db.deal.create({
          data: {
            clientId: client.id,
            status: won ? DealStatus.WON : DealStatus.OPEN,
            value,
            probability: won ? 100 : int(55, 90),
            expectedCloseAt: daysAhead(int(3, 40)),
            wonAt: won ? daysAgo(int(1, 25)) : null,
          },
        })
        if (reached(stageKey, StageKey.SUBMITTED)) {
          const subStatus =
            stageKey === StageKey.CORRECTIONS_REQUESTED ? SubmissionStatus.CORRECTIONS_REQUESTED
              : stageKey === StageKey.SUBMITTED ? SubmissionStatus.SUBMITTED
              : SubmissionStatus.APPROVED
          await db.submission.create({
            data: {
              clientId: client.id,
              dealId: deal.id,
              destination: chance(0.7) ? SubmissionDestination.CYS : SubmissionDestination.ATTORNEY,
              status: subStatus,
              externalRef: `SUB-${int(100000, 999999)}`,
              packageManifest: requirements.map((r) => ({ key: r.key, name: r.name, included: true })),
              validationReport: { requiredDocuments: 'pass', communicationEvidence: 'pass', requiredFields: 'pass' },
              approvedById: admin.id,
              approvedAt: daysAgo(int(2, 20)),
              submittedAt: daysAgo(int(1, 18)),
              acknowledgedAt: subStatus !== SubmissionStatus.SUBMITTED ? daysAgo(int(1, 12)) : null,
              correctionsRequested: subStatus === SubmissionStatus.CORRECTIONS_REQUESTED
                ? [{ key: 'attorney_poa', reason: 'Signature page missing' }]
                : [],
              correctionsRequestedAt: subStatus === SubmissionStatus.CORRECTIONS_REQUESTED ? daysAgo(int(1, 10)) : null,
            },
          })
        }
      }

      // Communications
      const commCount = int(2, 9)
      for (let ci = 0; ci < commCount; ci++) {
        const channel = pick([
          CommunicationChannel.CALL,
          CommunicationChannel.SMS,
          CommunicationChannel.EMAIL,
          CommunicationChannel.PORTAL_MESSAGE,
        ])
        const outbound = chance(0.6)
        const comm = await db.communication.create({
          data: {
            clientId: client.id,
            userId: assignsCloser ? closer.id : admin.id,
            channel,
            direction: outbound ? CommunicationDirection.OUTBOUND : CommunicationDirection.INBOUND,
            status: outbound ? pick([CommunicationStatus.DELIVERED, CommunicationStatus.SENT, CommunicationStatus.FAILED]) : CommunicationStatus.RECEIVED,
            subject: channel === CommunicationChannel.EMAIL ? pick(['Your file update', 'Documents needed', 'Appointment confirmation']) : null,
            body: channel === CommunicationChannel.CALL
              ? null
              : pick([
                  'Hi — checking in on the documents we discussed.',
                  'Confirming our appointment for this week.',
                  'Thanks, I uploaded the file you asked for.',
                  'Can we move the call to the afternoon?',
                ]),
            occurredAt: daysAgo(int(0, Math.min(ageDays, 45))),
          },
        })
        if (channel === CommunicationChannel.CALL) {
          const outcome = pick([CallOutcome.CONNECTED, CallOutcome.VOICEMAIL, CallOutcome.NO_ANSWER, CallOutcome.BUSY])
          await db.call.create({
            data: {
              communicationId: comm.id,
              fromMasked: '•••-•••-0100',
              toMasked: `•••-•••-${client.phone.slice(-4)}`,
              durationSeconds: outcome === CallOutcome.CONNECTED ? int(45, 1400) : int(0, 30),
              outcome,
              recordingRef: outcome === CallOutcome.CONNECTED && chance(0.6) ? `rec_${int(100000, 999999)}` : null,
              voicemailLeft: outcome === CallOutcome.VOICEMAIL,
            },
          })
        } else if (channel === CommunicationChannel.SMS || channel === CommunicationChannel.EMAIL) {
          await db.message.create({
            data: {
              communicationId: comm.id,
              fromMasked: outbound ? 'meridian' : `•••-•••-${client.phone.slice(-4)}`,
              toMasked: outbound ? `•••-•••-${client.phone.slice(-4)}` : 'meridian',
              deliveredAt: comm.status === CommunicationStatus.FAILED ? null : comm.occurredAt,
              failureCode: comm.status === CommunicationStatus.FAILED ? pick(['30003', '30005']) : null,
              optOutDetected: chance(0.03),
            },
          })
        }
      }

      // Tasks & notes
      if (!DEFAULT_STAGES.find((s) => s.key === stageKey)?.isTerminal) {
        const taskCount = int(1, 3)
        for (let t = 0; t < taskCount; t++) {
          const overdue = chance(0.3)
          await db.task.create({
            data: {
              clientId: client.id,
              assigneeId: assignsCloser ? closer.id : admin.id,
              createdById: admin.id,
              title: pick(['Call to confirm appointment', 'Chase missing document', 'Review contract terms', 'Send follow-up summary', 'Verify identity document']),
              status: chance(0.35) ? TaskStatus.COMPLETED : TaskStatus.OPEN,
              priority: pick([TaskPriority.LOW, TaskPriority.NORMAL, TaskPriority.HIGH, TaskPriority.URGENT]),
              dueAt: overdue ? daysAgo(int(1, 8)) : daysAhead(int(0, 10)),
              stageKey,
            },
          })
        }
      }
      if (chance(0.6)) {
        await db.note.create({
          data: {
            clientId: client.id,
            authorId: assignsCloser ? closer.id : admin.id,
            body: pick([
              'Spouse handles the paperwork — loop them in on every call.',
              'Best reached after 6pm local time.',
              'Original sales conversation happened in Spanish.',
              'Client is comparing us against another provider.',
            ]),
            isInternal: true,
            pinned: chance(0.2),
          },
        })
      }
    }
  }

  // ── one fully-wired portal client ──────────────────────────
  console.log('→ demo portal client')
  const portalClient = await db.client.findFirst({
    where: { organizationId: org.id, currentStage: { key: StageKey.DOCUMENT_COLLECTION } },
  })
  if (portalClient) {
    const portalUser = await mkUser({
      roleId: roleId.get('CLIENT'),
      email: 'client@prodigyflo.ai',
      name: `${portalClient.firstName} ${portalClient.lastName}`,
      title: 'Client',
      phone: portalClient.phone,
    })
    await db.client.update({
      where: { id: portalClient.id },
      data: { portalUserId: portalUser.id },
    })
  }

  // ── notifications ──────────────────────────────────────────
  const someClosers = closers.slice(0, 6)
  for (const c of someClosers) {
    await db.notification.createMany({
      data: [
        { organizationId: org.id, userId: c.id, kind: 'ASSIGNMENT', title: 'New client assigned', body: 'A qualified client was routed to you.', href: '/clients' },
        { organizationId: org.id, userId: c.id, kind: 'SLA_WARNING', title: 'Stage aging', body: 'A client has been in Follow-up past the SLA.', href: '/board' },
      ],
    })
  }

  // ── slice seeds ────────────────────────────────────────────
  // Each P0 slice owns its own starter data; the context below is the only
  // contract between them and this file.
  const seedCtx = {
    organizationId: org.id,
    users: (await db.user.findMany({
      where: { organizationId: org.id },
      select: { id: true, email: true, role: { select: { key: true } } },
    })).map((u) => ({ id: u.id, email: u.email, role: u.role.key as string })),
    clientIds: seededClientIds,
  }

  // seedMessaging / seedOutreach / seedCys already ran inside
  // bootstrapOrganization — before any user existed, so template authorship
  // landed null. Stamp the demo admin as author to keep the demo dataset
  // exactly as it was when those seeds ran with a populated users context.
  await db.messageTemplate.updateMany({
    where: { organizationId: org.id, createdById: null },
    data: { createdById: admin.id },
  })

  await seedIntake(db, seedCtx)
  await seedAutomation(db, seedCtx)
  await seedOps(db, seedCtx)
  await seedPortal(db, seedCtx)
  await seedCloseops(db, seedCtx)
  await seedDocuments(db, seedCtx)

  // ── audit trail ────────────────────────────────────────────
  await db.auditEvent.createMany({
    data: [
      { organizationId: org.id, actorId: superAdmin.id, actorLabel: 'Avery Sloane (Super Admin)', action: 'organization.created', entityType: 'Organization', entityId: org.id, summary: 'Organization provisioned' },
      { organizationId: org.id, actorId: admin.id, actorLabel: 'Beatriz Ocampo (Admin / Operations)', action: 'pipeline.configured', entityType: 'Pipeline', entityId: pipeline.id, summary: '25 lifecycle stages seeded' },
      { organizationId: org.id, actorId: admin.id, actorLabel: 'Beatriz Ocampo (Admin / Operations)', action: 'documents.package_configured', entityType: 'DocumentPackage', entityId: docPackage.id, summary: '8 requirements, 4 attorney-required' },
    ],
  })

  console.log(`✓ seeded ${clientCount} clients (${totals.won} won, ${totals.lost} lost)`)
  console.log('\nDemo accounts — password for all: Demo!2345')
  console.log('  super@prodigyflo.ai       Super Admin')
  console.log('  admin@prodigyflo.ai       Admin / Operations')
  console.log('  rm.west@prodigyflo.ai     Regional Manager')
  console.log('  sm.west1@prodigyflo.ai    Sales Manager')
  console.log(`  ${(await db.user.findFirst({ where: { role: { key: 'CLOSER' } } }))?.email}  Closer`)
  console.log('  collector1@prodigyflo.ai  Document Collector')
  console.log('  marketing@prodigyflo.ai   Marketing')
  console.log('  client@prodigyflo.ai      Client portal')
  console.log(`
Demo intake webhook secret: ${DEMO_INTAKE_SECRET}`)
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e)
    await db.$disconnect()
    process.exit(1)
  })
