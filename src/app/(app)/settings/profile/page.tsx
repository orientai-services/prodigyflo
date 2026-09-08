import { db } from '@/lib/db'
import { requireUser } from '@/lib/rbac'
import { emailDomain, emailRoutingConfigured } from '@/lib/email-routing'
import { isMockMode } from '@/lib/messaging'
import { maskEmail } from '@/lib/crypto'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth-tokens'
import { PageHeader } from '@/components/page-header'
import { AvatarCard } from './avatar-card'
import { PasswordCard } from './password-card'
import { ForwardingCard, IdentityCard, SignatureCard } from './profile-cards'

export const metadata = { title: 'My profile' }

export default async function ProfilePage() {
  const session = await requireUser()
  const user = await db.user.findUniqueOrThrow({
    where: { id: session.id },
    select: {
      name: true, nickname: true, title: true, phone: true, email: true, avatarUrl: true,
      emailAlias: true, forwardingEmail: true, forwardingStatus: true,
      signatureStyle: true, signatureIncludePhone: true,
    },
  })

  return (
    <div>
      <PageHeader
        title="My profile"
        description="How you appear across the app and in every email you send."
      />
      <div className="mx-auto grid max-w-3xl gap-4 p-4 sm:p-6">
        <AvatarCard initial={{ name: user.name, avatarUrl: user.avatarUrl }} />
        <IdentityCard
          initial={{
            name: user.name,
            nickname: user.nickname ?? '',
            title: user.title ?? '',
            phone: user.phone ?? '',
          }}
        />
        <ForwardingCard
          domain={emailDomain()}
          configured={emailRoutingConfigured()}
          initial={{
            emailAlias: user.emailAlias ?? '',
            forwardingEmail: user.forwardingEmail ?? user.email,
            status: user.forwardingStatus as 'none' | 'pending' | 'active',
          }}
        />
        <SignatureCard
          domain={emailDomain()}
          organizationName={session.organizationName}
          initial={{
            name: user.name,
            nickname: user.nickname ?? '',
            title: user.title ?? '',
            phone: user.phone ?? '',
            emailAlias: user.emailAlias ?? '',
            style: (user.signatureStyle as 'formal' | 'friendly') ?? 'formal',
            includePhone: user.signatureIncludePhone,
          }}
        />
        <PasswordCard
          minLength={PASSWORD_MIN_LENGTH}
          emailMock={isMockMode('EMAIL')}
          maskedEmail={maskEmail(user.email)}
        />
      </div>
    </div>
  )
}
