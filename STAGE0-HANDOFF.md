# Stage 0 handoff — retired

The temporary restoration policy is retired. The pre-existing 548 historical
SCS document-import rows remain terminally `ARCHIVED` for audit and are not
selected by the normal importer.

Authenticated SCS receipts now use the normal durable path: stable
`scs:{lead_id}` intake binding, idempotent receipt handling, queued document
metadata, and retryable pending/failed document imports. No restoration
admission is required or inspected.

`SCS_DOCUMENT_IMPORTS_PAUSED` and the optional execution cohort remain
operational controls only. Normal production does not require a cohort.
