/**
 * Backfill CallCenterLead.phoneHash after the telephony migration (§2.14).
 *
 *   npx tsx scripts/telephony-backfill-phone-hash.ts            dry run (default)
 *   npx tsx scripts/telephony-backfill-phone-hash.ts --execute  write
 *
 * Needs PHONE_HASH_KEY and VAULT_KEY (to read the stored phone). Prints counts
 * only — never a number. Rows whose phone won't normalize are counted and left
 * alone. Running it twice changes nothing the second time.
 */
import './lib/server-script'

const execute = process.argv.includes('--execute')

async function main() {
  const { backfillLeadPhoneHashes } = await import('../src/lib/telephony/backfill')
  const counts = await backfillLeadPhoneHashes({ execute })
  console.log(JSON.stringify(counts))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
