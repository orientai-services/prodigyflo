import type { ComputedCell } from '@/lib/daily-desk-finance'
import type { DeskDocState } from '@/lib/daily-desk-docs'

export type CaseCell = {
  label: string
  cell: ComputedCell
  hint?: string
  /** Printed extract the homeowner has not confirmed. Never set on Missing. */
  unverified?: boolean
}

export type CaseDocTile = {
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
  canRequest: boolean
  canBrief: boolean
  bookDate: string
  bookTime: string
}
