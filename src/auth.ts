/**
 * Auth.js v5 配置：Google provider（之后增量授权 Google Calendar）+ 本地 DEV_LOGIN 直登。
 * 会话用 JWT（Credentials provider 要求）；账户与 Google refresh token 由 Drizzle adapter 落库。
 */
import NextAuth, { type NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { getDb } from '@/db/client'
import { accounts, sessions, users, verificationTokens } from '@/db/schema'
import { upsertUserByEmail } from '@/db/repo/users'

export const DEV_EMAIL = 'dev@local'

function providers(): NextAuthConfig['providers'] {
  const list: NextAuthConfig['providers'] = []
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    list.push(Google({ allowDangerousEmailAccountLinking: false }))
  }
  if (process.env.DEV_LOGIN === '1') {
    list.push(
      Credentials({
        id: 'dev',
        name: 'Dev login',
        credentials: {},
        authorize: async () => {
          const u = upsertUserByEmail(DEV_EMAIL, 'Dev')
          return { id: u.id, email: u.email, name: u.name }
        },
      }),
    )
  }
  return list
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt' },
  trustHost: true,
  providers: providers(),
  pages: { signIn: '/' },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id
      return token
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub
      return session
    },
  },
}))

export function availableProviders(): { google: boolean; dev: boolean } {
  return {
    google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
    dev: process.env.DEV_LOGIN === '1',
  }
}
