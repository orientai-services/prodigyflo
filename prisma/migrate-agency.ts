/**
 * ONE-TIME agency-model production migration (Plan Part B, step B2).
 *
 * Turns the single seeded demo org into the real agency tree:
 *
 *   1.  Rename meridian → "Solar Contract Services" (slug `scs`, kind CLIENT).
 *   2.  bootstrapOrganization → "ProdigyFlo" (slug `prodigyflo`, AGENCY);
 *       parent SCS to it.
 *   3.  bootstrapOrganization → "Cancel Your Solar" (slug `cys`, CLIENT,
 *       parent agency).
 *   4.  Move the `gohighlevel` IntakeSource to CYS and DELETE its test
 *       IntakeSubmissions / InboundEvents / InboundDocuments (stale test rows
 *       carrying real `contact_id`s would make the idempotent importer
 *       silently skip those contacts).
 *   5.  Move the real users (hycama / dakota / itsgatsby) to the agency org,
 *       remapping each `role.key` to the agency role id (nothing in the schema
 *       enforces role.organizationId === user.organizationId — asserted
 *       post-update); null region/team/manager; hycama keeps isOwner.
 *   6.  Deactivate every other user by EXPLICIT keep-list (never by
 *       lastLoginAt — super@/admin@/client@ have logins). Deactivate ≠ delete:
 *       CoachingNote.author and User.roleId are Restrict; audit trails stay.
 *   7.  Purge SCS clients (28 Cascades clean children), then sweep the
 *       SetNull leftovers: SCS IntakeSubmissions (incl. scs-website test
 *       rows), InboundEvents, InboundDocuments, CoachingNotes.
 *   8.  Purge synthetic non-client SCS data: Campaigns (+stats via cascade),
 *       seeded MOCK Connector rows + logs, Notifications (incl. the moved
 *       users' old SCS rows), demo Sequences, Regions/Teams.
 *       KEEP: AuditEvents, MessageTemplates, Survey, DocumentPackage,
 *       LeadSources, remaining IntakeSources (scs-website /
 *       website-lead-form / facebook-leads-sheet / meta-lead-ads),
 *       CysFieldDefinitions.
 *   9.  Disk: confirm ClientDocument count is 0 and print the
 *       `rm -f storage/documents/*` instruction (the B0 tar is the safety net).
 *   10. Print the final tree / user / client / source verification.
 *
 * SAFETY
 *   - DRY-RUN BY DEFAULT: prints what it would do, with counts, and writes
 *     nothing. Set CONFIRM_AGENCY_MIGRATION=yes to execute.
 *   - Aborts (both modes) if slug `prodigyflo` or `cys` already exists, if
 *     `meridian` is missing, if duplicate user emails exist (login is
 *     org-blind), or if any ConnectorCredential rows exist.
 *   - Each destructive step runs inside its own $transaction; a failed
 *     assertion rolls that phase back.
 *
 * Run on the droplet AFTER the code deploy (B1) and the pg_dump backup (B0):
 *
 *   npx tsx prisma/migrate-agency.ts                              # dry run
 *   CONFIRM_AGENCY_MIGRATION=yes npx tsx prisma/migrate-agency.ts # execute
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { bootstrapOrganization } from '../src/lib/org/bootstrap'

// ─────────────────────────────────────────────────────────────
// Pure, testable pieces (imported by tests/migrate-agency.test.ts)
// ─────────────────────────────────────────────────────────────

/** Slugs this migration creates — their presence means it already ran. */
export const RESERVED_SLUGS = ['prodigyflo', 'cys'] as const

/** The org this migration renames; its absence means there is nothing to do. */
export const SOURCE_ORG_SLUG = 'meridian'

/**
 * The ONLY users that stay active. An explicit list, never a lastLoginAt
 * heuristic — several demo users (super@/admin@/client@) have real logins.
 */
