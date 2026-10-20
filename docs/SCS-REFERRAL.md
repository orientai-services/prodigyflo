# SCS intake from an existing dialer lead

The SCS Intake action passes an expiring signed `pfl` referral for the selected
CallCenterLead. The SCS site verifies that referral with
`POST /api/intake/scs/prefill` and displays saved contact details as editable
defaults. Imported defaults do not establish answers, consent or signatures.
The SCS production form must implement this bootstrap; sending the URL alone
does not prefill a form.

SCS retains `data.attribution.pfl` on its outbound packets. ProdigyFlo resolves
that exact lead inside the receiving source's organization **before** applying
the intake. The receipt transaction locks the lead row and reuses its linked
Client. On the first intake, it creates the native Client profile once, attaches
it to the original lead, and retains the SunOff-assigned active closer. It never
creates another CallCenterLead. Subsequent answers, documents and bookings use
that same Client, even when a new browser session creates a new SCS case UUID.
Retries of one SCS case still reuse its durable intake submission.

Existing Client ownership, pipeline progress and saved contact values are
preserved. Submitted questionnaire answers and source documents are refreshed
through the normal intake paths. A deleted, foreign or conflicting exact binding
returns 409 rather than creating a replacement Client. The prefill endpoint also
refuses deleted or foreign linked profiles.

This is exact referral matching only. Ordinary SCS property cases without a
valid referral continue to use their own case UUID; matching phone numbers or
emails do not merge different properties. The existing invalid/expired referral
audit remains unchanged. No schema migration or new secret is required.

Regression coverage: `src/lib/intake/scs-referral-roundtrip.test.ts` and
`src/lib/call-center/intake-link-desk.test.ts`.
