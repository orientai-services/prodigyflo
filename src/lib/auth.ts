import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { db } from '@/lib/db'
import { consumeAuthToken } from '@/lib/auth-tokens'

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const magicSchema = z.object({ magicToken: z.string().min(20) })

/**
 * Auth.js supplies identity only. Authorization data (role, permissions, scope)
 * is loaded fresh from the database on every server request by `requireUser()`,
 * so deactivating a user or changing a role takes effect immediately rather than
 * when a stale token happens to expire.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt', maxAge: 60 * 60 * 12 },
  pages: { signIn: '/login', error: '/login' },
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, magicToken: {} },
      authorize: async (raw) => {
        // Two ways in through the ONE provider: {email,password} or a
        // {magicToken} minted by requestMagicLinkAction. The token path
        // delegates every check to consumeAuthToken — atomic single-use
        // claim, expiry, kind, isActive + deletedAt — so a link is exactly
        // as trustworthy as a fresh password.
        const magicRaw = (raw as Record<string, unknown>).magicToken
        if (typeof magicRaw === 'string' && magicRaw.length > 0) {
          const magic = magicSchema.safeParse({ magicToken: magicRaw })
          if (!magic.success) return null

          const user = await consumeAuthToken(magic.data.magicToken, 'MAGIC_LINK')
          if (!user) return null

          await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
          return { id: user.id, email: user.email, name: user.name }
        }

        const parsed = credentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const email = parsed.data.email.toLowerCase().trim()
        // Login is org-blind: email uniqueness is enforced GLOBALLY at every
        // user-creation path (src/lib/invites.ts), so at most one live row can
        // match. orderBy is a determinism backstop should legacy duplicates
        // exist — the oldest account (first to claim the email) wins.
        const user = await db.user.findFirst({
          where: { email, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, email: true, name: true, passwordHash: true, isActive: true },
        })

        // Compare against a dummy hash when the user is missing so that a bad
        // email and a bad password take the same amount of time.
        const hash = user?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu'
        const ok = await bcrypt.compare(parsed.data.password, hash)

        if (!user || !ok || !user.isActive) return null

        await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

        return { id: user.id, email: user.email, name: user.name }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id
      return token
    },
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string
      return session
    },
  },
})
