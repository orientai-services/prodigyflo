/**
 * Dev-only. Mints a Twilio Voice access token OFFLINE with twilio-node's own
 * AccessToken + VoiceGrant, using a fixed fake key, secret, identity and clock,
 * and writes its decoded header + payload to tests/fixtures/twilio-access-token.json.
 * src/lib/telephony/access-token.test.ts compares our jose-minted token with it
 * field by field. Never imported by the app; makes no network call to Twilio.
 *
 *   npx -y -p twilio@5 node scripts/dev/make-access-token-fixture.mjs
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', '..', 'tests', 'fixtures', 'twilio-access-token.json')

// `npx -p twilio` puts the package's node_modules/.bin on PATH but not on the
// module path, so find twilio next to that .bin directory.
function loadTwilio() {
  const require = createRequire(import.meta.url)
  try {
    return require('twilio')
  } catch {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!/node_modules[\\/]\.bin$/.test(dir)) continue
      try {
        return createRequire(path.join(dir, '..', 'noop.js'))('twilio')
      } catch {
        // keep looking
      }
    }
    throw new Error('Run with: npx -y -p twilio@5 node scripts/dev/make-access-token-fixture.mjs')
  }
}

const INPUT = {
  accountSid: 'AC00000000000000000000000000000000',
  apiKeySid: 'SK00000000000000000000000000000000',
  apiKeySecret: 'fixture-secret-not-real-0123456789',
  appSid: 'AP00000000000000000000000000000000',
  identity: 'pf_orgfixture_userfixture',
  ttl: 3600,
  nowSeconds: 1791460800, // 2026-10-08T12:00:00Z
}

const twilio = loadTwilio()
const realNow = Date.now
Date.now = () => INPUT.nowSeconds * 1000
let token
try {
  const { AccessToken } = twilio.jwt
  const grant = new AccessToken.VoiceGrant({ outgoingApplicationSid: INPUT.appSid, incomingAllow: true })
  const at = new AccessToken(INPUT.accountSid, INPUT.apiKeySid, INPUT.apiKeySecret, { identity: INPUT.identity, ttl: INPUT.ttl })
  at.addGrant(grant)
  token = at.toJwt()
} finally {
  Date.now = realNow
}

const [h, p] = token.split('.')
const decode = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
const fixture = {
  note: 'Decoded from a token minted offline by twilio-node AccessToken + VoiceGrant (scripts/dev/make-access-token-fixture.mjs). Fake key and secret.',
  twilioVersion: process.env.TWILIO_NODE_VERSION ?? null, // the committed fixture records 5.13.1
  input: INPUT,
  header: decode(h),
  payload: decode(p),
}
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(`wrote ${path.relative(process.cwd(), out)}`)
