/**
 * Lets an operator script (run with `npx tsx`) load app modules that start
 * with `import 'server-only'`. That marker throws outside a React Server
 * environment; here it resolves to the same no-op stub Vitest uses
 * (tests/stubs/server-only.ts). Import this FIRST, then load app modules with
 * dynamic import() so the hook is in place before they resolve.
 */
import 'dotenv/config'
import Module from 'node:module'
import path from 'node:path'

type Resolve = (request: string, ...rest: unknown[]) => string
const mod = Module as unknown as { _resolveFilename: Resolve }
const original = mod._resolveFilename
const stub = path.join(__dirname, '..', '..', 'tests', 'stubs', 'server-only.ts')

mod._resolveFilename = function resolveServerOnly(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'server-only') return stub
  return original.call(this, request, ...rest)
}
