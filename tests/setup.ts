import 'dotenv/config'

// Vitest already sets NODE_ENV=test. `server-only` is aliased to a no-op stub in
// vitest.config.mts, since our server modules import it but are loaded directly here.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to run the test suite (see .env.example).')
}
