import { db } from '@/lib/db'
import { can, requirePermissionPage } from '@/lib/rbac'
import { assignableRoles, canManageUser } from '@/lib/invites'
import { ROLE_LABELS } from '@/lib/permissions'
import { relativeTime } from '@/lib/format'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { InviteDialog } from './invite-dialog'
import { InviteRowActions, UserRowControls } from './row-controls'
import { AccountRecoveryDialog } from './account-recovery-dialog'

export const metadata = { title: 'Users & access' }

export default async function UsersPage() {
  const user = await requirePermissionPage('users:read')
  const canManage = can(user, 'users:manage')
  const grantable = assignableRoles(user)

  const [users, invites, teams] = await Promise.all([
    db.user.findMany({
      where: { organizationId: user.organizationId, deletedAt: null, role: { key: { not: 'CLIENT' } } },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { role: true, team: { select: { name: true } } },
    }),
    db.invite.findMany({
      where: { organizationId: user.organizationId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { role: true, invitedBy: { select: { name: true } } },
    }),
    db.team.findMany({ where: { organizationId: user.organizationId }, orderBy: { name: 'asc' } }),
  ])

  const now = new Date()

  return (
    <div>
      <PageHeader
        title="Users & access"
        description="Staff accounts, roles, and invitations. You can only grant roles below your own."
        actions={canManage ? (
          <div className="flex items-center gap-2">
            {user.isOwner && <AccountRecoveryDialog />}
            <InviteDialog roles={grantable} teams={teams} />
          </div>
        ) : undefined}
      />

      <div className="space-y-8 p-4 sm:p-6">
        {invites.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold">Pending invites</h2>
            <div className="scroll-x rounded-lg border">
              <table className="w-full min-w-[44rem] text-sm tabular-nums">
                <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Email</th>
                    <th className="px-3 py-2 text-left">Role</th>
                    <th className="px-3 py-2 text-left">Invited by</th>
                    <th className="px-3 py-2 text-left">Expires</th>
                    {canManage && <th className="px-3 py-2 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">
                        {inv.email ?? <span className="text-muted-foreground font-normal">🔗 anyone with the link</span>}
                      </td>
                      <td className="px-3 py-2.5">{inv.role.name}</td>
                      <td className="text-muted-foreground px-3 py-2.5">{inv.invitedBy?.name ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        {inv.expiresAt < now ? (
                          <Badge variant="destructive">expired</Badge>
                        ) : (
                          <span className="text-muted-foreground">{relativeTime(inv.expiresAt)}</span>
                        )}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2.5 text-right">
                          <InviteRowActions inviteId={inv.id} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold">
            Staff <span className="text-muted-foreground font-normal">· {users.length}</span>
          </h2>
          <div className="scroll-x rounded-lg border">
            <table className="w-full min-w-[52rem] text-sm tabular-nums">
              <thead className="text-muted-foreground bg-surface-sunk/80 border-b text-[0.6875rem] font-semibold tracking-[0.06em] uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Email</th>
                  <th className="px-3 py-2 text-left">Role</th>
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-left">Last sign-in</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  {canManage && <th className="px-3 py-2 text-right">Manage</th>}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const manageable = canManage && canManageUser(user, { id: u.id, roleKey: u.role.key, isOwner: u.isOwner })
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="px-3 py-2.5 font-medium">
                        {u.name}
                        {u.id === user.id && <span className="text-muted-foreground ml-1.5 text-xs">(you)</span>}
                      </td>
                      <td className="text-muted-foreground px-3 py-2.5">{u.email}</td>
                      <td className="px-3 py-2.5">{ROLE_LABELS[u.role.key]}</td>
                      <td className="text-muted-foreground px-3 py-2.5">{u.team?.name ?? '—'}</td>
                      <td className="text-muted-foreground px-3 py-2.5">
                        {u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'never'}
                      </td>
                      <td className="px-3 py-2.5">
                        {u.isActive ? <Badge variant="secondary">active</Badge> : <Badge variant="destructive">deactivated</Badge>}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2.5 text-right">
                          {manageable ? (
                            <UserRowControls
                              userId={u.id}
                              currentRole={u.role.key}
                              isActive={u.isActive}
                              roles={grantable}
                            />
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
