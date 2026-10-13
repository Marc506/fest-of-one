import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'
import { currentUser } from '@/lib/api'
import { signOut } from '@/auth'

export const metadata: Metadata = {
  title: '一个人的影展 · fest-of-one',
  description: '读完你的全部观影记录，每周为你一个人策一场影展。',
}

const NAV = [
  { href: '/plan', label: '本周计划' },
  { href: '/history', label: '历次影展' },
  { href: '/library', label: '片库' },
  { href: '/taste', label: '画像' },
  { href: '/settings', label: '设置' },
]

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        <header className="border-b border-rule">
          <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
            <Link href={user ? '/plan' : '/'} className="font-serif text-lg tracking-wide">
              一个人的影展
            </Link>
            {user && (
              <nav className="flex flex-1 flex-wrap gap-4 text-sm text-muted">
                {NAV.map((n) => (
                  <Link key={n.href} href={n.href} className="hover:text-ink">
                    {n.label}
                  </Link>
                ))}
              </nav>
            )}
            {user && (
              <form
                action={async () => {
                  'use server'
                  await signOut({ redirectTo: '/' })
                }}
              >
                <button className="text-sm text-muted hover:text-ink" title={user.email ?? ''}>
                  退出
                </button>
              </form>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  )
}
