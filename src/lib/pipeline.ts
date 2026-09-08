import { StageCategory, StageKey } from '@prisma/client'

export type StageDefinition = {
  key: StageKey
  name: string
  category: StageCategory
  position: number
  slaHours: number | null
  isTerminal: boolean
  requiredFields: string[]
  checklist: { key: string; label: string }[]
  allowedNextKeys: StageKey[]
  description: string
}

const S = StageKey
const C = StageCategory

/** Every stage may also move to ON_HOLD, CLOSED_LOST, or NOT_QUALIFIED. */
export const UNIVERSAL_EXITS: StageKey[] = [S.ON_HOLD, S.CLOSED_LOST]

/**
 * The default 25-stage client lifecycle. Seeded into PipelineStage rows, where
 * admins can then edit SLA, required fields, checklists, and allowed transitions
 * per organization — this constant is only the starting point.
 */
export const DEFAULT_STAGES: StageDefinition[] = [
  {
    key: S.NEW_LEAD,
    name: 'New lead',
    category: C.INTAKE,
    position: 0,
    slaHours: 1,
    isTerminal: false,
    requiredFields: ['firstName', 'lastName', 'phone'],
    checklist: [{ key: 'source_recorded', label: 'Lead source recorded' }],
    allowedNextKeys: [S.SURVEY_STARTED, S.SURVEY_COMPLETED, S.INFO_VERIFICATION],
    description: 'Lead has arrived and is awaiting first contact.',
  },
  {
    key: S.SURVEY_STARTED,
    name: 'Survey started',
    category: C.INTAKE,
    position: 1,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'survey_link_sent', label: 'Survey link delivered to client' }],
    allowedNextKeys: [S.SURVEY_COMPLETED, S.NEW_LEAD],
    description: 'The client opened the survey but has not finished it.',
  },
  {
    key: S.SURVEY_COMPLETED,
    name: 'Survey completed',
    category: C.INTAKE,
    position: 2,
    slaHours: 4,
    isTerminal: false,
    requiredFields: ['email', 'phone'],
    checklist: [{ key: 'survey_reviewed', label: 'Survey answers reviewed by staff' }],
    allowedNextKeys: [S.INFO_VERIFICATION],
    description: 'All survey steps submitted and ready for verification.',
  },
  {
    key: S.INFO_VERIFICATION,
    name: 'Client information verification',
    category: C.INTAKE,
    position: 3,
    slaHours: 24,
    isTerminal: false,
    requiredFields: ['email', 'phone'],
    checklist: [
      { key: 'phone_verified', label: 'Phone verified' },
      { key: 'email_verified', label: 'Email verified' },
      { key: 'address_confirmed', label: 'Service address confirmed' },
    ],
    allowedNextKeys: [S.CONSENT_PENDING],
    description: 'Contact and identity details confirmed against client-provided evidence.',
  },
  {
    key: S.CONSENT_PENDING,
    name: 'Consent pending',
    category: C.QUALIFICATION,
    position: 4,
    slaHours: 48,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'disclosure_presented', label: 'Disclosure presented to client' },
      { key: 'consent_captured', label: 'Written consent captured with version and timestamp' },
    ],
    allowedNextKeys: [S.CREDIT_PULL_PENDING, S.QUALIFICATION_REVIEW],
    description: 'Awaiting the client’s explicit, recorded consent before any credit inquiry.',
  },
  {
    key: S.CREDIT_PULL_PENDING,
    name: 'Soft credit pull pending',
    category: C.QUALIFICATION,
    position: 5,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'permissible_purpose', label: 'Permissible purpose recorded' }],
    allowedNextKeys: [S.CREDIT_PULL_COMPLETED, S.QUALIFICATION_REVIEW],
    description: 'Consent is on file and the soft inquiry has been requested.',
  },
  {
    key: S.CREDIT_PULL_COMPLETED,
    name: 'Soft credit pull completed',
    category: C.QUALIFICATION,
    position: 6,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'summary_attached', label: 'Credit summary attached to record' }],
    allowedNextKeys: [S.QUALIFICATION_REVIEW],
    description: 'A summary result is available for human review.',
  },
  {
    key: S.QUALIFICATION_REVIEW,
    name: 'Qualification review',
    category: C.QUALIFICATION,
    position: 7,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'evidence_complete', label: 'Supporting evidence complete' },
      { key: 'human_decision', label: 'Decision recorded by a named reviewer' },
    ],
    allowedNextKeys: [S.QUALIFIED, S.NOT_QUALIFIED],
    description: 'A person reviews the evidence and records the qualification decision.',
  },
  {
    key: S.QUALIFIED,
    name: 'Qualified',
    category: C.SALES,
    position: 8,
    slaHours: 4,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'closer_assigned', label: 'Closer assigned' }],
    allowedNextKeys: [S.APPOINTMENT_SCHEDULING],
    description: 'Cleared for a sales conversation and ready for assignment.',
  },
  {
    key: S.NOT_QUALIFIED,
    name: 'Not qualified',
    category: C.TERMINAL,
    position: 9,
    slaHours: null,
    isTerminal: true,
    requiredFields: ['disqualifiedReason'],
    checklist: [{ key: 'reason_recorded', label: 'Disqualification reason recorded' }],
    allowedNextKeys: [S.QUALIFICATION_REVIEW],
    description: 'Did not meet the configured criteria. Reason is required.',
  },
  {
    key: S.APPOINTMENT_SCHEDULING,
    name: 'Appointment scheduling',
    category: C.SALES,
    position: 10,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'availability_offered', label: 'Availability offered to client' }],
    allowedNextKeys: [S.APPOINTMENT_SCHEDULED],
    description: 'Coordinating a time with the assigned closer.',
  },
  {
    key: S.APPOINTMENT_SCHEDULED,
    name: 'Appointment scheduled',
    category: C.SALES,
    position: 11,
    slaHours: null,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'invite_sent', label: 'Calendar invite sent' },
      { key: 'reminder_scheduled', label: 'Reminder scheduled' },
    ],
    allowedNextKeys: [S.PRESENTATION_COMPLETED, S.APPOINTMENT_SCHEDULING, S.FOLLOW_UP],
    description: 'A confirmed appointment is on the calendar.',
  },
  {
    key: S.PRESENTATION_COMPLETED,
    name: 'Presentation completed',
    category: C.SALES,
    position: 12,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'presentation_logged', label: 'Presentation outcome logged' },
      { key: 'next_step_set', label: 'Next step agreed with client' },
    ],
    allowedNextKeys: [S.FOLLOW_UP, S.PAYMENT_SELECTION],
    description: 'The offer has been presented and the outcome recorded.',
  },
  {
    key: S.FOLLOW_UP,
    name: 'Follow-up',
    category: C.SALES,
    position: 13,
    slaHours: 72,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'followup_scheduled', label: 'Follow-up task scheduled' }],
    allowedNextKeys: [S.PAYMENT_SELECTION, S.APPOINTMENT_SCHEDULING, S.PRESENTATION_COMPLETED],
    description: 'Working an undecided client toward a decision.',
  },
  {
    key: S.PAYMENT_SELECTION,
    name: 'Payment or financing selection',
    category: C.FULFILLMENT,
    position: 14,
    slaHours: 48,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'path_selected', label: 'Payment path selected by client' },
      { key: 'terms_disclosed', label: 'Terms disclosed in writing' },
    ],
    allowedNextKeys: [S.DOCUMENT_COLLECTION],
    description: 'The client chooses how the engagement will be paid for.',
  },
  {
    key: S.DOCUMENT_COLLECTION,
    name: 'Document collection',
    category: C.FULFILLMENT,
    position: 15,
    slaHours: 120,
    isTerminal: false,
    requiredFields: [],
    checklist: [
      { key: 'requests_sent', label: 'Document requests sent' },
      { key: 'all_required_received', label: 'All required documents received' },
    ],
    allowedNextKeys: [S.COMMUNICATION_EVIDENCE_REVIEW],
    description: 'Gathering every document in the configured package.',
  },
  {
    key: S.COMMUNICATION_EVIDENCE_REVIEW,
    name: 'Communication evidence review',
    category: C.FULFILLMENT,
    position: 16,
    slaHours: 48,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'evidence_validated', label: 'Communication evidence validated' }],
    allowedNextKeys: [S.ATTORNEY_DOCUMENT_REVIEW],
    description: 'Confirming the retained communication record supports the file.',
  },
  {
    key: S.ATTORNEY_DOCUMENT_REVIEW,
    name: 'Attorney document review',
    category: C.SUBMISSION,
    position: 17,
    slaHours: 72,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'attorney_docs_approved', label: 'Attorney-required documents approved' }],
    allowedNextKeys: [S.DEAL_READY_FOR_SUBMISSION],
    description: 'The configured attorney-required documents are checked for completeness.',
  },
  {
    key: S.DEAL_READY_FOR_SUBMISSION,
    name: 'Deal ready for submission',
    category: C.SUBMISSION,
    position: 18,
    slaHours: 24,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'package_validated', label: 'Submission package passes validation' }],
    allowedNextKeys: [S.SUBMITTED],
    description: 'The package is assembled and awaiting an authorized approver.',
  },
  {
    key: S.SUBMITTED,
    name: 'Submitted to CYS / attorney',
    category: C.SUBMISSION,
    position: 19,
    slaHours: 120,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'external_ref', label: 'External reference number recorded' }],
    allowedNextKeys: [S.CORRECTIONS_REQUESTED, S.APPROVED],
    description: 'Delivered to the external destination and awaiting a response.',
  },
  {
    key: S.CORRECTIONS_REQUESTED,
    name: 'Corrections requested',
    category: C.SUBMISSION,
    position: 20,
    slaHours: 48,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'corrections_logged', label: 'Requested corrections logged' }],
    allowedNextKeys: [S.DOCUMENT_COLLECTION, S.SUBMITTED],
    description: 'The external reviewer returned the package for fixes.',
  },
  {
    key: S.APPROVED,
    name: 'Approved',
    category: C.SUBMISSION,
    position: 21,
    slaHours: 48,
    isTerminal: false,
    requiredFields: [],
    checklist: [{ key: 'client_notified', label: 'Client notified of approval' }],
    allowedNextKeys: [S.CLOSED_WON],
    description: 'Accepted by the external destination.',
  },
  {
    key: S.CLOSED_WON,
    name: 'Closed won',
    category: C.TERMINAL,
    position: 22,
    slaHours: null,
    isTerminal: true,
    requiredFields: [],
    checklist: [{ key: 'deal_value_recorded', label: 'Final deal value recorded' }],
    allowedNextKeys: [],
    description: 'The engagement completed successfully.',
  },
  {
    key: S.CLOSED_LOST,
    name: 'Closed lost',
    category: C.TERMINAL,
    position: 23,
    slaHours: null,
    isTerminal: true,
    requiredFields: ['lostReason'],
    checklist: [{ key: 'loss_reason_recorded', label: 'Loss reason recorded' }],
    allowedNextKeys: [],
    description: 'The client did not proceed. Reason is required.',
  },
  {
    key: S.ON_HOLD,
    name: 'On hold',
    category: C.TERMINAL,
    position: 24,
    slaHours: null,
    isTerminal: false,
    requiredFields: ['holdReason'],
    checklist: [{ key: 'hold_reason_recorded', label: 'Hold reason recorded' }],
    allowedNextKeys: [S.FOLLOW_UP, S.QUALIFICATION_REVIEW, S.DOCUMENT_COLLECTION],
    description: 'Paused at the client’s request or pending an external dependency.',
  },
]

