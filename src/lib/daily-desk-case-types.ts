import type { ComputedCell } from '@/lib/daily-desk-finance'
import type { DeskDocState } from '@/lib/daily-desk-docs'

export type CaseCell = {
  label: string
  cell: ComputedCell
  hint?: string
  /** Printed extract the homeowner has not confirmed. Never set on Missing. */
  unverified?: boolean
}

export type CaseDocFile = {
  id: string
  label: string
  version: number
  status: string
  fileUrl: string | null
  mimeType: string | null
}

export type CaseDocTile = {
  files: CaseDocFile[]
  key: string
  label: string
  state: DeskDocState
  requirementId: string | null
  documentId: string | null
  fileUrl: string | null
  mimeType: string | null
  extract: { kicker: string; title: string; fields: { label: string; value: string }[]; note: string } | null
}

export type CaseFileData = {
  availableFiles?: CaseDocFile[]
  id: string
  firstName: string
  lastName: string
  city: string
  state: string
  zip: string
  source: string
  stage: string
  ownerName: string | null
  appointmentLabel: string | null
  docsPresent: number
  extractionLabel: string
  creditLabel: string
  creditOnFile: boolean
  packetReady: boolean
  packetMissing: string[]
  cysApproved: boolean
  cysApprovable: boolean
  cysBlockers: string[]
  finance: CaseCell[]
  solar: CaseCell[]
  docs: CaseDocTile[]
  intake: { question: string; answer: string }[]
  redline: {
    facts: string
    vs: string
    state: string[]
    federal: string[]
    blockers: string[]
    flag: string
  }
  brief: {
    id: string
    body: string
    sur: string[]
    ask: string
    open: string
    approved: boolean
  } | null
  closers: { id: string; name: string }[]
  canAssign: boolean
  canBook: boolean
  canUpload: boolean
  timezone: string
  appointmentId: string | null
  appointmentUpdatedAt?: string | null
  canRequest: boolean
  canBrief: boolean
  bookDate: string
  bookTime: string
}
