# Stage 0 exact import and bounded resume

Local candidate only. Keep `SCS_DOCUMENT_IMPORTS_PAUSED=true` and `SCS_IMPORT_REQUIRE_COHORT=true` until explicitly authorized. The requirement latch must remain enabled during controlled resume.

`SCS_IMPORT_EXECUTION_COHORT` is server-owned JSON: `{mode:"synthetic"|"resume",expiresAt:<ISO>,organizationId:<ID>,sourceId:<ID>,cases:[{leadId:<UUID>,documentIds:[<UUID>]}]}`. It is applied to row selection, abandoned-claim recovery and atomic import claims before batch limits. Synthetic mode permits one case; cron remains held even with its pause flag false. Missing required, malformed, expired, wrong-case and wrong-document approvals refuse execution. Organization/source mismatches select no work. Default no-cohort/no-latch behavior remains backward compatible and is not approved for controlled resume.

`POST /api/internal/scs/execute` requires an independent `STAGE0_EXECUTION_TOKEN` (at least 32 characters), exact `leadId` and `documentId`, plus the matching approved cohort. It runs only the document importer, not the shared jobs endpoint (which also sends messages, renews phone billing and runs other processing). Proxy exemption is exact-path only. The route is unavailable without its dedicated credential; cron credentials do not authorize it.

Receiver authentication strips caller-supplied `stage0_synthetic`. It adds the marker only for the server-approved synthetic source/organization/case. The marker is retained on later same-case updates, even after execution approval expires. Its persisted intake binding blocks messaging, per-case AI assist context and document extraction. It does not disable other organizations' scheduled work. No new booking is created by this intake/import path.

The pause remains global to SCS imports until separately changed: the verified local production snapshot contains Team Prodigy and Meridian Client Solutions. Team Prodigy is the only intended team. Meridian removal must reconcile and preserve its owned records first; no removal is included in this candidate.

No schema migration. Local tests include repeated case/doc delivery, selected resume with unrelated backlog unchanged, wrong organization/source, expiry, missing required manifest, operator authorization, synthetic message/AI/extraction denial, and the proxy route boundary. Cloud deployment and live end-to-end proof remain separate approval gates.
