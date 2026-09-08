import type { NextRequest } from 'next/server'
import { runOpsCommand } from '@/lib/deploy'
import { guardDeploy } from '../guard'

/**
 * POST /api/admin/deploy/ops — run ONE read-only ops command by allowlist key.
 * The body carries only a key; the argv comes from the frozen registry in
 * src/lib/deploy.ts (exact arrays, execFile, no shell) — nothing user-supplied
 * is ever interpolated. Unknown keys → 400. Explicitly NOT here: seed, vitest,
 * reports build, nginx writes.
 */
export async function POST(req: NextRequest) {
  const gate = await guardDeploy()
  if (!gate.ok) return gate.response

  let key = ''
  try {
    const body = (await req.json()) as { command?: unknown }
    if (typeof body.command === 'string') key = body.command
  } catch {
    // fall through to the 400 below
  }

  const result = await runOpsCommand(key)
  if (!result) return Response.json({ error: 'Unknown command.' }, { status: 400 })
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
