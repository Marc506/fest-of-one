import { requirePageUser } from '@/lib/session'
import { DemoJobButton } from '../_components/DemoJobButton'

export default async function PlanPage() {
  const user = await requirePageUser()
  return (
    <div className="space-y-8">
      <h1 className="font-serif text-3xl">本周计划</h1>
      <p className="text-muted">你好，{user.name ?? user.email}。可用时间与生成影展将在 M4 接入。</p>
      {process.env.DEV_LOGIN === '1' && (
        <section className="rounded border border-rule p-4">
          <h2 className="mb-3 text-sm font-medium">开发：任务队列自检</h2>
          <DemoJobButton />
        </section>
      )}
    </div>
  )
}
