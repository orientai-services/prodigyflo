/**
 * The SCS packet is bound to a ProdigyFlo client that no longer exists (for
 * example a deleted test client). Nothing is written; the sender should stop
 * retrying until staff reconcile. The route answers 409 with a stable code.
 */
export class BoundClientUnavailableError extends Error {
  readonly code = 'bound_client_unavailable' as const
  constructor() {
    super('Bound SCS client is unavailable; reconciliation required.')
    this.name = 'BoundClientUnavailableError'
  }
}

/** A source case and its signed referral disagree. Do not create a replacement
 * or redirect the homeowner's answers to either record automatically.
 */
export class IntakeBindingConflictError extends Error {
  readonly code = 'intake_binding_conflict' as const
  constructor() {
    super('SCS case and intake link belong to different clients; reconciliation required.')
    this.name = 'IntakeBindingConflictError'
  }
}
