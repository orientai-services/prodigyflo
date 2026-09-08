import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/rbac'
import { getDeployStatus, getVersionInfo, listDeployRuns, listOpsCommands } from '@/lib/deploy'
import { DeployConsole, type DeployConsoleVM } from './deploy-console'

/**
 * Server half of the console: gathers version info (including the one git
 * fetch per page load), current deploy state and history, and hands a fully
 * serialized VM to the client island. Rendered only as a child of
 * <StepUpGate scope="deploy"> — but it still re-gates isOwner itself, because
 * children of a gate must never rely on the parent for authority.
 */
export async function DeployPanel() {
  const user = await requireUser()
  if (!user.isOwner) redirect('/forbidden')

  const [version, status, history] = await Promise.all([
    getVersionInfo(),
    getDeployStatus(),
    listDeployRuns(user),
  ])

  const vm: DeployConsoleVM = {
    mode: status.mode,
    version: {
      branch: version.branch,
      localCommit: version.localCommit,
      originCommit: version.originCommit,
      builtAt: version.builtAt,
      inSync: version.inSync,
    },
    service: { active: status.service.active, detail: status.service.detail },
    currentRun: status.currentRun,
    lastFinished: status.lastFinished,
    history,
    opsCommands: listOpsCommands(),
  }

  return <DeployConsole vm={vm} />
}
