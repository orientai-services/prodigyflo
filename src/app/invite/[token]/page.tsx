import { BrandMark } from '@/components/brand-mark'
import { findLiveInvite } from '@/lib/invites'
import { ROLE_LABELS } from '@/lib/permissions'
import { AcceptForm } from './accept-form'

export const metadata = { title: 'Join your team' }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invite = await findLiveInvite(token)

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <BrandMark className="mb-8" />
        {invite ? (
          <>
            <h1 className="text-xl font-semibold">Join {invite.organization.name}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              You&apos;ve been invited as <b className="text-foreground">{ROLE_LABELS[invite.role.key]}</b>
              {invite.email ? (
                <> using <b className="text-foreground">{invite.email}</b></>
              ) : null}
              . Choose your {invite.email ? '' : 'email, '}name and a password to finish setting up
              your account.
            </p>
            <AcceptForm token={token} askEmail={!invite.email} />
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">This invite isn&apos;t valid</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              The link is expired, revoked, or already used. Ask the person who invited you to send
              a fresh one from Settings → Users &amp; access.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
