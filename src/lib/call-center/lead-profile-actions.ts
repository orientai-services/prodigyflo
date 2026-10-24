'use server'

import { recordAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { loadProfileFile } from '@/lib/final-desk/data'
import { answerCount } from '@/lib/final-desk/questions'
import { can, requireUser, type SessionUser } from '@/lib/rbac'
import type { CaseFileData } from '@/lib/daily-desk-case-types'
import { findClientViaDeskLead } from './desk-client'

export type LeadProfileData = {
  file: CaseFileData
  questionnaire: { done: boolean; progress: number }
  /** A desk reader outside the Client's scope: every write and every file link is off. */
  readOnly: boolean
  /** The reader may not read documents at all, so the Documents section is left out. */
  docsHidden: boolean
  /** The intake landed but it or its documents are still being processed. */
  analysing: boolean
  /** When the newest intake for this Client arrived (ISO), for "Intake received <ago>". */
  intakeAt: string | null
}

export type LeadProfileResult = { ok: true; profile: LeadProfileData } | { ok: false; reason: string }

/**
 * A read view for someone the desk lead lets in but the Client's scope
 * doesn't (findClientViaDeskLead). The loaders filter by scope, so this one
 * load runs with an org-wide reader for exactly this Client, and the result
 * is cut back to what a read view may carry: no write flags, no closer list,
 * no signed file links (the file and PDF routes check scope again and would
 * refuse them), no brief without brief rights.
 */
function readOnlyView(user: SessionUser, file: CaseFileData): CaseFileData {
  const strip = <T extends { fileUrl: string | null }>(item: T): T => ({ ...item, fileUrl: null })
  return {
    ...file,
    // Out-of-scope reps see masked contact elsewhere (last 4 digits); the full
    // phone/email on the case file must not ride through this view.
    phone: '',
    email: '',
    availableFiles: (file.availableFiles ?? []).map(strip),
    docs: file.docs.map((tile) => ({ ...strip(tile), files: tile.files.map(strip) })),
    brief: can(user, 'ai:run') || can(user, 'ai:review') ? file.brief : null,
    closers: [],
    canAssign: false,
    canBook: false,
    canUpload: false,
    canRequest: false,
    canBrief: false,
  }
}

async function analysisState(organizationId: string, clientId: string) {
  const [submission, pending] = await Promise.all([
    db.intakeSubmission.findFirst({
      where: { organizationId, clientId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true },
    }),
    db.documentExtraction.count({ where: { status: { in: ['PENDING', 'RUNNING'] }, document: { clientId } } }),
  ])
  return {
    analysing: submission?.status === 'RECEIVED' || pending > 0,
    intakeAt: submission?.createdAt.toISOString() ?? null,
  }
}

/** The linked Client's profile for the dialer lead panel (docs/CYS_BRIDGE.md §B2). Audited. */
export async function loadLeadProfile(leadId: string): Promise<LeadProfileResult> {
  const user = await requireUser()
  const access = await findClientViaDeskLead(user, leadId)
  if (!access) return { ok: false, reason: 'No linked client you can see' }
  const reader: SessionUser = access.inScope ? user : { ...user, role: 'SUPER_ADMIN' }
  const [loaded, state] = await Promise.all([loadProfileFile(reader, access.clientId), analysisState(user.organizationId, access.clientId)])
  if (!loaded) return { ok: false, reason: 'Client not found' }
  await recordAudit(user, {
    action: 'client.viewed_from_desk',
    entityType: 'Client',
    entityId: access.clientId,
    summary: access.inScope ? 'Profile opened from the dialer' : 'Profile read from the dialer (lead lock, outside scope)',
    after: { leadId, readOnly: !access.inScope },
  })
  return {
    ok: true,
    profile: {
      file: access.inScope ? loaded.file : readOnlyView(user, loaded.file),
      questionnaire: { done: loaded.questionnaire.done, progress: answerCount(loaded.questionnaire.answers) },
      readOnly: !access.inScope,
      docsHidden: !can(user, 'documents:read'),
      analysing: state.analysing,
      intakeAt: state.intakeAt,
    },
  }
}
