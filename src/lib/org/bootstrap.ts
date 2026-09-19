/**
 * Organization bootstrap — the single definition of "a working, empty account".
 *
 * Extracted from prisma/seed.ts so the same structure ships to every new
 * organization: the global permission catalog, the 2 staff roles with their
 * permission grants, the default 25-stage pipeline, the client intake survey,
 * the standard submission package with its 8 requirements, the 5 starter lead
 * sources, and the starter content seeds (message templates, outreach
 * templates, CYS field map).
 *
 * Callable from BOTH prisma scripts (tsx, no Next runtime) and server actions,
 * so it deliberately has no `server-only` import and takes the Prisma client
 * as an argument. Every step is idempotent (upsert / skip-if-exists): calling
 * it twice, or calling it on an organization that already exists, changes
 * nothing that an admin may have customized (stages, requirements, sources are
 * create-only after the first run).
 *
 * Deliberately NOT bootstrapped: regions, sequences, demo campaigns —
 * those are demo-optional and stay in prisma/seed.ts.
 */
import { DocumentCategory, type PrismaClient, type Prisma, type RoleKey } from '@prisma/client'
import { seedMessaging } from '../../../prisma/seeds/messaging'
import { seedOutreach } from '../../../prisma/seeds/outreach'
import { seedCys } from '../../../prisma/seeds/cys'
import { DEFAULT_STAGES } from '../pipeline'
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, STAFF_ROLES } from '../permissions'
import { defaultBillingMode } from '../telephony/billing-mode'

export type OrganizationKind = 'AGENCY' | 'CLIENT'

export type BootstrapOrganizationOptions = {
  name: string
  slug: string
  /** Defaults to CLIENT — AGENCY is reserved for the master account. */
  kind?: OrganizationKind
  /** The owning agency for CLIENT accounts; null for standalone/master orgs. */
  parentOrganizationId?: string | null
  timezone?: string
  settings?: Prisma.InputJsonValue
}

export type BootstrapOrganizationResult = {
  organizationId: string
  roleIdByKey: Map<RoleKey, string>
}

/** The 5 starter lead sources, in seed order (order matters to the demo seed's RNG). */
export const LEAD_SOURCE_DEFS = [
  { key: 'meta_ads', name: 'Meta Lead Ads', channel: 'paid_social' },
  { key: 'google_search', name: 'Google Search', channel: 'paid_search' },
  { key: 'referral', name: 'Client Referral', channel: 'referral' },
  { key: 'door_knock', name: 'Field Canvassing', channel: 'field' },
  { key: 'organic', name: 'Organic / Direct', channel: 'organic' },
] as const

export const INTAKE_SURVEY_NAME = 'Client Intake Survey'

