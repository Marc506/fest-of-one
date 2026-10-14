import Link from 'next/link'
import { getAvailability, resolveAvailability } from '@/db/repo/availability'
import { recentProgrammes } from '@/db/repo/festivals'
import { libraryCounts } from '@/db/repo/library'
import { latestTasteProfile } from '@/db/repo/taste'
import { allowedWeeks } from '@/festival/service'
import { requirePageUser } from '@/lib/session'
import { addDays } from '@/scheduler/slots'
import { PlanEditor } from './PlanEditor'

export const dynamic = 'force-dynamic'

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requirePageUser()
  const sp = await searchParams
  const [thisWeek, nextWeek] = allowedWeeks(user)
  const weekStart = sp.week === nextWeek ? nextWeek! : thisWeek!
  const counts = libraryCounts(user.id)
  const profile = latestTasteProfile(user.id)
  const initial = resolveAvailability(user.id, weekStart)
  const tpl = getAvailability(user.id, 'template')
  const thisWeeks = recentProgrammes(user.id, { sinceWeek: weekStart }).filter((h) => h.weekStart === weekStart)
  // 回访（1.1 第 6 步）：上周的影展还有没反馈的场次
  const lastWeek = recentProgrammes(user.id, { sinceWeek: addDays(thisWeek!, -7), beforeWeek: thisWeek! }).find((h) => h.films.some((f) => !f.feedback))
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-3xl">本周计划</h1>
        <p className="mt-2 text-sm text-muted">
          涂出这一周能看电影的时间，告诉策展人想看几天、几部。影展类型由策展人决定——不满意就「换一个」。
        </p>
      </header>

      {counts.films === 0 ? (
        <p className="rounded border border-rule p-4 text-sm">
          策展人还没读过你的观影记录。先去 <Link className="underline" href="/onboarding">接入 Letterboxd / 豆瓣</Link>。
        </p>
      ) : !profile ? (
        <p className="rounded border border-rule p-4 text-sm">
          画像还在生成中，去 <Link className="underline" href="/taste">画像</Link> 看看进度。
        </p>
      ) : null}

      {lastWeek && (
        <div className="rounded border border-accent/50 p-4 text-sm">
          上周的「
          <Link href={`/festival/${lastWeek.festivalId}`} className="font-serif underline">
            {lastWeek.title}
          </Link>
          」看了吗？去勾一下「看了 / 没看 / 不感兴趣」——这会影响下一次策展。
        </div>
      )}

      {thisWeeks.length > 0 && (
        <div className="rounded border border-ink p-4 text-sm">
          这周已经有：
          {thisWeeks.map((h) => (
            <Link key={h.festivalId} href={`/festival/${h.festivalId}`} className="ml-2 font-serif underline">
              {h.title}
            </Link>
          ))}
          <span className="ml-2 text-muted">（重新生成会再出一个）</span>
        </div>
      )}

      <PlanEditor
        weekStart={weekStart}
        weeks={[
          { value: thisWeek!, label: `本周 ${thisWeek!.slice(5)}` },
          { value: nextWeek!, label: `下周 ${nextWeek!.slice(5)}` },
        ]}
        dates={dates}
        initial={initial}
        template={tpl ? { mode: tpl.mode, blocks: tpl.blocks } : null}
        defaults={{ days: 3, filmCount: 4 }}
      />
    </div>
  )
}
