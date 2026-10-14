import { redirect } from 'next/navigation'
import { availableProviders, signIn } from '@/auth'
import { currentUser } from '@/lib/api'

export default async function Home() {
  const user = await currentUser()
  if (user) redirect('/plan')
  const p = availableProviders()
  return (
    <div className="mx-auto max-w-2xl py-16">
      <h1 className="font-serif text-4xl leading-tight">一个人的影展</h1>
      <p className="mt-6 leading-8 text-muted">
        把 Letterboxd / 豆瓣的观影记录接进来。系统读完你看过的每一部片，自己决定这周放什么——
        一位导演的切片、一个国家的某段年代、一位演员的某种表演，或者围绕「衣服」「土地」这样的母题做一个专题——
        写好策展陈述和场刊，排进你空出来的晚上，一键加入日历。
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        {p.google && (
          <form
            action={async () => {
              'use server'
              await signIn('google', { redirectTo: '/plan' })
            }}
          >
            <button className="rounded-full bg-ink px-5 py-2 text-paper">用 Google 登录</button>
          </form>
        )}
        {p.dev && (
          // API 路由需要整页跳转（设置 cookie 后重定向），不能用 <Link>
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a href="/api/auth/dev" className="rounded-full border border-ink px-5 py-2">
            开发登录（dev@local）
          </a>
        )}
        {!p.google && !p.dev && (
          <p className="text-sm text-accent">未配置任何登录方式：请设置 AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET，或本地 DEV_LOGIN=1。</p>
        )}
      </div>
    </div>
  )
}
