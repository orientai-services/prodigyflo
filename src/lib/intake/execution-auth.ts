import { cronAuthorized } from '@/lib/cron-auth'

/**
 * The one-case importer is an operator action, not another scheduler. Reuse
 * the existing Vercel Cron credential rather than relying on a short-lived
 * Stage 0 environment variable that can be accidentally saved as an empty
 * string during a deploy.
 */
export function executionAuthorized(request: Request): boolean {
  return cronAuthorized(request)
}
