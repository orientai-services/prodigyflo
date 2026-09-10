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
**Revert point:** tag `pre-advisory-reframe` in both repos

---

## 0 · Blocking — must resolve before real homeowner traffic

| # | Item | Why it blocks | Owner |
|---|---|---|---|
| B1 | **Repositioning is half done.** The homeowner-facing journey now reads as advocacy and introduction. ProdigyFlo still speaks the old language internally — closers, READY, Strawberry submitting to CYS/attorney — and the marketing site has not been swept. | Staff see "closer" and "Submit" while the public site says we only review and introduce. The two halves describe different businesses. | Dakota |
| B3 | **No `RESEND_API_KEY`** — no confirmation email, no resume link. | The funnel promises "add it later from the link we email you". That link never sends. Anyone who does not finish in one sitting is lost. | Dakota |
| B4 | **No Turnstile keys** — public form, no bot protection. | Spam will pollute the CRM, and ad spend will pay for it. | Dakota |
| B5 | **251 seeded fake clients in the production CRM** (250 demo homeowners + 34 staff users). | Real leads land indistinguishable from fixtures in a closer's queue. | Dakota |
| B6 | **`PRODIGYFLO_CONNECTOR_TOKEN` is still `local-dev-token`** — hardcoded in `prisma/seeds/intake.ts`, readable by anyone with repo access. | Anyone who can read the repo can post leads into the CRM. Rotate the env var and the `IntakeSource.secretHash` row together or delivery breaks. | Dakota |

**B2 is closed** — see below. The counsel-pending guarantee copy was removed rather than
softened, so there is nothing left on that screen awaiting sign-off.

## 1 · Open

### The reframe, continued
- **Document-retrieval modules.** Every mirror gap already carries a `DocumentNeed`; nothing
  consumes it yet. Planned: Gmail deep-link search, generic webmail instructions (Outlook,
  Yahoo, iCloud), a lender/servicer portal registry (TradeBloc, Sunlight, GoodLeap, Mosaic,
  Dividend), and utility-bill guidance. **Utility rule: 6 months before installation and 12
  months after — unless it has been under a year, then everything since.**
- **Provider registry and the introduction step.** Partners are unofficial and unsigned.
  Copy deliberately says "a provider that handles cases like yours", not "the best provider
  for you" — an introduction, not a ranking, which is what we can support today and what
  keeps the claim honest without a compensation disclosure.
- **ProdigyFlo's internal language** (part of B1). Closer → advisor, READY → referral-ready,
  Submit → handoff. Decide before staff train on the old vocabulary.
- **Marketing site sweep.** `src/config/marketing.ts` and `content.ts` were only spot-fixed.

### Product
- **Extraction quality.** `EXTRACTION_PROVIDER=mock` read a purchase agreement as *"A lease"*
  and marked it "from your document"; it misses payment, lender, rate and balance entirely.
  The mirror renders 2 findings and 5 gaps as a result. Switching to `anthropic` is one env
  var plus `ANTHROPIC_API_KEY` (~$0.20–0.30/contract), no code change. **This is the single
  biggest lever on whether the mirror is worth anything.**
- **Cross-document identity verification — unimplemented.** Per the requirements note on
  `main`: first name, last name and home address must be verified against the intake form on
  every uploaded document. Utility bill is the only *name* exception (may be a spouse's); the
  **address must match across all documents**. `signer_name` is now mirrored, which gives the
  anchor to compare against.
- **ProdigyFlo CRM never opened.** `/login` returns 200 but nobody has logged in. The
  SCHEMA_42 packet panel, closer-win brief and READY gating are unverified end to end.
- **The fade-in is slow.** Every screen transition animates slowly enough that automated
  clicks repeatedly landed on invisible elements. A real user on a poor connection feels the
  same delay.

### Infrastructure
- `CALENDLY_WEBHOOK_SIGNING_KEY` unset — booking webhook 501s, bookings do not flow back
  automatically. Visible in Calendly regardless. Low priority.
- `SLACK_WEBHOOK_URL` unset — no staff alert on new leads. Optional.
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

Nothing mid-flight. The mirror and the reframe are both shipped.

## 3 · Closed

| Date | Item |
|---|---|
| 09-10 | **B2 closed.** Guarantee and credit-protection claims removed, not softened. The two standing `APPROVED_EXCEPTIONS` in `check-copy.ts` deleted with them — a stale exception waits quietly until someone reintroduces the phrasing. Copy guard now passes with zero exceptions |
| 09-10 | Journey reframed to advocacy and introduction — offer screen, process steps, marketing step 4, exit copy |
| 09-10 | **Consent corrected** (`contract_review` v2026-09-10.1). Old text authorised sharing with "its partner law firm", which does not exist — authorising a disclosure that never happens and not the one that does. Sharing is now conditional on the homeowner asking for an introduction |
| 09-10 | **The mirror** (`src/lib/mirror.ts`) — restates a homeowner's own documents and does arithmetic on them, never assesses. Enforced by `check:mirror`, verified by breaking it three ways |
| 09-10 | `/findings` renders the mirror after `/review`, with page + quote citations and gaps naming the document that answers them |
| 09-10 | **Per-field confirmation.** Every machine-read value needs a decision — confirmed, edited or cleared — before the file advances. Enforced server-side from our own extraction rows, so omitting a field from the payload cannot smuggle it through |
| 09-10 | Mirror reads endorsed values, not extractor proposals — it was restating values the homeowner had just corrected |
| 09-10 | **Multi-file upload.** Every document row takes a whole batch at once. Fixed a stale-closure bug found on the way: `upload` closed over `docs`, so two files in flight both appended to the same captured array and the second silently overwrote the first — nothing errored, a file just never appeared. Verified in the browser with a 3-file batch, all three persisted across a reload |
| 09-10 | "Learn how to find or get your [document]" now renders under all eight upload rows — the primary agreement card was missing one, and acronyms were being lower-cased to "ucc-1" |
| 09-10 | Document uploads working end to end — presigned PUT → private Supabase bucket → DB row; anonymous fetch refused (400) |
| 09-10 | Calendly booking step fixed — was a dead end, `NEXT_PUBLIC_CALENDLY_EVENT_URL` unset |
| 09-10 | Full funnel proven end to end, unattended — upload → extraction → 5 steps → consent → `qualified` → delivery enqueued → cron dispatch → client in ProdigyFlo |
| 09-10 | Supabase private CA pinned; IPv6-only DB host replaced with the IPv4 pooler; `postinstall: prisma generate` added; 12 type errors fixed — each of these independently blocked deployment |
| 09-10 | Repos transferred to `orientai-services`; Vercel git-linked; `main` merged and made production |
| 09-10 | Supabase GitHub integration on ProdigyFlo disconnected — was wired to `dakotahanshew/scs-stage1` |
| 09-10 | Cron verified firing every 5 min on all three scheduled routes, 200 |

## Corrections to earlier entries

- **Extraction is not slow for users.** An earlier note claimed 120–270s. That was an artefact
  of driving the API directly and waiting on the 5-minute cron. `/reading` kicks the worker
  itself (`POST /api/extractions/run`) and then polls, so a homeowner in a browser waits
  seconds.
- **`FILE_STORAGE_DRIVER=local` does not silently lose files on Vercel.** `getFileStorage()`
  throws under `VERCEL`, so it fails loudly.

## Change log

- **2026-09-10** — Mirror shipped, journey reframed to advocacy/introduction, consent
  corrected, per-field confirmation of machine-read values enforced. B2 closed.
- **2026-09-10** — File created after the Vercel + Supabase migration and the first successful
  end-to-end funnel run.
