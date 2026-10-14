import Link from 'next/link'
import { listFestivalHistory } from '@/db/repo/festivals'
import { feedbackSummary } from '@/festival/feedback'
import { requirePageUser } from '@/lib/session'
import { KIND_LABEL, STATUS_LABEL } from '../_components/labels'
import { Badge } from '../_components/ui'

export const dynamic = 'force-dynamic'

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requirePageUser()
  const all = (await searchParams).all === '1'
  const rows = listFestivalHistory(user.id, { includeDismissed: all })
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-serif text-3xl">历次影展</h1>
        <Link href={all ? '/history' : '/history?all=1'} className="text-sm text-muted underline">
          {all ? '隐藏换掉的' : '也显示换掉的'}
        </Link>
      </header>
      {rows.length === 0 ? (
        <p className="py-12 text-center text-muted">
          还没有影展。去 <Link className="underline" href="/plan">本周计划</Link> 生成第一个。
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {rows.map(({ festival: f, weekStart: week, feedback }) => {
            const fb = feedbackSummary(feedback.map((x) => ({ feedback: x })))
            const total = fb.watched + fb.skipped + fb.not_interested + fb.none
            return (
              <li key={f.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-4">
                <span className="w-24 shrink-0 text-sm tabular-nums text-muted">{week}</span>
                <span className="w-20 shrink-0 text-xs text-muted">{KIND_LABEL[f.kind]}</span>
                <Link href={`/festival/${f.id}`} className={`min-w-0 flex-1 font-serif text-lg hover:underline ${f.status === 'dismissed' ? 'text-muted line-through' : ''}`}>
                  {f.kind === 'single' ? `《${f.title}》` : f.title}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <Badge tone={f.status === 'published' ? 'ink' : 'muted'}>{STATUS_LABEL[f.status]}</Badge>
                  {f.status !== 'dismissed' && (
                    <span>
                      看了 {fb.watched}/{total}
                      {fb.skipped > 0 && ` · 没看 ${fb.skipped}`}
                      {fb.not_interested > 0 && ` · 不感兴趣 ${fb.not_interested}`}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
