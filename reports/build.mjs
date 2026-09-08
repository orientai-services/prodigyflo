/**
 * Rebuilds the two shareable report pages from the CURRENT state of the project:
 *
 *   reports/out/roadmap.html     — phase/priority status board
 *   reports/out/schema-map.html  — interactive chord-ring of the Prisma schema
 *
 * Everything dynamic is measured, not typed in: models/relations/enums parsed
 * from prisma/schema.prisma, row counts queried from the live DATABASE_URL,
 * route count derived from the app tree, test count from a real vitest run
 * (skippable with --skip-tests, which reuses the last measured number).
 *
 * Publishing is a separate step (the Artifact URLs are fixed) — see
 * .claude/skills/refresh-reports/SKILL.md.
 */
import 'dotenv/config'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'reports', 'out')
mkdirSync(out, { recursive: true })
const cachePath = join(root, 'reports', 'last-build.json')
const skipTests = process.argv.includes('--skip-tests')

// ── 1. schema ────────────────────────────────────────────────
const GROUPS = {
  'Access & org':       ['Organization','Region','Team','Permission','Role','RolePermission','User','UserSession','Invite','AuthToken'],
  'Clients & pipeline': ['Pipeline','PipelineStage','StageHistory','Client','ClientAddress'],
  'Intake':             ['IntakeSource','IntakeSubmission','InboundEvent','InboundDocument'],
  'Communications':     ['Communication','Call','Message','MessageTemplate','Sequence','SequenceStep','SequenceEnrollment','ScheduledMessage'],
  'Documents & AI':     ['DocumentPackage','DocumentRequirement','ClientDocument','DocumentReview','DocumentExtraction','ExtractedField'],
  'CYS & submission':   ['CysFieldDefinition','CysReadiness','CysFieldValue','Deal','Submission'],
  'Qualification':      ['Survey','SurveyResponse','Consent','Verification','CreditPull','QualificationReview','Contract'],
  'Scheduling & pay':   ['Assignment','AvailabilitySlot','Appointment','Presentation','PaymentMethod','FinancingApplication'],
  'Close-rate ops':     ['CloserBrief','CoachingNote','NurtureTouch','HotLeadReview'],
  'Work & marketing':   ['Task','Note','LeadSource','Campaign','CampaignDailyStat','AdSet','AttributionEvent','SavedFilter'],
  'Engine':             ['EngineRun','EngineStep','Insight'],
  'System':             ['AIRecommendation','Connector','ConnectorLog','ConnectorCredential','Notification','AuditEvent','DeployRun'],
}
const groupOf = {}
for (const [g, ms] of Object.entries(GROUPS)) for (const m of ms) groupOf[m] = g

const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8')
const enums = [...schema.matchAll(/^enum (\w+)/gm)].length
const models = {}
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const [, name, body] = m
  let fields = 0
  const fks = []
  const uniques = [...body.matchAll(/@@unique\(\[([^\]]+)\]\)/g)].map((u) => u[1])
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('@@') || line.startsWith('/')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    fields++
    if (line.includes('references:')) fks.push(parts[1].replace(/[\?\[\]]/g, ''))
  }
  models[name] = { fields, fks, uniques }
}
const edges = []
for (const [name, info] of Object.entries(models))
  for (const t of info.fks) if (models[t]) edges.push([name, t])

const ungrouped = Object.keys(models).filter((m) => !groupOf[m])
if (ungrouped.length) {
  // New models land in "System" until someone assigns a real domain — loudly.
  console.warn(`⚠ ungrouped models (added to System — assign a domain in build.mjs): ${ungrouped.join(', ')}`)
  for (const m of ungrouped) groupOf[m] = 'System'
}

// ── 2. live rows ─────────────────────────────────────────────
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const tables = await client.query(
  `select table_name from information_schema.tables where table_schema='public' and table_name != '_prisma_migrations'`,
)
let totalRows = 0
for (const { table_name } of tables.rows) {
  const n = (await client.query(`select count(*)::int n from "${table_name}"`)).rows[0].n
  if (models[table_name]) models[table_name].rows = n
  totalRows += n
}
await client.end()
for (const m of Object.values(models)) m.rows ??= 0

// ── 3. routes / tests / git ─────────────────────────────────
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim()
const appFiles = sh('git ls-files "src/app"').split('\n')
const routes =
  appFiles.filter((f) => f.endsWith('/page.tsx')).length +
  appFiles.filter((f) => f.endsWith('/route.ts')).length +
  1 // +1: /_not-found

let cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {}
let tests = cache.tests ?? 0, suites = cache.suites ?? 0
if (!skipTests) {
  console.log('running vitest…')
  const vt = execSync('npx vitest run', { cwd: root, encoding: 'utf8' })
  tests = Number(/Tests\s+(\d+) passed/.exec(vt)?.[1] ?? 0)
  suites = Number(/Test Files\s+(\d+) passed/.exec(vt)?.[1] ?? 0)
  if (!tests) throw new Error('could not parse vitest output — refusing to publish a zero')
} else {
  console.log(`--skip-tests: reusing last measured ${tests} tests / ${suites} suites`)
}
const commit = sh('git log -1 --format="%h %s"')
const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// ── 4. render ────────────────────────────────────────────────
const data = {
  models: Object.fromEntries(
    Object.entries(models).map(([n, i]) => [n, { fields: i.fields, group: groupOf[n], uniques: i.uniques, rows: i.rows }]),
  ),
  edges,
  groups: Object.keys(GROUPS),
  enums,
  totalRows,
}

const fill = (tpl, map) => Object.entries(map).reduce((s, [k, v]) => s.replaceAll(k, String(v)), tpl)

writeFileSync(join(out, 'schema-map.html'), fill(readFileSync(join(root, 'reports/templates/schema-map.html'), 'utf8'), {
  __DATA__: JSON.stringify(data),
  __N_MODELS__: Object.keys(models).length,
  __N_EDGES__: edges.length,
  __N_ENUMS__: enums,
  __N_ROWS__: totalRows.toLocaleString('en-US'),
}))

writeFileSync(join(out, 'roadmap.html'), fill(readFileSync(join(root, 'reports/templates/roadmap.html'), 'utf8'), {
  __DATE__: date,
  __ROUTES__: routes,
  __TESTS__: tests,
  __SUITES__: suites,
  __COMMIT__: commit.length > 60 ? commit.slice(0, 57) + '…' : commit,
}))

writeFileSync(cachePath, JSON.stringify({ tests, suites, routes, models: Object.keys(models).length,
  edges: edges.length, totalRows, commit, builtAt: new Date().toISOString() }, null, 2))

console.log(`✓ reports/out/roadmap.html + schema-map.html
  ${Object.keys(models).length} models · ${edges.length} relations · ${enums} enums · ${totalRows.toLocaleString()} rows
  ${routes} routes · ${tests} tests · ${commit}`)
