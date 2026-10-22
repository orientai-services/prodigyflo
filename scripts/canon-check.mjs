#!/usr/bin/env node
// canon-check.mjs — mechanical checks for docs/SCS-FLO-CANON.md (DRAFT).
// Same file in scs-intake, prodigyflo, prodigy-records-service. Node 20+, no deps.
// Usage:
//   node scripts/canon-check.mjs            # full tree + diff vs origin/main
//   node scripts/canon-check.mjs --staged   # pre-commit: staged files only
//   CANON_BASE=<sha> node scripts/canon-check.mjs   # CI: diff vs PR base
// Exit 1 on any violation. Each message names the rule ID.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const sh = c => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
const STAGED = process.argv.includes('--staged')
const fails = [], warns = []
const fail = (id, msg) => fails.push(`${id}: ${msg}`)
const warn = (id, msg) => warns.push(`${id}: ${msg}`)

const APP = existsSync('src/server/delivery/queue.ts') ? 'scs'
  : existsSync('src/lib/intake/scs-document-import.ts') ? 'pf'
  : existsSync('service.py') && existsSync('records') ? 'records' : 'unknown'

const tracked = sh('git ls-files').split('\n').filter(Boolean)
const base = process.env.CANON_BASE || sh('git merge-base HEAD origin/main')
const changed = STAGED
  ? sh('git diff --cached --name-only --diff-filter=ACMR').split('\n').filter(Boolean)
  : base ? sh(`git diff --name-only --diff-filter=ACMR ${base}...HEAD`).split('\n').filter(Boolean) : []
const added = (file) => STAGED ? sh(`git diff --cached -U0 -- "${file}"`) : base ? sh(`git diff -U0 ${base}...HEAD -- "${file}"`) : ''
const addedLines = file => added(file).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1))
const read = f => { try { return statSync(f).size < 2_000_000 ? readFileSync(f, 'utf8') : '' } catch { return '' } }
const TEXT = /\.(m?[jt]sx?|cjs|json|ya?ml|md|py|sh|toml|txt|env|sql|html|css)$/i
const SKIP = /(^|\/)(node_modules|\.next|\.venv|dist|build|public\/pdfjs|reports\/out|package-lock\.json)(\/|$)/
const commitMsgs = base ? sh(`git log --format=%B ${base}..HEAD`) : ''

// R-SEC-001 — secret files tracked or staged
const SECRET_FILE = /(^|\/)(\.env(\.[^/]*)?|\.secret|\.filekey|id_rsa[^/]*|.*\.pem|.*\.p12|.*\.key|recovery-private[^/]*)$/i
for (const f of (STAGED ? changed : tracked)) {
  if (SECRET_FILE.test(f) && !/\.example$|\.sample$/.test(f) && !/(^|\/)(fixtures|__fixtures__)\//.test(f)) fail('R-SEC-001', `secret-type file in git: ${f}`)
}
// R-SEC-001 — token patterns in added lines
const TOKENS = [
  [/\bsk-(live|proj|ant)-[A-Za-z0-9_-]{20,}/, 'API secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bSK[0-9a-f]{32}\b/, 'Twilio API key'],
  [/\bEAA[A-Za-z0-9]{60,}/, 'Meta access token'],
  [/postgres(ql)?:\/\/[^:\s]+:[^@\s]{6,}@(?!127\.0\.0\.1|localhost)/, 'database URL with password'],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}/, 'Supabase secret key'],
  [/\b(vercel_|vc_)[A-Za-z0-9]{24,}\b/, 'Vercel token'],
]
for (const f of changed) {
  if (!TEXT.test(f) || SKIP.test(f) || /\.example$/.test(f)) continue
  for (const line of addedLines(f)) for (const [re, what] of TOKENS) if (re.test(line)) fail('R-SEC-001', `${what} pattern added in ${f}`)
}

// R-GOV-001 — second prod deploy path
const DEPLOY_FILES = tracked.filter(f => /^\.github\/workflows\/.*\.ya?ml$|^package\.json$|^scripts\/.*\.(sh|mjs|js|ts)$|^vercel\.json$/.test(f) && f !== 'scripts/canon-check.mjs')
for (const f of DEPLOY_FILES) {
  const t = read(f)
  if (/vercel\s+(deploy\s+)?(--prod\b|-p\b|--target[ =]production)/.test(t)) fail('R-GOV-001', `production deploy command in ${f} (main merge is the only prod deploy)`)
  if (/amondnet\/vercel-action|vercel\/action/.test(t)) fail('R-GOV-001', `Vercel deploy action in ${f}`)
}

// R-REC-002 / R-REC-003 — tunnels and retired hosts in code/config
const TUNNEL = /https?:\/\/[a-z0-9.-]*(trycloudflare\.com|ngrok(-free)?\.(io|app|dev)|loca\.lt|localtunnel\.me|serveo\.net)/i
for (const f of changed) {
  if (!TEXT.test(f) || SKIP.test(f) || /\.md$/.test(f)) continue
  for (const line of addedLines(f)) {
    if (TUNNEL.test(line)) fail('R-REC-002', `non-approved tunnel URL added in ${f}; prod may only use https://pull.prodigyflo.ai`)
    if (/https?:\/\/records\.prodigyflo\.ai/.test(line)) fail('R-REC-003', `retired host records.prodigyflo.ai added in ${f}`)
  }
}

