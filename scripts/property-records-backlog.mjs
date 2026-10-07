/** Read-only counts of open property-records jobs. Never updates or deletes. */
import pg from 'pg'

const {Client} = pg
const PREVIEW_DATABASE = 'pf_e2e_01a0b8f2'
const OPEN = ['PENDING', 'RUNNING', 'FAILED', 'PAUSED']

function redact(error) {
  const message = error instanceof Error ? error.message : 'query failed'
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set')
    process.exitCode = 1
    return
  }
  const local = /localhost|127\.0\.0\.1/.test(connectionString)
  const client = new Client({
    connectionString,
    ssl: local ? undefined : {rejectUnauthorized: false},
  })
  await client.connect()
  try {
    const who = await client.query('SELECT current_database() AS name')
    const name = who.rows[0].name
    if (name !== PREVIEW_DATABASE) {
      console.error(`Refusing to read jobs: connected database is not ${PREVIEW_DATABASE}`)
      process.exitCode = 2
      return
    }
    const summary = await client.query(
      `SELECT status,
              count(*)::int AS jobs,
              COALESCE(EXTRACT(EPOCH FROM (now() - min("updatedAt")))::int, 0) AS oldest_age_seconds,
              COALESCE(EXTRACT(EPOCH FROM (now() - max("updatedAt")))::int, 0) AS newest_age_seconds
         FROM "PropertyRecordsJob"
        WHERE status = ANY($1::text[])
        GROUP BY status
        ORDER BY status`,
      [OPEN],
    )
    const rows = await client.query(
      `SELECT id, status, attempts,
              EXTRACT(EPOCH FROM (now() - "createdAt"))::int AS created_age_seconds,
              EXTRACT(EPOCH FROM (now() - "updatedAt"))::int AS updated_age_seconds
         FROM "PropertyRecordsJob"
        WHERE status = ANY($1::text[])
        ORDER BY status, "updatedAt"
        LIMIT 50`,
      [OPEN],
    )
    const counts = Object.fromEntries(OPEN.map((status) => [status, 0]))
    for (const row of summary.rows) counts[row.status] = row.jobs
    console.log(JSON.stringify({
      database: name,
      read_only: true,
      counts,
      ages: summary.rows,
      jobs: rows.rows,
    }, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(redact(error))
  process.exitCode = 1
})