export const KEEP_ACTIVE_EMAILS = [
  'hycama@gmail.com',
  'dakota.hanshew@gmail.com',
  'itsgatsby@protonmail.com',
  'demo@leadrecoveryflow.app', // investor demo — stays in SCS with empty state
] as const

/** The subset of the keep-list that MOVES to the ProdigyFlo agency org. */
export const AGENCY_USER_EMAILS = [
  'hycama@gmail.com',
  'dakota.hanshew@gmail.com',
  'itsgatsby@protonmail.com',
] as const

/** CONFIRM_AGENCY_MIGRATION must be exactly "yes" to leave dry-run mode. */
export function isExecuteMode(confirmEnv: string | undefined): boolean {
  return confirmEnv === 'yes'
}

/** Every reason the migration must not proceed. Empty array = safe to run. */
export function guardFailures(input: {
  existingSlugs: string[]
  duplicateEmails: string[]
  connectorCredentialCount: number
}): string[] {
  const failures: string[] = []
  for (const slug of RESERVED_SLUGS) {
    if (input.existingSlugs.includes(slug)) {
      failures.push(`organization slug "${slug}" already exists — the migration appears to have already run`)
    }
  }
  if (!input.existingSlugs.includes(SOURCE_ORG_SLUG)) {
    failures.push(`source organization slug "${SOURCE_ORG_SLUG}" not found — nothing to migrate`)
  }
  if (input.duplicateEmails.length > 0) {
    failures.push(
      `duplicate user emails across organizations (${input.duplicateEmails.join(', ')}) — ` +
        'login is org-blind; resolve these before migrating',
    )
  }
  if (input.connectorCredentialCount > 0) {
    failures.push(
      `${input.connectorCredentialCount} ConnectorCredential row(s) exist — expected 0; ` +
        'refusing to delete Connector rows that may hold real credentials',
    )
  }
  return failures
}

/** Split the user population into move-to-agency / keep-in-place / deactivate. */
export function partitionUsers<T extends { email: string; isActive: boolean }>(
  users: T[],
): { moveToAgency: T[]; keepActive: T[]; deactivate: T[] } {
  const agency = new Set<string>(AGENCY_USER_EMAILS.map((e) => e.toLowerCase()))
  const keep = new Set<string>(KEEP_ACTIVE_EMAILS.map((e) => e.toLowerCase()))
  const moveToAgency: T[] = []
  const keepActive: T[] = []
  const deactivate: T[] = []
  for (const u of users) {
    const email = u.email.toLowerCase()
    if (agency.has(email)) moveToAgency.push(u)
    else if (keep.has(email)) keepActive.push(u)
    else if (u.isActive) deactivate.push(u)
  }
  return { moveToAgency, keepActive, deactivate }
}

/**
 * Post-update assertion for step 5: every moved user must live in the agency
 * org, hold a role BELONGING to the agency org, and keep the same role key it
 * had before the move. Returns human-readable violations (empty = pass).
 */
export function roleMappingErrors(
  moved: {
    email: string
    organizationId: string
    roleKey: string
    roleOrganizationId: string
    expectedRoleKey: string
  }[],
  agencyOrgId: string,
): string[] {
  const errors: string[] = []
  for (const u of moved) {
    if (u.organizationId !== agencyOrgId) {
      errors.push(`${u.email}: organizationId ${u.organizationId} is not the agency org ${agencyOrgId}`)
    }
    if (u.roleOrganizationId !== agencyOrgId) {
      errors.push(`${u.email}: role belongs to org ${u.roleOrganizationId}, not the agency org ${agencyOrgId}`)
    }
    if (u.roleKey !== u.expectedRoleKey) {
      errors.push(`${u.email}: role key changed ${u.expectedRoleKey} → ${u.roleKey}`)
    }
  }
  return errors
}

// ─────────────────────────────────────────────────────────────
// The migration itself
// ─────────────────────────────────────────────────────────────

const TX_OPTS = { timeout: 180_000, maxWait: 30_000 }

