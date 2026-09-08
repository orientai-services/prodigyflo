import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/rbac'
import { homeFor } from '@/lib/permissions'

export default async function RootPage() {
  const user = await getSessionUser()
  redirect(user ? homeFor(user) : '/login')
}
