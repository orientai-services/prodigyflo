# STATUS — SCS Intake + ProdigyFlo

**This is the live status file. Update it in the same commit as the change it describes.**
It is duplicated in both repos (`orientai-services/scs-intake`, `orientai-services/prodigyflo`)
and the two copies should be kept identical — the two apps are one product and one pipeline.

How to maintain it: move items between `OPEN` / `IN PROGRESS` / `CLOSED`, add a dated line to
the Change log, and keep `Last updated` current. Do not delete closed items for at least a
release — the record of what was fixed is the point.

**Last updated:** 2026-09-10
**Deployed:** `scs-intake-42.vercel.app` · `prodigyflo-42.vercel.app`
(Vercel team OrientAI, production branch `main`, push-to-deploy live)
**Databases:** Supabase org SCS (Pro) — `vspmjtdwlcqfclkgksel` us-east-1 (SCS),
`acgmcenrbwabmpxzgwqb` us-west-2 (ProdigyFlo)

---

## 0 · Blocking — must resolve before real homeowner traffic

| # | Item | Why it blocks | Owner |
|---|---|---|---|
| B1 | **Repositioning not reflected in copy** — service is being reframed from *contract cancellation* to *homeowner advocacy & advisory that analyses documents and refers to the best cancellation provider*. Current copy still promises "we handle the rest" and "we take it from there". | The site describes a service you are no longer selling. Also changes the legal exposure of every claim on the page. | Dakota |
| B2 | **Unsigned guarantee copy is live** — `src/config/qualify.ts` carries `COUNSEL_REVIEW_PENDING` on "2-year money-back guarantee" and "If we don't deliver, you get your money back for two years." It renders on the qualification screen. The copy guard passes only because they are registered exceptions. | A contractual promise shown at the moment of maximum trust, unreviewed by counsel. Under B1 it may also be simply false. | Counsel |
| B3 | **No `RESEND_API_KEY`** — no confirmation email, no resume link. | The funnel promises "add it later from the link we email you". That link never sends. Anyone who does not finish in one sitting is lost. | Dakota |
| B4 | **No Turnstile keys** — public form, no bot protection. | Spam will pollute the CRM, and ad spend will pay for it. | Dakota |
| B5 | **251 seeded fake clients in the production CRM** (250 demo homeowners + 34 staff users). | Real leads land indistinguishable from fixtures in a closer's queue. | Dakota |
| B6 | **`PRODIGYFLO_CONNECTOR_TOKEN` is still `local-dev-token`** — hardcoded in `prisma/seeds/intake.ts`, readable by anyone with repo access. | Anyone who can read the repo can post leads into the CRM. Rotate the env var and the `IntakeSource.secretHash` row together or delivery breaks. | Dakota |

## 1 · Open

- **Extraction quality.** `EXTRACTION_PROVIDER=mock` read a purchase agreement as *"A lease"*
  and labelled it "✓ From your document"; missed lender and price. 2 of 4 fields, and the
  wrong one determines which levers apply. Switching to `anthropic` is one env var +
  `ANTHROPIC_API_KEY` (~$0.20–0.30/contract), no code change.
- **Cross-document identity verification — unimplemented.** Per the requirements note on
  `main` (`SCS - INTAKE - AI ANALYSIS DOCS - IMPORTANT .rtf`): every uploaded document must
  have first name, last name and home address verified against the intake form. Utility bill
  is the only *name* exception (may be a spouse's); the **address must match across all
  documents**. Currently a note in a Word file, not code and not a test.
- **`CALENDLY_WEBHOOK_SIGNING_KEY` unset** — booking webhook 501s, so bookings do not flow
  back automatically. Visible in Calendly regardless. Lower priority.
- **`SLACK_WEBHOOK_URL` unset** — no staff alert on new leads. Optional.
- **ProdigyFlo CRM never opened.** `/login` returns 200 but no one has logged in. The
  SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end.
- **The divergence.** ProdigyFlo here lacks Mailbox and the Planning work boards that exist in
  the Hycamax tree (2 migrations, 16 Prisma models/enums). Reconcile is rehearsed and lands at
  966/966 tests; one conflict in `src/app/api/jobs/run/route.ts` (~4 lines).
- **DNS cutover** — `solarcontractservices.com` and `prodigyflo.ai` still point at the
  DigitalOcean droplet `64.23.190.77`. Deliberately untouched.
- **Cleanup** — 3 dead Vercel projects (`scs-intake`, `gatsby-scs-intake`, `scs-stage1`),
  2 orphaned Supabase projects in the wrong account (`tozjxujvckeciexyvbpw`,
  `hftqdhbkcixuntdscscf`), misleading branch `feat/schema-42-on-p0-mvp` (named as the
  reconcile, contains none of it), ~6 GB of stale local trees.
- **Claude Supabase connector points at the wrong account** — it cannot see the real projects,
  which is how the two orphans got created.

## 2 · In progress

- **Customer-journey redesign** under the advocacy/advisory framing (B1). Screen-by-screen
  capture and field inventory in `docs/journey/`.

## 3 · Closed

| Date | Item |
|---|---|
| 09-10 | Document uploads working end to end — presigned PUT → private Supabase bucket → DB row; anonymous fetch refused (400) |
| 09-10 | Calendly booking step fixed — was a dead end, `NEXT_PUBLIC_CALENDLY_EVENT_URL` unset; now loads with lead id threaded through |
| 09-10 | Full funnel proven end to end — upload → extraction → 5 steps → consent → `qualified` → delivery enqueued → cron dispatch → client in ProdigyFlo, unattended |
| 09-10 | Supabase private CA pinned — `pg-env.ts` assumed a public CA; every DB connection failed `SELF_SIGNED_CERT_IN_CHAIN`. Verification kept on |
| 09-10 | IPv6-only DB host replaced with IPv4 shared pooler — Vercel could not resolve `db.<ref>.supabase.co` |
| 09-10 | `postinstall: prisma generate` added — Vercel build failed without it |
| 09-10 | 12 type errors fixed — `next build` exited 1, no BUILD_ID, Vercel could not deploy |
| 09-10 | Repos transferred to `orientai-services`; Vercel projects git-linked; `main` merged and made production |
| 09-10 | Supabase GitHub integration on ProdigyFlo disconnected — was wired to `dakotahanshew/scs-stage1` |
| 09-10 | Nav entry withdrawn for a page absent from this tree (`/settings/progress`) |
| 09-10 | Cron verified firing every 5 min on all three scheduled routes, 200 |

## Change log

- **2026-09-10** — File created. Captures state after the Vercel + Supabase migration, the
  first successful end-to-end funnel run, and the decision to reposition the service (B1).
