import 'dotenv/config'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { mergeWorkspace } from './workspace-merge'
import { isLocalDatabaseUrl, pgSsl } from '../src/lib/pg-env'

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const sourceId = option('--source'), targetId = option('--target')
  if (!sourceId || !targetId) throw new Error('Usage: tsx scripts/merge-workspaces.ts --source ID --target ID [--commit --evidence private-file.json]')
  const connectionString = process.env.MIGRATION_DATABASE_URL
  if (!connectionString) throw new Error('Set MIGRATION_DATABASE_URL explicitly; DATABASE_URL is never used implicitly.')
  const commit = args.includes('--commit')
  if (commit && !isLocalDatabaseUrl(connectionString)) {
    if (new URL(connectionString).port !== '5432') throw new Error('Use a direct database connection on port 5432, not a transaction pooler.')
    const evidencePath = option('--evidence')
    if (!evidencePath) throw new Error('Remote commit requires a reviewed backup/rehearsal/Preview evidence file; see docs/WORKSPACE-CLEANUP.md.')
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (evidence.sourceId !== sourceId || evidence.targetId !== targetId || evidence.revision !== revision) throw new Error('Evidence does not match these organizations and this code revision.')
    if (evidence.restoreVerified !== true || evidence.previewVerified !== true || evidence.writesAndJobsPaused !== true) throw new Error('Restore, isolated Preview, and controlled write/job pause must be verified before commit.')
    const age = Date.now() - Date.parse(evidence.createdAt)
    if (!Number.isFinite(age) || age < 0 || age > 24 * 3600_000) throw new Error('Backup evidence must be less than 24 hours old.')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(evidence.backupPath)) hash.update(chunk)
    if (hash.digest('hex') !== evidence.backupSha256) throw new Error('Backup file checksum mismatch.')
  }
  const pool = new Pool({ connectionString, ssl: pgSsl(connectionString), max: 1 })
  const pg = await pool.connect()
  try { console.log(JSON.stringify(await mergeWorkspace(pg, { sourceId, targetId, commit }), null, 2)) }
  finally { pg.release(); await pool.end() }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
