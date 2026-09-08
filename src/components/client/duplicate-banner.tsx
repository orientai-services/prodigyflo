import Link from 'next/link'
import { Users } from 'lucide-react'
import { db } from '@/lib/db'
import { findDuplicates } from '@/lib/dedupe'
import { findClientInScope, requireUser } from '@/lib/rbac'
import { fullName } from '@/lib/format'

/**
 * Warns when this record looks like the same person as another client the
 * viewer can name. Read-only by design: merging is a deliberate manual act.
 */
export async function DuplicateBanner({ clientId }: { clientId: string }) {
  const user = await requireUser()
  const client = await findClientInScope(user, clientId)
  if (!client) return null
  const primaryAddress = await db.clientAddress.findFirst({
    where: { clientId: client.id },
    orderBy: { isPrimary: 'desc' },
    select: { postalCode: true },
  })

  const { exact, possible } = await findDuplicates(
    db,
    user.organizationId,
    {
      email: client.email,
      phone: client.phone,
      firstName: client.firstName,
      lastName: client.lastName,
      postalCode: primaryAddress?.postalCode ?? null,
    },
    { excludeClientId: client.id },
  )

  const matches = [...exact, ...possible]
  if (matches.length === 0) return null

  return (
    <div className="border-warning/40 bg-warning/10 mx-4 mt-4 rounded-lg border px-4 py-3 sm:mx-6">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Users className="size-4" />
        Possible duplicate record{matches.length === 1 ? '' : 's'}
      </p>
      <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
        {matches.map((m) => (
          <li key={m.client.id}>
            <Link href={`/clients/${m.client.id}`} className="text-foreground font-medium underline underline-offset-2">
              {fullName(m.client)}
            </Link>{' '}
            matches on {m.matchedOn === 'name_postal' ? 'name + postal code' : m.matchedOn}
            {m.matchedOn === 'email' ? ` (${m.client.email})` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
