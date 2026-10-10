/**
 * Import the platform Twilio subaccount's numbers into their organizations.
 *
 *   npx tsx scripts/telephony-sync-numbers.ts                     dry run (default)
 *   npx tsx scripts/telephony-sync-numbers.ts --execute           import
 *   npx tsx scripts/telephony-sync-numbers.ts --execute --repoint import + point here
 *
 * Uses the platform env credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)
 * only, and imports ONLY the sid → organization pairs the platform owner put
 * in the assignment map (Call Center → Phone setup → Sync). There is no --org:
 * a number is never imported into an organization it was not assigned to.
 * --repoint touches only numbers that point nowhere or already at APP_URL.
 *
 * Prints counts and a table with numbers masked to the last four and SIDs
 * shortened. Idempotent: a second --execute changes nothing.
 */
import './lib/server-script'

const execute = process.argv.includes('--execute')
const repoint = process.argv.includes('--repoint')

function shortSid(sid: string): string {
  return sid.length > 10 ? `${sid.slice(0, 4)}…${sid.slice(-4)}` : sid
}

async function main() {
  const { syncNumbersForScript } = await import('../src/lib/telephony/number-sync')
  const out = await syncNumbersForScript({ execute, repoint })
  if (!out.ok) throw new Error(out.error)

  console.log(`Account ${out.preview.account} — ${execute ? 'EXECUTE' : 'dry run'}${repoint ? ' + repoint' : ''}`)
  console.table(
    out.preview.rows.map((r) => ({
      sid: shortSid(r.sid),
      number: r.display.replace(/^.*(\d{4})$/, '•••-•••-$1'),
      state: r.state,
      account: r.assignedOrg?.name ?? '',
      pointsHere: r.pointsHere,
    })),
  )
  if ('result' in out && out.result) {
    console.log(
      JSON.stringify({ imported: out.result.imported, updated: out.result.updated, repointed: out.result.repointed, skipped: out.result.skipped.length }),
    )
  } else if ('wouldImport' in out) {
    console.log(JSON.stringify({ wouldImport: out.wouldImport.length, wouldRepoint: out.wouldRepoint.length }))
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
