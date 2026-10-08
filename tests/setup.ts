import 'dotenv/config'

// Vitest already sets NODE_ENV=test. `server-only` is aliased to a no-op stub in
// vitest.config.mts, since our server modules import it but are loaded directly here.

// Telephony keys for the test run only (never real values). PHONE_HASH_KEY keys
// the do-not-call hashes; without it every outbound check fails closed.
process.env.PHONE_HASH_KEY ??= 'test-only-phone-hash-key-0123456789abcdef'
process.env.TELEPHONY_OVERRIDE_KEY ??= 'test-only-override-key-0123456789abcdef'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to run the test suite (see .env.example).')
}