// R-LANG-001 — Spanish stored as 'es'
const BAD_LANG = /\b(language|locale|lang|scs_locale)\b\s*[:=]\s*['"](spanish|Spanish|es-ES|es-MX|es_ES|es_MX|espa[nñ]ol)['"]/
for (const f of changed) {
  if (!/\.(m?[jt]sx?|sql|py)$/.test(f) || SKIP.test(f) || /\.test\.|\/tests?\//.test(f)) continue
  for (const line of addedLines(f)) if (BAD_LANG.test(line)) fail('R-LANG-001', `language stored as something other than 'es' in ${f}: ${line.trim().slice(0, 80)}`)
}

// R-GOV-008 — client names denylist (file kept OUT of git; CI writes it from secret CANON_DENYLIST)
const denyPath = process.env.CANON_DENYLIST_FILE || '.canon-denylist'
if (existsSync(denyPath)) {
  const names = read(denyPath).split('\n').map(s => s.trim()).filter(s => s.length > 3 && !s.startsWith('#'))
  const res = names.map(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+')}\\b`, 'i'))
  const branch = process.env.GITHUB_HEAD_REF || sh('git rev-parse --abbrev-ref HEAD')
  for (const re of res) if (re.test(branch)) fail('R-GOV-008', `branch name contains a client name`)
  for (const f of changed) {
    if (SKIP.test(f)) continue
    if (res.some(re => re.test(f))) fail('R-GOV-008', `file path contains a client name: ${f}`)
    if (!TEXT.test(f)) continue
    for (const line of addedLines(f)) if (res.some(re => re.test(line))) { fail('R-GOV-008', `client name added in ${f}`); break }
  }
} else warn('R-GOV-008', 'no client denylist present; skipped (set CANON_DENYLIST secret in CI)')

// R-SCOPE-001 — SunOff / DigitalOcean references added
for (const f of changed) {
  if (!TEXT.test(f) || SKIP.test(f) || /SCS-FLO-CANON\.md$|AGENTS\.md$|canon-check\.mjs$/.test(f)) continue
  for (const line of addedLines(f)) {
    if (/SunOff/i.test(line)) fail('R-SCOPE-001', `SunOff reference added in ${f}`)
    if (/digitaloceanspaces\.com|api\.digitalocean\.com|\bdoctl\b/i.test(line)) fail('R-SCOPE-001', `DigitalOcean reference added in ${f}`)
  }
}

// R-GOV-014 — repo scripts must not write outputs into iCloud-synced ~/Desktop or ~/Documents
for (const f of changed) {
  if (!/\.(m?[jt]s|sh|py)$/.test(f) || SKIP.test(f) || f === 'scripts/canon-check.mjs') continue
  for (const line of addedLines(f)) if (/(~|\$HOME|homedir\(\)[^\n]*|\/Users\/[^/'"]+)\/?['"\s,+]*\/?(Desktop|Documents)\//.test(line)) fail('R-GOV-014', `${f} writes to ~/Desktop or ~/Documents (iCloud-synced; use ~/<name>-macbook|-mini/)`)
}

// R-GOV-009 — CLAUDE.md is a pointer, AGENTS.md links the canon
if (existsSync('CLAUDE.md') && read('CLAUDE.md').trim() !== '@AGENTS.md') fail('R-GOV-009', 'CLAUDE.md must contain only "@AGENTS.md"')
if (!/docs\/SCS-FLO-CANON\.md/.test(read('AGENTS.md'))) fail('R-GOV-009', 'AGENTS.md must point to docs/SCS-FLO-CANON.md')
if (!existsSync('docs/SCS-FLO-CANON.md')) fail('R-GOV-012', 'docs/SCS-FLO-CANON.md missing')
else if (!/^Canon-Version: \S+/m.test(read('docs/SCS-FLO-CANON.md'))) fail('R-GOV-012', 'canon has no Canon-Version line')

// R-GOV-010 — canon files changed => must carry the canon trailer (CODEOWNERS approval is the real gate)
const CANON_FILES = /^(docs\/SCS-FLO-CANON\.md|docs\/CANONICAL\.md|docs\/CLIENT-JOURNEY\.md|AGENTS\.md|CLAUDE\.md|CODEOWNERS|\.github\/CODEOWNERS|scripts\/canon-check\.mjs)$/
if (!STAGED && changed.some(f => CANON_FILES.test(f)) && !/^Canon-Change-Approval: CANON OPEN$/m.test(commitMsgs))
  fail('R-GOV-010', `canon/rules files changed (${changed.filter(f => CANON_FILES.test(f)).join(', ')}) without the commit trailer "Canon-Change-Approval: CANON OPEN" typed by Hector`)

// R-GOV-004 — author (CI only; local hook relies on git config)
if (!STAGED && base) {
  const ALLOW = (process.env.CANON_AUTHORS || 'dakotahanshew').split(',').map(s => s.trim().toLowerCase())
  const authors = sh(`git log --format=%an%x09%ae ${base}..HEAD --no-merges`).split('\n').filter(Boolean)
  for (const a of authors) if (!ALLOW.some(x => a.toLowerCase().includes(x))) fail('R-GOV-004', `commit author "${a.split('\t')[0]}" is not dakotahanshew`)
}

// ---- per-app checks ----
if (APP === 'scs') {
  // R-SCS-004 — English copy masters
  const MASTERS = ['copy', 'marketing', 'content', 'scan', 'chat', 'qualify', 'selfcheck', 'privacy', 'terms'].map(n => `src/config/${n}.ts`)
  const touched = changed.filter(f => MASTERS.includes(f))
  if (!STAGED && touched.length && !/^Copy-Master-Approval: COPY MASTER OPEN$/m.test(commitMsgs))
    fail('R-SCS-004', `English copy master changed (${touched.join(', ')}) without the trailer "Copy-Master-Approval: COPY MASTER OPEN" typed by Hector`)
  // R-COPY-001 — extra never-list words beyond check-copy.ts, in source copy files incl. Spanish overlay
  const COPY_FILES = tracked.filter(f => /^src\/config\/.*\.ts$/.test(f))
  const NEVER = [
    [/\b(money[- ]back|full refund|refund(ed|s)?\b)/i, 'refund promise'],
    [/\b(sue|lawsuit|we will cancel|cancel your (contract|loan|agreement))\b/i, 'sue/cancel claim'],
    [/\b(garant[ií]a|garantizad[oa]s?|reembolso|demandar|cancelar su contrato)\b/i, 'Spanish never-list word'],
    [/\bsave\s+\$\s?\d|\bahorr\w*\s+\$\s?\d/i, 'dollar-savings claim'],
    [/\b(lower|reduce|cut)\s+your\s+APR\b/i, 'APR outcome claim'],
  ]
  for (const f of COPY_FILES) {
    if (!changed.includes(f) && !process.argv.includes('--all')) continue
    const t = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/.*$/gm, ' ')
    for (const [re, what] of NEVER) { const m = t.match(re); if (m) fail('R-COPY-001', `${what} "${m[0]}" in ${f} (needs Hector + counsel; add to check-copy APPROVED_EXCEPTIONS only with his approval)`) }
  }
  // R-SCS-002 — journey lock must actually run in CI (needs full history)
  for (const f of tracked.filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f))) {
    const t = read(f)
    if (/npm run check\b/.test(t) && !/fetch-depth:\s*0/.test(t)) fail('R-SCS-002', `${f} runs the journey lock without fetch-depth: 0, so it silently skips`)
  }
}

// R-INT-006 skips this script: it holds both DB refs as patterns.
const SELF = 'scripts/canon-check.mjs'

if (APP === 'pf') {
  // R-META-005 — fixture leads never in prod config
  for (const f of ['vercel.json', '.env.production']) if (/META_FIXTURE_LEADS\s*[:=]\s*["']?true/.test(read(f))) fail('R-META-005', `META_FIXTURE_LEADS=true in ${f}`)
  // R-INT-006 — SCS DB ref must not appear in PF code
  for (const f of changed) if (TEXT.test(f) && !/\.md$/.test(f) && f !== SELF && addedLines(f).some(l => /vspmjtdwlcqfclkgksel/.test(l))) fail('R-INT-006', `SCS database ref added in ProdigyFlo file ${f}`)
  // R-PF-005 — legacy droplet deploy must not grow
  for (const f of changed) if (/^(deploy\/|src\/app\/api\/admin\/deploy\/|src\/lib\/deploy)/.test(f)) warn('R-PF-005', `OFF-LIMITS legacy droplet deploy code changed: ${f} (only the removal PR may touch it)`)
}

if (APP === 'scs') {
  for (const f of changed) if (TEXT.test(f) && !/\.md$/.test(f) && f !== SELF && addedLines(f).some(l => /acgmcenrbwabmpxzgwqb/.test(l))) fail('R-INT-006', `ProdigyFlo database ref added in SCS file ${f}`)
}

if (APP === 'records') {
  // R-REC-002 — bind localhost only
  const svc = read('service.py')
  if (/ThreadingHTTPServer\(\(\s*["'](0\.0\.0\.0|)["']/.test(svc)) fail('R-REC-002', 'service.py binds a public interface; must be 127.0.0.1')
  if (!/records\.prodigyflo\.ai/.test(svc)) fail('R-REC-003', 'service.py lost its wrong_host guard for records.prodigyflo.ai')
  for (const f of tracked) if (/^var\//.test(f) || /^\.venv\//.test(f)) fail('R-SEC-001', `runtime data committed: ${f}`)
}

for (const w of warns) console.warn(`warn  ${w}`)
if (fails.length) {
  console.error(`\ncanon-check FAILED (${APP}) — ${fails.length} violation(s). See docs/SCS-FLO-CANON.md:`)
  for (const f of [...new Set(fails)]) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`canon-check ok (${APP}; ${changed.length} changed file(s) checked${base ? '' : ', no base — full-tree checks only'})`)
