---
name: refresh-reports
description: Rebuild and republish the ProdigyFlo roadmap and schema-map artifact pages from the current state of the repo and live database. Use after any significant change — a shipped phase, schema migration, notable fix, or deploy — or when the user asks to "update the reports", "refresh the roadmap", or "update the schema map".
---

# Refresh the ProdigyFlo report pages

Two shareable pages track this project, published at **fixed URLs** that must
never change (people hold links to them):

| Page | Artifact URL |
| --- | --- |
| Roadmap (phases, priorities, reflections) | `https://claude.ai/code/artifact/5986a256-2930-4c66-a27a-4695c97d203c` |
| Schema map (chord ring of the Prisma schema) | `https://claude.ai/code/artifact/6c42e219-1ac0-41a5-90cc-6d0836089708` |

There is also a screens walkthrough at
`https://claude.ai/code/artifact/5d7fd68e-687d-4171-8676-c29ef51c50c5` —
re-capture it only when the UI changed visibly (see `MVP_STATUS.md` for the
screenshot process); it is not part of the routine refresh.

## Steps

1. **Build** (from the repo root):
   ```
   npm run reports          # measures everything, runs the test suite (~15 s)
   npm run reports:fast     # reuses the last test count — only when tests just ran
   ```
   This regenerates `reports/out/roadmap.html` and `reports/out/schema-map.html`
   from the live schema, database row counts, route tree, vitest, and git log.
   A `⚠ ungrouped models` warning means new Prisma models need a domain
   assigned in `reports/build.mjs` (`GROUPS`) — fix that before publishing.

2. **Update the editorial content** in `reports/templates/roadmap.html` when the
   *status* of anything changed — a phase started or shipped, a blocker cleared,
   a new reflection worth adding, a resolved caveat worth removing. The numbers
   are injected automatically; the prose is not. Then rebuild. If nothing
   editorial changed, skip this step.

3. **Publish** each output with the Artifact tool, passing the fixed URL as
   `url` so the existing page updates in place (never publish without `url` —
   that creates a new page and breaks everyone's links):
   - `reports/out/roadmap.html` → the roadmap URL above
   - `reports/out/schema-map.html` → the schema-map URL above

4. **Ship to the app.** The same pages are served inside ProdigyFlo at
   `/settings/progress` (Settings → Planning & progress) from `reports/out/`.
   Commit the rebuilt outputs, then push them to production:
   ```
   scp reports/out/roadmap.html reports/out/schema-map.html        root@64.23.190.77:/opt/prodigyflo/app/reports/out/
   ```
   (Create the remote dir on first use. No app restart needed — the route reads
   the files per request.)

5. **Tell the user what changed** in one or two lines: which numbers moved,
   what editorial edits were made, and anything the build warned about.

## Invariants

- Keep both `<title>` tags and favicons stable (`ProdigyFlo Roadmap` 🧭,
  `ProdigyFlo Schema Map` 🕸️).
- Never hand-edit `reports/out/*` — it is generated; edit templates or build.mjs.
- Numbers on the pages must come from the build, never typed in by hand.
