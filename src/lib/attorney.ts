import type { DocumentStatus, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { clientScope, type SessionUser } from '@/lib/rbac'

/**
 * Attorney handover readiness + package manifest.
 *
 * Mirrors the CYS model deliberately: there is no attorney API. Approval here
 * assembles a Submission row {destination: ATTORNEY, status: DRAFT} whose
 * manifest lists exactly which document versions were reviewed; staff then
 * deliver it by hand and record the outcome on /submissions like any CYS
 * package. The pure functions at the top are what the tests exercise — the DB
 * loaders below only feed them.
 */

// ── Pure readiness maths ─────────────────────────────────────

export type AttorneyRequirementInput = { id: string; name: string }

export type AttorneyDocumentInput = {
  requirementId: string | null
  status: DocumentStatus
}

export type AttorneyReadiness = {
  ready: boolean
  /** Plain-language reasons approval must be refused right now. */
  blockers: string[]
  requiredTotal: number
  requiredApproved: number
  hasSignedContract: boolean
}

/** Best status a requirement has reached across its uploaded versions. */
function bestStatusFor(
  requirementId: string,
  documents: AttorneyDocumentInput[],
): DocumentStatus | null {
  const mine = documents.filter((d) => d.requirementId === requirementId)
  if (mine.some((d) => d.status === 'APPROVED')) return 'APPROVED'
  // Anything in flight beats a dead end; report the most advanced state.
  const order: DocumentStatus[] = [
    'UNDER_REVIEW',
    'PROCESSING',
    'RECEIVED',
    'MISSING_INFORMATION',
    'REQUESTED',
    'REJECTED',
    'EXPIRED',
  ]
  for (const status of order) if (mine.some((d) => d.status === status)) return status
  return null
}

/**
 * The approval gate, as data. Ready only when EVERY attorney-required document
 * is APPROVED and a signed contract is on file. Hiding the button is not the
 * protection — the server action re-runs this before writing anything.
 */
export function computeAttorneyReadiness(args: {
  requirements: AttorneyRequirementInput[]
  documents: AttorneyDocumentInput[]
  hasSignedContract: boolean
}): AttorneyReadiness {
  const blockers: string[] = []
  let approved = 0

  for (const req of args.requirements) {
    const status = bestStatusFor(req.id, args.documents)
    if (status === 'APPROVED') {
      approved += 1
    } else if (status === null) {
      blockers.push(`"${req.name}" has not been requested or uploaded.`)
    } else {
      blockers.push(`"${req.name}" is not approved yet (currently ${status.toLowerCase().replace(/_/g, ' ')}).`)
    }
  }

  if (!args.hasSignedContract) {
    blockers.push('No signed contract on file — record the signed solar agreement first.')
  }

  return {
    ready: blockers.length === 0,
    blockers,
    requiredTotal: args.requirements.length,
    requiredApproved: approved,
    hasSignedContract: args.hasSignedContract,
  }
}

// ── Package manifest ─────────────────────────────────────────

export type AttorneyManifestSource = {
  id: string
  fileName: string | null
  label: string | null
  requirementName: string | null
  checksum: string | null
  version: number
  mimeType: string | null
  sizeBytes: number | null
  status: DocumentStatus
}

export type AttorneyManifestDocument = {
  id: string
  name: string
  requirement: string | null
  checksum: string | null
  version: number
  mimeType: string | null
  sizeBytes: number | null
  status: DocumentStatus
}

/**
 * What actually gets handed to the attorney: every APPROVED document, named,
 * with checksum and version so a later dispute can prove which file was sent.
 */
export function buildAttorneyManifest(docs: AttorneyManifestSource[]): AttorneyManifestDocument[] {
  return docs
    .filter((d) => d.status === 'APPROVED')
    .map((d) => ({
      id: d.id,
      name: d.label ?? d.fileName ?? d.requirementName ?? 'Document',
      requirement: d.requirementName,
      checksum: d.checksum,
      version: d.version,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      status: d.status,
    }))
}

// ── DB loaders ───────────────────────────────────────────────

/** Attorney-required requirements across the org's document packages. */
export async function loadAttorneyRequirements(organizationId: string) {
  return db.documentRequirement.findMany({
    where: { isAttorneyRequired: true, package: { organizationId } },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: { id: true, key: true, name: true, category: true, description: true },
  })
}

const QUEUE_CLIENT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  updatedAt: true,
  currentStage: { select: { key: true, name: true } },
  owner: { select: { name: true } },
  contracts: { select: { id: true, signedAt: true, counterparty: true } },
  documents: {
    where: { requirement: { isAttorneyRequired: true } },
    select: {
      id: true,
      requirementId: true,
      status: true,
      fileName: true,
      label: true,
      checksum: true,
      version: true,
      mimeType: true,
      sizeBytes: true,
      storageKey: true,
      receivedAt: true,
      updatedAt: true,
      requirement: { select: { id: true, name: true } },
    },
  },
  submissions: {
    where: { destination: 'ATTORNEY' as const },
    orderBy: { updatedAt: 'desc' as const },
    select: { id: true, status: true, attemptNumber: true, submittedAt: true, updatedAt: true },
  },
} satisfies Prisma.ClientSelect

export type AttorneyQueueClient = Prisma.ClientGetPayload<{ select: typeof QUEUE_CLIENT_SELECT }>

export type AttorneyQueueRow = {
  client: AttorneyQueueClient
  readiness: AttorneyReadiness
  latestSubmission: AttorneyQueueClient['submissions'][number] | null
}

function hasSignedContract(client: { contracts: { signedAt: Date | null }[] }): boolean {
  return client.contracts.some((c) => c.signedAt !== null)
}

/**
 * Clients waiting on attorney review: in the ATTORNEY_DOCUMENT_REVIEW stage,
 * or carrying attorney-required documents in any state. Scope-filtered like
 * every other client query.
 */
export async function getAttorneyQueue(user: SessionUser): Promise<AttorneyQueueRow[]> {
  const [requirements, clients] = await Promise.all([
    loadAttorneyRequirements(user.organizationId),
    db.client.findMany({
      where: {
        AND: [
          clientScope(user),
          { currentStage: { category: { not: 'TERMINAL' } } },
          {
            OR: [
              { currentStage: { key: 'ATTORNEY_DOCUMENT_REVIEW' } },
              { documents: { some: { requirement: { isAttorneyRequired: true } } } },
            ],
          },
        ],
      },
      select: QUEUE_CLIENT_SELECT,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
  ])

  return clients
    .map((client) => ({
      client,
      readiness: computeAttorneyReadiness({
        requirements,
        documents: client.documents,
        hasSignedContract: hasSignedContract(client),
      }),
      latestSubmission: client.submissions[0] ?? null,
    }))
    .sort((a, b) => Number(b.readiness.ready) - Number(a.readiness.ready))
}

/** Everything the detail page and the approval action need for one client. */
export async function getAttorneyClientDetail(user: SessionUser, clientId: string) {
  const [requirements, client] = await Promise.all([
    loadAttorneyRequirements(user.organizationId),
    db.client.findFirst({
      where: { AND: [clientScope(user), { id: clientId }] },
      select: { ...QUEUE_CLIENT_SELECT, email: true, phone: true },
    }),
  ])
  if (!client) return null

  const readiness = computeAttorneyReadiness({
    requirements,
    documents: client.documents,
    hasSignedContract: hasSignedContract(client),
  })

  return { client, requirements, readiness }
}
