import type { ReactNode } from 'react'
import { requireUser } from '@/lib/rbac'
import { hasStepUp, type PasswordStepUpScope } from '@/lib/stepup'
import { StepUpPrompt } from './stepup-prompt'

/**
 * Server component gate for step-up-protected content (the credential vault,
 * the deploy console). The probe runs here on the server, and the children are
 * rendered — and therefore serialized into the RSC payload — ONLY once the
 * viewer holds a fresh grant, so locked content never rides to the browser.
 *
 * Usage, inside a page that has already passed its permission gate:
 *
 *   <StepUpGate scope="vault">
 *     <CredentialsCard ... />
 *   </StepUpGate>
 *
 * The backing server actions must still call requireStepUp(user, scope)
 * themselves — this gate is UX, the action check is the security boundary.
 */
export async function StepUpGate({
  scope,
  children,
}: {
  scope: PasswordStepUpScope
  children: ReactNode
}) {
  const user = await requireUser()
  if (await hasStepUp(user, scope)) return <>{children}</>
  return <StepUpPrompt scope={scope} />
}
