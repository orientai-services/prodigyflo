/**
 * Generates src/lib/telephony/data/nanp-timezones.json from Google
 * libphonenumber's resources/timezones/map_data.txt (Apache-2.0) — the data
 * behind PhoneNumberToTimeZonesMapper. Nothing in that file is typed by hand.
 *
 *   curl -o map_data.txt https://raw.githubusercontent.com/google/libphonenumber/<commit>/resources/timezones/map_data.txt
 *   npx tsx scripts/gen-nanp-timezones.ts map_data.txt <commit>
 *
 * Only +1 (NANP) prefixes of at least one full area code are kept. The bare
 * country-code entry ("1" → every NANP zone) is dropped on purpose: a number
 * whose area code is missing from the data is UNKNOWN, never "every zone".
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.join(__dirname, '..', 'src', 'lib', 'telephony', 'data', 'nanp-timezones.json')

function main() {
  const [file, commit] = process.argv.slice(2)
  if (!file || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Usage: tsx scripts/gen-nanp-timezones.ts <map_data.txt> <40-char libphonenumber commit>')
  }
  const raw = readFileSync(file)
  const sha256 = createHash('sha256').update(raw).digest('hex')

  const entries: Record<string, string[]> = {}
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    const m = /^(1\d{3,})\|(.+)$/.exec(line.trim())
    if (!m) continue
    entries[m[1]] = m[2].split('&').map((z) => z.trim()).filter(Boolean).sort()
  }

  const doc = {
    source: `https://raw.githubusercontent.com/google/libphonenumber/${commit}/resources/timezones/map_data.txt`,
    commit,
    sha256,
    generated: new Date().toISOString().slice(0, 10),
    license: 'Apache-2.0 (Copyright (C) 2012 The Libphonenumber Authors)',
    count: Object.keys(entries).length,
    entries,
  }
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`)
  console.log(`Wrote ${doc.count} NANP prefixes (sha256 ${sha256.slice(0, 12)}…) to ${path.relative(process.cwd(), OUT)}`)
}

main()