/** Intake survey definition — moved verbatim from prisma/seed.ts. */
const INTAKE_SURVEY_SCHEMA = [
  {
    key: 'contact',
    title: 'How can we reach you?',
    description: 'We use this only to contact you about your file.',
    fields: [
      { key: 'firstName', label: 'First name', type: 'text', required: true },
      { key: 'lastName', label: 'Last name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'phone', label: 'Mobile phone', type: 'tel', required: true },
      { key: 'preferredContact', label: 'Preferred contact method', type: 'select', required: true, options: ['phone', 'email', 'text'] },
      { key: 'preferredLanguage', label: 'Preferred language', type: 'select', required: true, options: ['en', 'es'] },
    ],
  },
  {
    key: 'address',
    title: 'Where is the property?',
    fields: [
      { key: 'line1', label: 'Street address', type: 'text', required: true },
      { key: 'line2', label: 'Apt / unit', type: 'text', required: false },
      { key: 'city', label: 'City', type: 'text', required: true },
      { key: 'state', label: 'State', type: 'text', required: true },
      { key: 'postalCode', label: 'ZIP code', type: 'text', required: true },
      { key: 'yearsAtAddress', label: 'Years at this address', type: 'number', required: false },
    ],
  },
  {
    key: 'situation',
    title: 'Tell us about your current agreement',
    fields: [
      { key: 'counterparty', label: 'Who is the agreement with?', type: 'text', required: true },
      { key: 'monthlyAmount', label: 'Current monthly payment', type: 'number', required: true },
      { key: 'termMonths', label: 'Length of the agreement (months)', type: 'number', required: false },
      { key: 'signedYear', label: 'Year signed', type: 'number', required: false },
      { key: 'primaryConcern', label: 'What concerns you most?', type: 'textarea', required: false },
    ],
  },
  {
    key: 'finances',
    title: 'A few financial details',
    description: 'This helps us understand which options you qualify for. We never store full account numbers.',
    fields: [
      { key: 'employmentStatus', label: 'Employment status', type: 'select', required: true, options: ['employed', 'self-employed', 'retired', 'not working'] },
      { key: 'householdIncome', label: 'Approximate annual household income', type: 'number', required: true },
      { key: 'monthlyObligations', label: 'Approximate monthly debt payments', type: 'number', required: false },
      { key: 'financialGoal', label: 'What outcome are you hoping for?', type: 'textarea', required: false },
    ],
  },
  {
    key: 'availability',
    title: 'When should we call?',
    fields: [
      { key: 'availability', label: 'Best times to reach you', type: 'multiselect', required: true, options: ['weekday mornings', 'weekday afternoons', 'weekday evenings', 'weekends'] },
    ],
  },
  {
    key: 'consent',
    title: 'Your consent',
    description: 'Please read each item. You can withdraw consent at any time.',
    fields: [
      { key: 'consent_soft_credit', label: 'I authorize a soft credit inquiry, which does not affect my credit score.', type: 'consent', consentType: 'SOFT_CREDIT_PULL', required: true },
      { key: 'consent_contact', label: 'I agree to be contacted by phone, text, and email about my file.', type: 'consent', consentType: 'TCPA_CONTACT', required: true },
      { key: 'consent_esign', label: 'I agree to receive and sign documents electronically.', type: 'consent', consentType: 'ESIGN_DISCLOSURE', required: true },
      { key: 'consent_privacy', label: 'I have read the privacy notice.', type: 'consent', consentType: 'PRIVACY_POLICY', required: true },
    ],
  },
]

/** Standard submission package requirements — moved verbatim from prisma/seed.ts. */
const REQUIREMENT_DEFS = [
  { key: 'comm_evidence', name: 'Communication evidence export', category: DocumentCategory.COMMUNICATION_EVIDENCE, attorney: false },
  { key: 'signed_contract', name: 'Signed original contract', category: DocumentCategory.CONTRACT, attorney: false },
  { key: 'photo_id', name: 'Government photo ID', category: DocumentCategory.IDENTITY, attorney: false },
  { key: 'proof_income', name: 'Proof of income', category: DocumentCategory.INCOME, attorney: false },
  // The four attorney-required documents — configurable per organization.
  { key: 'attorney_retainer', name: 'Attorney retainer agreement', category: DocumentCategory.ATTORNEY_REQUIRED, attorney: true },
  { key: 'attorney_poa', name: 'Limited power of attorney', category: DocumentCategory.ATTORNEY_REQUIRED, attorney: true },
  { key: 'attorney_disclosure', name: 'Client disclosure acknowledgement', category: DocumentCategory.ATTORNEY_REQUIRED, attorney: true },
  { key: 'attorney_declaration', name: 'Signed client declaration', category: DocumentCategory.ATTORNEY_REQUIRED, attorney: true },
]

/**
 * Creates (or completes) an organization with the full default structure.
 * Idempotent: safe to re-run, safe to point at an existing organization slug.
 */
export async function bootstrapOrganization(
  db: PrismaClient,
  opts: BootstrapOrganizationOptions,
): Promise<BootstrapOrganizationResult> {
  // ── permission catalog (global, shared across orgs) ────────
  for (const [key, meta] of Object.entries(PERMISSIONS)) {
    await db.permission.upsert({
      where: { key },
      update: { description: meta.description, category: meta.category },
      create: { key, description: meta.description, category: meta.category },
    })
  }
  const permissionRows = await db.permission.findMany({ select: { id: true, key: true } })
  const permId = new Map(permissionRows.map((p) => [p.key, p.id]))

  // ── organization row (skip-if-exists by slug) ──────────────
  let org = await db.organization.findUnique({ where: { slug: opts.slug } })
  if (!org) {
    org = await db.organization.create({
      data: {
        name: opts.name,
        slug: opts.slug,
        kind: opts.kind ?? 'CLIENT',
        parentOrganizationId: opts.parentOrganizationId ?? null,
        timezone: opts.timezone ?? 'America/Los_Angeles',
        settings: opts.settings ?? {},
      },
    })
  }

  if (!await db.team.findFirst({ where: { organizationId: org.id, name: 'Team Prodigy' } })) {
    await db.team.create({ data: { organizationId: org.id, name: 'Team Prodigy' } })
  }

  // ── telephony wallet ───────────────────────────────────────
  // Every account owns one from the moment it exists, so the phone-numbers
  // console never has to render an account without a wallet. The mode is set
  // once here from the account's identity (internal accounts ride the agency
  // card); afterwards the stored value wins — see ensureWallet().
  await db.telephonyWallet.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      billingMode: defaultBillingMode({ slug: org.slug, kind: org.kind }),
    },
  })

  // ── roles + role permissions ───────────────────────────────
  const roleIdByKey = new Map<RoleKey, string>()
  for (const key of STAFF_ROLES) {
    const role = await db.role.upsert({
      where: { organizationId_key: { organizationId: org.id, key } },
      update: {},
      create: {
        organizationId: org.id, key, name: ROLE_LABELS[key], isSystem: true,
        permissions: { create: ROLE_PERMISSIONS[key].map((pk) => ({ permissionId: permId.get(pk)! })) },
      },
    })
    roleIdByKey.set(key, role.id)

  }

  // ── default pipeline + stages ──────────────────────────────
  let pipeline = await db.pipeline.findFirst({
    where: { organizationId: org.id, isDefault: true },
  })
  if (!pipeline) {
    pipeline = await db.pipeline.create({
      data: { organizationId: org.id, name: 'Client Lifecycle', isDefault: true },
    })
  }
  for (const s of DEFAULT_STAGES) {
    await db.pipelineStage.upsert({
      where: { pipelineId_key: { pipelineId: pipeline.id, key: s.key } },
      // Admins may tune stages after bootstrap — never clobber their edits.
      update: {},
      create: {
        pipelineId: pipeline.id,
        key: s.key,
        name: s.name,
        category: s.category,
        position: s.position,
        slaHours: s.slaHours,
        isTerminal: s.isTerminal,
        requiredFields: s.requiredFields,
        checklist: s.checklist,
        allowedNextKeys: s.allowedNextKeys,
        description: s.description,
      },
    })
  }

  // ── intake survey (skip-if-exists by name) ─────────────────
  const existingSurvey = await db.survey.findFirst({
    where: { organizationId: org.id, name: INTAKE_SURVEY_NAME },
  })
  if (!existingSurvey) {
    await db.survey.create({
      data: {
        organizationId: org.id,
        name: INTAKE_SURVEY_NAME,
        version: 1,
        isActive: true,
        schema: INTAKE_SURVEY_SCHEMA,
      },
    })
  }

  // ── standard submission package + 8 requirements ───────────
  let pkg = await db.documentPackage.findFirst({
    where: { organizationId: org.id, isDefault: true },
  })
  if (!pkg) {
    pkg = await db.documentPackage.create({
      data: {
        organizationId: org.id,
        name: 'Standard Submission Package',
        description: 'Default requirements for a CYS / attorney submission. Editable by admins.',
        isDefault: true,
      },
    })
  }
  for (const [i, r] of REQUIREMENT_DEFS.entries()) {
    await db.documentRequirement.upsert({
      where: { packageId_key: { packageId: pkg.id, key: r.key } },
      update: {},
      create: {
        packageId: pkg.id,
        key: r.key,
        name: r.name,
        category: r.category,
        isRequired: true,
        isAttorneyRequired: r.attorney,
        position: i,
        allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        maxSizeMb: 25,
        expiresAfterDays: r.category === DocumentCategory.IDENTITY ? 365 : null,
      },
    })
  }

  // ── lead sources ───────────────────────────────────────────
  for (const s of LEAD_SOURCE_DEFS) {
    await db.leadSource.upsert({
      where: { organizationId_key: { organizationId: org.id, key: s.key } },
      update: {},
      create: { organizationId: org.id, key: s.key, name: s.name, channel: s.channel },
    })
  }

  // ── starter content (idempotent upsert seeds) ──────────────
  // No users exist yet at bootstrap time, so template authorship stays null;
  // the demo seed stamps its admin afterwards.
  const emptyCtx = { organizationId: org.id, users: [], clientIds: [] }
  await seedMessaging(db, emptyCtx)
  await seedOutreach(db, emptyCtx)
  await seedCys(db, emptyCtx)

  return { organizationId: org.id, roleIdByKey }
}