export const STAGE_BY_KEY = new Map(DEFAULT_STAGES.map((s) => [s.key, s]))

export function stageLabel(key: StageKey): string {
  return STAGE_BY_KEY.get(key)?.name ?? key
}

/** Board columns for the main Kanban — terminal states live in their own view. */
export const BOARD_STAGE_KEYS: StageKey[] = DEFAULT_STAGES.filter(
  (s) => s.category !== C.TERMINAL,
).map((s) => s.key)

export const CATEGORY_LABELS: Record<StageCategory, string> = {
  INTAKE: 'Intake',
  QUALIFICATION: 'Qualification',
  SALES: 'Sales',
  FULFILLMENT: 'Fulfillment',
  SUBMISSION: 'Submission',
  TERMINAL: 'Closed',
}

/** Tailwind classes per category, used consistently across board, badges, charts. */
export const CATEGORY_STYLES: Record<StageCategory, { dot: string; badge: string }> = {
  INTAKE: { dot: 'bg-slate-400', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  QUALIFICATION: { dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  SALES: { dot: 'bg-blue-500', badge: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300' },
  FULFILLMENT: { dot: 'bg-violet-500', badge: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  SUBMISSION: { dot: 'bg-teal-500', badge: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300' },
  TERMINAL: { dot: 'bg-zinc-400', badge: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
}