function heading(execute: boolean, n: number, title: string) {
  console.log(`\n── ${execute ? '' : '[dry-run] '}Step ${n}: ${title} ${'─'.repeat(Math.max(1, 60 - title.length))}`)
}

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  })
  const execute = isExecuteMode(process.env.CONFIRM_AGENCY_MIGRATION)

  try {
    console.log(
      execute
        ? '▶ EXECUTE mode (CONFIRM_AGENCY_MIGRATION=yes) — the database WILL be modified.'
        : '▶ DRY-RUN mode — printing the plan with live counts; nothing is written.\n  Set CONFIRM_AGENCY_MIGRATION=yes to execute.',
    )

    // ── Step 0: pre-flight guards ─────────────────────────────
    heading(execute, 0, 'pre-flight guards')
    const orgs = await db.organization.findMany({
      select: { id: true, slug: true, name: true, kind: true, deletedAt: true },
    })
    const emailGroups = await db.user.groupBy({
      by: ['email'],
      where: { deletedAt: null },
      _count: { email: true },
      having: { email: { _count: { gt: 1 } } },
    })
    const credentialCount = await db.connectorCredential.count()
    const failures = guardFailures({
      existingSlugs: orgs.map((o) => o.slug),
      duplicateEmails: emailGroups.map((g) => g.email),
      connectorCredentialCount: credentialCount,
    })
    if (failures.length > 0) {
      console.error('✗ ABORTED — pre-flight guards failed:')
      for (const f of failures) console.error(`  - ${f}`)
      process.exitCode = 1
      return
    }
    const scs = orgs.find((o) => o.slug === SOURCE_ORG_SLUG)!

    // Execute mode also proves the three agency users exist BEFORE step 1 —
    // aborting later (the step-5 belt-and-braces check) would leave a
    // half-migrated tree whose reserved slugs then block a clean re-run.
    const liveEmails = new Set(
      (await db.user.findMany({ where: { deletedAt: null }, select: { email: true } })).map((u) =>
        u.email.toLowerCase(),
      ),
    )
    const missingAgencyUsers = AGENCY_USER_EMAILS.filter((e) => !liveEmails.has(e))
    if (missingAgencyUsers.length > 0) {
      if (execute) {
        console.error(`✗ ABORTED — expected agency users not found: ${missingAgencyUsers.join(', ')}`)
        process.exitCode = 1
        return
      }
      console.log(`⚠ expected agency users not found in THIS database: ${missingAgencyUsers.join(', ')} — execute mode aborts here`)
    }

    const ghlSource = await db.intakeSource.findFirst({
      where: { organizationId: scs.id, kind: 'GO_HIGH_LEVEL' },
      select: { id: true, slug: true, name: true },
    })
    console.log(`✓ guards passed — source org "${scs.name}" (${scs.slug}, ${scs.id})`)
    console.log(
      ghlSource
        ? `✓ gohighlevel IntakeSource: id=${ghlSource.id} slug=${ghlSource.slug}`
        : '⚠ no GO_HIGH_LEVEL IntakeSource found in the source org — step 4 will be skipped',
    )

    // ── Step 1: rename meridian → Solar Contract Services ─────
    heading(execute, 1, 'rename meridian → Solar Contract Services (slug scs, kind CLIENT)')
    if (execute) {
      await db.organization.update({
        where: { id: scs.id },
        data: { name: 'Solar Contract Services', slug: 'scs', kind: 'CLIENT' },
      })
      const after = await db.organization.findUniqueOrThrow({
        where: { id: scs.id },
        select: { name: true, slug: true, kind: true },
      })
      console.log(`✓ renamed: ${JSON.stringify(after)}`)
    } else {
      console.log(`would rename org ${scs.id} "${scs.name}" (${scs.slug}) → "Solar Contract Services" (scs, CLIENT)`)
    }

    // ── Step 2: bootstrap ProdigyFlo AGENCY + parent SCS ──────
    heading(execute, 2, 'bootstrap ProdigyFlo (AGENCY) and parent SCS to it')
    let agencyId: string | null = null
    if (execute) {
      const agency = await bootstrapOrganization(db, {
        name: 'ProdigyFlo',
        slug: 'prodigyflo',
        kind: 'AGENCY',
        parentOrganizationId: null,
      })
      agencyId = agency.organizationId
      await db.organization.update({
        where: { id: scs.id },
        data: { parentOrganizationId: agencyId },
      })
      const roleCount = await db.role.count({ where: { organizationId: agencyId } })
      const stageCount = await db.pipelineStage.count({ where: { pipeline: { organizationId: agencyId } } })
      console.log(`✓ agency org ${agencyId} bootstrapped (${roleCount} roles, ${stageCount} pipeline stages); SCS parented to it`)
    } else {
      console.log('would bootstrapOrganization {name: ProdigyFlo, slug: prodigyflo, kind: AGENCY} and set scs.parentOrganizationId to it')
    }

    // ── Step 3: bootstrap Cancel Your Solar CLIENT ────────────
    heading(execute, 3, 'bootstrap Cancel Your Solar (CLIENT, parent agency)')
    let cysId: string | null = null
    if (execute) {
      const cys = await bootstrapOrganization(db, {
        name: 'Cancel Your Solar',
        slug: 'cys',
        kind: 'CLIENT',
        parentOrganizationId: agencyId,
      })
      cysId = cys.organizationId
      const roleCount = await db.role.count({ where: { organizationId: cysId } })
      console.log(`✓ CYS org ${cysId} bootstrapped (${roleCount} roles), parent = agency`)
    } else {
      console.log('would bootstrapOrganization {name: Cancel Your Solar, slug: cys, kind: CLIENT, parent: <agency>}')
    }

    // ── Step 4: move gohighlevel source to CYS + delete its test rows ──
    heading(execute, 4, 'move gohighlevel IntakeSource to CYS; delete its test rows')
    if (!ghlSource) {
      console.log('skipped — no GO_HIGH_LEVEL IntakeSource in the source org')
    } else {
      const [subs, events, docs] = await Promise.all([
        db.intakeSubmission.count({ where: { sourceId: ghlSource.id } }),
        db.inboundEvent.count({ where: { sourceId: ghlSource.id } }),
        db.inboundDocument.count({ where: { sourceId: ghlSource.id } }),
      ])
      console.log(`gohighlevel test rows: ${subs} IntakeSubmissions, ${events} InboundEvents, ${docs} InboundDocuments`)
      if (execute) {
        await db.$transaction(async (tx) => {
          // Stale test rows with real contact_ids would make the idempotent
          // GHL importer silently skip those contacts — delete BEFORE import.
          const s = await tx.intakeSubmission.deleteMany({ where: { sourceId: ghlSource.id } })
          const e = await tx.inboundEvent.deleteMany({ where: { sourceId: ghlSource.id } })
          const d = await tx.inboundDocument.deleteMany({ where: { sourceId: ghlSource.id } })
          // defaultOwnerId / defaultLeadSourceId point at SCS rows — moving the
          // source across orgs must not carry cross-tenant references along.
          await tx.intakeSource.update({
            where: { id: ghlSource.id },
            data: { organizationId: cysId!, defaultOwnerId: null, defaultLeadSourceId: null },
          })
          console.log(`✓ deleted ${s.count} submissions, ${e.count} events, ${d.count} documents; source moved to CYS`)
        }, TX_OPTS)
        const moved = await db.intakeSource.findUniqueOrThrow({
          where: { id: ghlSource.id },
          select: { organizationId: true },
        })
        console.log(`✓ verify: gohighlevel source organizationId=${moved.organizationId} (CYS=${cysId})`)
      } else {
        console.log(`would delete those rows and move source ${ghlSource.id} to the CYS org (nulling defaultOwner/defaultLeadSource)`)
      }
    }

    // ── Step 5: move real users to the agency org ─────────────
    heading(execute, 5, 'move hycama/dakota/itsgatsby to the agency org (role.key → agency roleId)')
    const allUsers = await db.user.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        email: true,
        isActive: true,
        isOwner: true,
        organizationId: true,
        role: { select: { key: true } },
      },
    })
    const { moveToAgency, keepActive, deactivate } = partitionUsers(allUsers)
    for (const u of moveToAgency) {
      console.log(`  move: ${u.email} (role ${u.role.key}${u.isOwner ? ', OWNER' : ''})`)
    }
    const missingMovers = AGENCY_USER_EMAILS.filter(
      (e) => !moveToAgency.some((u) => u.email.toLowerCase() === e),
    )
    if (missingMovers.length > 0) {
      if (execute) {
        console.error(`✗ ABORTED — expected agency users not found: ${missingMovers.join(', ')}`)
        process.exitCode = 1
        return
      }
      // Dry-run keeps going so the operator still sees the full plan — on a
      // dev database the real users simply don't exist.
      console.log(`⚠ expected agency users not found in THIS database: ${missingMovers.join(', ')} — execute mode aborts here`)
    }
    if (execute) {
      await db.$transaction(async (tx) => {
        const agencyRoles = await tx.role.findMany({
          where: { organizationId: agencyId! },
          select: { id: true, key: true },
        })
        const agencyRoleByKey = new Map(agencyRoles.map((r) => [r.key, r.id]))
        for (const u of moveToAgency) {
          const roleId = agencyRoleByKey.get(u.role.key)
          if (!roleId) throw new Error(`agency org has no role with key ${u.role.key} for ${u.email}`)
          await tx.user.update({
            where: { id: u.id },
            data: {
              organizationId: agencyId!,
              roleId,
              regionId: null,
              teamId: null,
              managerId: null,
              // isOwner deliberately untouched — hycama keeps it.
            },
          })
        }
        // Post-update assertion: nothing in the schema enforces
        // role.organizationId === user.organizationId, so verify it here.
        const movedRows = await tx.user.findMany({
          where: { id: { in: moveToAgency.map((u) => u.id) } },
          select: {
            email: true,
            organizationId: true,
            role: { select: { key: true, organizationId: true } },
          },
        })
        const errors = roleMappingErrors(
          movedRows.map((row) => ({
            email: row.email,
            organizationId: row.organizationId,
            roleKey: row.role.key,
            roleOrganizationId: row.role.organizationId,
            expectedRoleKey: moveToAgency.find((u) => u.email === row.email)!.role.key,
          })),
          agencyId!,
        )
        if (errors.length > 0) {
          throw new Error(`role mapping assertion failed (transaction rolled back):\n  ${errors.join('\n  ')}`)
        }
      }, TX_OPTS)
      const owner = await db.user.findFirst({
        where: { email: 'hycama@gmail.com', deletedAt: null },
        select: { isOwner: true, organizationId: true },
      })
      console.log(`✓ ${moveToAgency.length} users moved; hycama isOwner=${owner?.isOwner} org=${owner?.organizationId}`)
    } else {
      console.log(`would move ${moveToAgency.length} users to the agency org, remap roles by key, null region/team/manager`)
    }

    // ── Step 6: deactivate everyone outside the keep-list ─────
    heading(execute, 6, 'deactivate all users outside the explicit keep-list')
    console.log(`keep-list: ${KEEP_ACTIVE_EMAILS.join(', ')}`)
    console.log(`keeping active in place: ${keepActive.map((u) => u.email).join(', ') || '(none)'}`)
    console.log(`to deactivate: ${deactivate.length} users`)
    if (execute) {
      const res = await db.user.updateMany({
        where: { email: { notIn: [...KEEP_ACTIVE_EMAILS] }, isActive: true },
        data: { isActive: false },
      })
      const stillActive = await db.user.count({ where: { isActive: true, deletedAt: null } })
      console.log(`✓ deactivated ${res.count}; ${stillActive} active users remain (expect ${KEEP_ACTIVE_EMAILS.length})`)
    }

    // ── Step 7: purge SCS clients + SetNull sweeps ────────────
    heading(execute, 7, 'purge SCS clients (cascades) + sweep SetNull leftovers')
    const [clientCount, scsSubs, scsEvents, scsDocs, scsCoaching] = await Promise.all([
      db.client.count({ where: { organizationId: scs.id } }),
      db.intakeSubmission.count({ where: { organizationId: scs.id } }),
      db.inboundEvent.count({ where: { organizationId: scs.id } }),
      db.inboundDocument.count({ where: { organizationId: scs.id } }),
      db.coachingNote.count({ where: { organizationId: scs.id } }),
    ])
    console.log(
      `SCS rows: ${clientCount} Clients, ${scsSubs} IntakeSubmissions, ${scsEvents} InboundEvents, ` +
        `${scsDocs} InboundDocuments, ${scsCoaching} CoachingNotes`,
    )
    if (execute) {
      await db.$transaction(async (tx) => {
        const c = await tx.client.deleteMany({ where: { organizationId: scs.id } })
        // SetNull relations survive the client cascade — sweep them explicitly
        // (includes the scs-website connector-test submissions).
        const s = await tx.intakeSubmission.deleteMany({ where: { organizationId: scs.id } })
        const e = await tx.inboundEvent.deleteMany({ where: { organizationId: scs.id } })
        const d = await tx.inboundDocument.deleteMany({ where: { organizationId: scs.id } })
        const n = await tx.coachingNote.deleteMany({ where: { organizationId: scs.id } })
        console.log(`✓ deleted ${c.count} clients, ${s.count} submissions, ${e.count} events, ${d.count} documents, ${n.count} coaching notes`)
      }, TX_OPTS)
      const left = await db.client.count({ where: { organizationId: scs.id } })
      console.log(`✓ verify: ${left} SCS clients remain (expect 0)`)
    }

    // ── Step 8: purge synthetic non-client SCS data ───────────
    heading(execute, 8, 'purge synthetic non-client SCS data (keep audits/templates/survey/package/sources)')
    const movedIds = moveToAgency.map((u) => u.id)
    const [campaigns, mockConnectors, notifications, movedUserNotifs, sequences, teams, regions] = await Promise.all([
      db.campaign.count({ where: { organizationId: scs.id } }),
      db.connector.count({ where: { organizationId: scs.id, status: 'MOCK' } }),
      db.notification.count({ where: { organizationId: scs.id } }),
      db.notification.count({ where: { userId: { in: movedIds } } }),
      db.sequence.count({ where: { organizationId: scs.id } }),
      db.team.count({ where: { organizationId: scs.id } }),
      db.region.count({ where: { organizationId: scs.id } }),
    ])
    console.log(
      `SCS rows: ${campaigns} Campaigns, ${mockConnectors} MOCK Connectors, ${notifications} Notifications ` +
        `(${movedUserNotifs} belong to moved users), ${sequences} Sequences, ${teams} Teams, ${regions} Regions`,
    )
    if (execute) {
      await db.$transaction(async (tx) => {
        const camp = await tx.campaign.deleteMany({ where: { organizationId: scs.id } })
        // MOCK-only: pre-flight proved no ConnectorCredential rows exist, so
        // nothing real is lost; ConnectorLogs cascade with their connector.
        const conn = await tx.connector.deleteMany({ where: { organizationId: scs.id, status: 'MOCK' } })
        // Moved users' old SCS notifications would be invisible cross-org
        // clutter — the org-wide delete removes them; the userId sweep catches
        // any row already re-homed by other means.
        const notif = await tx.notification.deleteMany({ where: { organizationId: scs.id } })
        const notif2 = await tx.notification.deleteMany({ where: { userId: { in: movedIds } } })
        const seq = await tx.sequence.deleteMany({ where: { organizationId: scs.id } })
        const team = await tx.team.deleteMany({ where: { organizationId: scs.id } })
        const region = await tx.region.deleteMany({ where: { organizationId: scs.id } })
        console.log(
          `✓ deleted ${camp.count} campaigns, ${conn.count} connectors, ${notif.count + notif2.count} notifications, ` +
            `${seq.count} sequences, ${team.count} teams, ${region.count} regions`,
        )
      }, TX_OPTS)
      const kept = await Promise.all([
        db.auditEvent.count({ where: { organizationId: scs.id } }),
        db.messageTemplate.count({ where: { organizationId: scs.id } }),
        db.survey.count({ where: { organizationId: scs.id } }),
        db.documentPackage.count({ where: { organizationId: scs.id } }),
        db.leadSource.count({ where: { organizationId: scs.id } }),
        db.intakeSource.count({ where: { organizationId: scs.id } }),
        db.cysFieldDefinition.count({ where: { organizationId: scs.id } }),
      ])
      console.log(
        `✓ kept in SCS: ${kept[0]} AuditEvents, ${kept[1]} MessageTemplates, ${kept[2]} Surveys, ` +
          `${kept[3]} DocumentPackages, ${kept[4]} LeadSources, ${kept[5]} IntakeSources, ${kept[6]} CysFieldDefinitions`,
      )
    }

    // ── Step 9: disk check ────────────────────────────────────
    heading(execute, 9, 'storage/documents disk check')
    const docCount = await db.clientDocument.count()
    if (execute) {
      if (docCount === 0) {
        console.log('✓ ClientDocument count is 0 — now run on the droplet:  rm -f storage/documents/*')
        console.log('  (the B0 tar of storage/documents is the safety net)')
      } else {
        console.log(`⚠ ${docCount} ClientDocument rows still exist — do NOT delete storage/documents; investigate first.`)
      }
    } else {
      console.log(`ClientDocument rows now: ${docCount} — after execution this must be 0 before running rm -f storage/documents/*`)
    }

    // ── Step 10: final verification summary ───────────────────
    heading(execute, 10, 'final verification summary')
    const tree = await db.organization.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        kind: true,
        parentOrganization: { select: { slug: true } },
      },
    })
    for (const o of tree) {
      const [active, inactive, clients] = await Promise.all([
        db.user.count({ where: { organizationId: o.id, isActive: true, deletedAt: null } }),
        db.user.count({ where: { organizationId: o.id, isActive: false, deletedAt: null } }),
        db.client.count({ where: { organizationId: o.id } }),
      ])
      console.log(
        `  ${o.slug.padEnd(12)} ${o.kind.padEnd(7)} parent=${(o.parentOrganization?.slug ?? '—').padEnd(12)} ` +
          `users ${active} active / ${inactive} inactive · ${clients} clients · "${o.name}"`,
      )
    }
    const sources = await db.intakeSource.findMany({
      select: { slug: true, kind: true, isEnabled: true, organization: { select: { slug: true } } },
      orderBy: { createdAt: 'asc' },
    })
    console.log('  intake sources:')
    for (const s of sources) {
      console.log(`    ${s.slug.padEnd(24)} ${s.kind.padEnd(16)} → org ${s.organization.slug}${s.isEnabled ? '' : ' (disabled)'}`)
    }
    console.log(
      execute
        ? '\n✓ Migration complete. Continue with the B3 smoke checks (logins, switcher, /agency, /recovery).'
        : '\nDry run complete — nothing was modified. Re-run with CONFIRM_AGENCY_MIGRATION=yes to execute.',
    )
  } finally {
    await db.$disconnect()
  }
}

// Run only when invoked directly (`npx tsx prisma/migrate-agency.ts`), never
// when imported by the test suite for the pure helpers above.
const invokedDirectly = Boolean(
  process.argv[1] && /migrate-agency\.(ts|mts|js|mjs|cjs)$/.test(process.argv[1].replace(/\\/g, '/')),
)
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
