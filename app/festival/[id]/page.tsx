import Link from 'next/link'
import { notFound } from 'next/navigation'
import { formatInTimeZone } from 'date-fns-tz'
import { festivalsForRequest, getFestivalForUser, getFestivalRequest, getScreenings } from '@/db/repo/festivals'
import { getFilms } from '@/db/repo/library'
import type { Film } from '@/db/schema'
import { MAX_REROLLS } from '@/festival/service'
import { requirePageUser } from '@/lib/session'
import { Poster } from '../../_components/Poster'
import { Badge } from '../../_components/ui'
import { RerollButton } from './RerollButton'

export const dynamic = 'force-dynamic'

const KIND_LABEL = { director: '导演回顾', country: '国别 · 时代', actor: '演员回顾', motif: '专题', single: '本周一部' } as const
const ROLE_LABEL = { opening: '开幕', centerpiece: '中场', closing: '闭幕', regular: '' } as const
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const filmTitle = (f: Film) => f.titleZh ?? f.titleEn

export default async function FestivalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) notFound()
  const req = getFestivalRequest(f.requestId)
  const screenings = getScreenings(f.id)
  const films = new Map(getFilms(screenings.map((s) => s.tmdbId)).map((m) => [m.tmdbId, m]))
  const single = f.kind === 'single'
  const newer = f.status === 'dismissed' ? festivalsForRequest(f.requestId).find((x) => x.status !== 'dismissed') : undefined
  const tz = user.tz

  const scheduled = screenings.filter((s) => s.startsAt).sort((a, b) => a.startsAt!.localeCompare(b.startsAt!))
  const unscheduled = screenings.filter((s) => !s.startsAt)
  const byDay = new Map<string, typeof scheduled>()
  for (const s of scheduled) {
    const day = formatInTimeZone(s.startsAt!, tz, 'yyyy-MM-dd')
    byDay.set(day, [...(byDay.get(day) ?? []), s])
  }
  const dayLabel = (d: string) => `${WEEKDAY[new Date(d + 'T12:00:00Z').getUTCDay()]} · ${Number(d.slice(5, 7))} 月 ${Number(d.slice(8))} 日`
  const time = (iso: string) => formatInTimeZone(iso, tz, 'HH:mm')

  return (
    <article className="space-y-10">
      {f.status === 'dismissed' && (
        <p className="rounded border border-rule p-3 text-sm text-muted">
          这个{single ? '推荐' : '影展'}已经换掉了。
          {newer && (
            <Link className="ml-1 underline" href={`/festival/${newer.id}`}>
              看现在的「{newer.title}」
            </Link>
          )}
        </p>
      )}

      <header className="space-y-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          {KIND_LABEL[f.kind]} · {req?.weekStart} 起的一周
        </p>
        <h1 className="font-serif text-4xl leading-tight">{single ? `《${f.title}》` : f.title}</h1>
        <div className="max-w-3xl whitespace-pre-line font-serif text-lg leading-9">{f.statementMd}</div>
        {f.status !== 'dismissed' && (
          <div className="flex flex-wrap items-start gap-3 pt-2">
            <RerollButton festivalId={f.id} left={MAX_REROLLS - (req?.rerollCount ?? 0)} />
          </div>
        )}
      </header>

      {!single && (
        <section className={`grid gap-3 ${screenings.length > 4 ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-2 sm:grid-cols-4'}`}>
          {screenings.map((s) => {
            const m = films.get(s.tmdbId)
            return m ? (
              <figure key={s.id} className="space-y-1">
                <Poster path={m.posterPath} title={filmTitle(m)} sub={`${m.year ?? ''} · ${m.directors[0]?.name ?? ''}`} className="w-full rounded" />
                <figcaption className="truncate text-xs text-muted">
                  {s.position}. {filmTitle(m)}
                </figcaption>
              </figure>
            ) : null
          })}
        </section>
      )}

      <section className="space-y-8">
        <h2 className="font-serif text-2xl">{single ? '放映' : '排片'}</h2>
        {[...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <h3 className="mb-3 border-b border-rule pb-1 text-sm font-medium">{dayLabel(day)}</h3>
            <ul className="space-y-6">
              {list.map((s) => {
                const m = films.get(s.tmdbId)!
                return (
                  <li key={s.id} className="grid gap-4 sm:grid-cols-[6rem_1fr]">
                    <div className="font-serif text-xl tabular-nums">
                      {time(s.startsAt!)}
                      <span className="block text-xs text-muted">至 {time(s.endsAt!)}</span>
                    </div>
                    <div className="flex gap-4">
                      {single && <Poster path={m.posterPath} title={filmTitle(m)} size="w185" className="w-28 shrink-0 rounded" />}
                      <div className="space-y-2">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-serif text-lg">{filmTitle(m)}</span>
                          <span className="text-muted">({m.year})</span>
                          {ROLE_LABEL[s.role] && <Badge tone="ink">{ROLE_LABEL[s.role]}</Badge>}
                        </p>
                        <p className="text-xs text-muted">
                          {[m.titleZh ? m.titleEn : null, m.directors.map((d) => d.name).join(' & '), m.countries.join(' / '), `${m.runtimeMin} 分钟`].filter(Boolean).join(' · ')}
                        </p>
                        <p className="max-w-2xl text-sm leading-7">{s.programNoteMd}</p>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
        {unscheduled.length > 0 && (
          <div className="rounded border border-accent/40 p-4">
            <h3 className="mb-2 text-sm font-medium text-accent">没能排进你的空档</h3>
            <ul className="space-y-1 text-sm">
              {unscheduled.map((s) => {
                const m = films.get(s.tmdbId)!
                return (
                  <li key={s.id}>
                    {s.position}. {filmTitle(m)}（{m.runtimeMin} 分钟）— {s.unscheduledReason}
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-xs text-muted">
              去 <Link className="underline" href={`/plan?week=${req?.weekStart}`}>本周计划</Link> 多涂一些时间，或减少部数后重新生成。
            </p>
          </div>
        )}
      </section>
    </article>
  )
}
