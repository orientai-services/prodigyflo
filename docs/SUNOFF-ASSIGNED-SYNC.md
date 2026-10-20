# Assigned SunOff leads

Scope: existing Gatsby (SunOff 63) and Dakota (169) accounts in their existing ProdigyFlo workspace; SunOff brand only.

SunOff publishes signed complete snapshots immediately after lead edits and on a one-minute retry sweep. ProdigyFlo refreshes its desk every 20 seconds. Only the latest snapshot revision is accepted. Contact history is retained if an assignment is withdrawn.

ProdigyFlo lead outcomes and calendar actions now send a signed command to `https://dialer.sunoff.app/api/internal/prodigyflo-lead`. The actor comes from the authenticated server action. Commands carry the source revision and a request id. D1 applies a conditional update and its receipt together; a lost response is retried with the identical body. Concurrent edits return an explicit conflict. The returned source snapshot reconciles the same ProdigyFlo lead and the same imported slot. Source visits are edited through calendar actions; native ProdigyFlo visits retain their native services. Assignment changes still happen in SunOff; a calendar edit cannot silently transfer a lead to a different person.

No calls, texts, email, signatures, consent, fake Clients, or appointments are created by the reconciliation itself. An appointment is created only by an explicit booking action. Source DNC and opt-outs remain enforced. Existing shared HMAC key; no new secrets or schema migration.

## SCS prefill interface

The single SCS Intake split button opens `/begin?pfl=<opaque signed token>&fresh=1`; owner access preserves the assigned rep. A second start button has been removed from the client-profile column.

ProdigyFlo exposes `POST /api/intake/scs/prefill` with JSON `{ "token": "<pfl>" }`. It validates the existing 14-day single-lead token and returns `{ok:true,version:1,leadId,language,values}`. Values contain only saved name, encrypted contact data decrypted for this handoff, and available address/ZIP fields. No PII is added to URLs or cached. Invalid, expired, inactive or already-linked records are refused.

**SCS consumption is pending canonical repository access.** In orientai-services/scs-intake, resolve `pfl` server-side when starting the fresh application; fetch this interface on the server, merge known values into the corresponding lead columns only where blank, retain `pfl` in attribution, and keep the homeowner review/consent steps. Do not infer testimony, check consent boxes, copy signatures, resume a different customer from a cookie, or deploy a stale Hycamax fork. The browser test stubs the external SCS page: it verifies the launch and the real ProdigyFlo prefill response, not a completed SCS application.

Validation: bundled Worker + SQLite integration covers booking, confirmation, idempotency, stale writes, visit outcomes, DNC, actor and tenant boundaries. ProdigyFlo local PostgreSQL tests cover signed commands/retries, reconciliation, owner intake launch, scoped prefill, wrong-org and invalid-token refusal. Desktop/mobile browser coverage checks one intake action, actual popup navigation, and source-calendar labels.
