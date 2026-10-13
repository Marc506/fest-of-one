import Link from 'next/link'
import { getFilms } from '@/db/repo/library'
import { latestTasteProfile } from '@/db/repo/taste'
import { requirePageUser } from '@/lib/session'
import { rebuildDecision } from '@/taste/profile'
import { Badge } from '../_components/ui'
import { RebuildButton } from './RebuildButton'

export const dynamic = 'force-dynamic'

const KIND: Record<string, string> = {
  director: '导演',
  country: '国别',
  era: '年代',
  movement: '运动',
  form: '形式',
  theme: '主题',
  actor: '演员',
  studio: '片厂',
}

function Bar({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted">{Math.round(value * 100)}</span>
      </div>
      <div className="h-2 rounded bg-rule">
        <div className="h-2 rounded bg-ink" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  )
}

export default async function TastePage() {
  const user = await requirePageUser()
  const p = latestTasteProfile(user.id)
  const decision = rebuildDecision(user.id)
  if (!p) {
    return (
      <div className="space-y-6">
        <h1 className="font-serif text-3xl">画像</h1>
        <p className="text-muted">
          还没有画像。{decision.reason === '没有观影记录' ? <>先去 <Link className="underline" href="/onboarding">接入观影记录</Link>。</> : '观影记录导入完成后会自动生成，也可以现在就生成。'}
        </p>
        {decision.reason !== '没有观影记录' && <RebuildButton label="生成画像" />}
      </div>
    )
  }
  const { stats, memo } = p
  const titles = new Map(getFilms([...new Set([...(memo?.affinities.flatMap((a) => a.evidence) ?? []), ...(memo?.frontiers.flatMap((f) => f.seed_films) ?? [])])]).map((f) => [f.tmdbId, f.titleZh ?? f.titleEn]))
  const name = (id: number) => titles.get(id) ?? `#${id}`

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">画像</h1>
          <p className="mt-2 text-sm text-muted">
            第 {p.version} 版 · 基于 {p.watchLogCount} 部 · {p.createdAt.slice(0, 10)}
            {decision.needed && ' · 观影记录有较多变化，下次导入后会自动重建'}
          </p>
        </div>
        <RebuildButton />
      </header>

      {memo ? (
        <>
          <section className="max-w-3xl">
            <div className="whitespace-pre-line font-serif text-lg leading-9">{memo.summary}</div>
          </section>

          <section className="grid gap-6 md:grid-cols-3">
            <Bar label="艺术片" value={memo.register.art_house} hint="艺术电影在观看与热情中的比重" />
            <Bar label="作者类型片" value={memo.register.auteur_genre} hint="Carpenter、Mann、朴赞郁、杜琪峰式的类型片" />
            <Bar label="主流商业片" value={memo.register.mainstream_commercial} hint="对主流商业片的容忍与享受" />
            <p className="text-sm leading-7 md:col-span-3">{memo.register.note}</p>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-xl">亲近</h2>
            <ul className="grid gap-3 md:grid-cols-2">
              {memo.affinities.map((a) => (
                <li key={`${a.kind}-${a.name}`} className="rounded border border-rule p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge>{KIND[a.kind] ?? a.kind}</Badge>
                    <span className="font-medium">{a.name}</span>
                    <span className="ml-auto h-1.5 w-16 rounded bg-rule">
                      <span className="block h-1.5 rounded bg-ink" style={{ width: `${Math.round(a.strength * 100)}%` }} />
                    </span>
                  </div>
                  <p className="leading-6 text-muted">{a.note}</p>
                  {a.evidence.length > 0 && <p className="mt-1 text-xs text-muted">依据：{a.evidence.slice(0, 5).map(name).join('、')}</p>}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="mb-3 font-serif text-xl">值得开拓</h2>
            <ul className="space-y-3">
              {memo.frontiers.map((f, i) => (
                <li key={i} className="text-sm leading-7">
                  <p className="font-medium">{f.description}</p>
                  <p className="text-muted">{f.why_adjacent}</p>
                  {f.seed_films.length > 0 && <p className="text-xs text-muted">从这些出发：{f.seed_films.slice(0, 5).map(name).join('、')}</p>}
                </li>
              ))}
            </ul>
          </section>

          {(memo.aversions.length > 0 || memo.do_not_program.length > 0) && (
            <section className="grid gap-6 md:grid-cols-2">
              {memo.aversions.length > 0 && (
                <div>
                  <h2 className="mb-2 font-serif text-xl">疏远</h2>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {memo.aversions.map((a, i) => (
                      <li key={i}>{a.pattern}</li>
                    ))}
                  </ul>
                </div>
              )}
              {memo.do_not_program.length > 0 && (
                <div>
                  <h2 className="mb-2 font-serif text-xl">不排</h2>
                  <ul className="flex flex-wrap gap-2 text-sm">
                    {memo.do_not_program.map((d) => (
                      <li key={d}>
                        <Badge tone="accent">{d}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        <p className="rounded border border-rule p-4 text-sm text-muted">
          只有统计层：LLM 备忘尚未生成（需要配置 ANTHROPIC_API_KEY 后点「重建画像」）。
        </p>
      )}

      <section className="grid gap-8 border-t border-rule pt-8 md:grid-cols-3">
        <div>
          <h3 className="mb-2 text-sm font-medium">常看的导演</h3>
          {stats.directors.length === 0 && <p className="text-sm text-muted">暂无（同一导演至少看过 2 部才计入）</p>}
          <ol className="space-y-1 text-sm">
            {stats.directors.slice(0, 12).map((d) => (
              <li key={d.name} className="flex justify-between gap-2">
                <span className="truncate">{d.name}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {d.n} 部{d.avg10 != null && ` · ${(d.avg10 / 2).toFixed(1)}★`}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">国别 · 年代</h3>
          <p className="text-sm leading-7">{stats.countries.slice(0, 10).map((c) => `${c.code} ${c.n}`).join(' · ')}</p>
          <p className="mt-2 text-sm leading-7 text-muted">{stats.decades.map((d) => `${d.decade}s ${d.n}`).join(' · ')}</p>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">数字</h3>
          <ul className="space-y-1 text-sm text-muted">
            <li>
              {stats.counts.films} 部 · 打分 {stats.counts.rated} · 喜欢 {stats.counts.liked} · 重看 {stats.counts.rewatched}
            </li>
            <li>近 90 天 {stats.counts.last90d} 部 · 每周约 {stats.pace_per_week} 部</li>
            <li>片长 P90：{stats.runtime_tolerance_p90 ?? '—'} 分钟</li>
            <li>
              高热度片占比 {Math.round(stats.register.share_high_popularity * 100)}%
              {stats.register.avg10_high_popularity != null && `（均分 ${(stats.register.avg10_high_popularity / 2).toFixed(1)}★）`} · 影展核心片占比{' '}
              {Math.round(stats.register.share_festival_core * 100)}%
            </li>
          </ul>
          <RatingHistogram dist={stats.rating_dist} />
        </div>
      </section>
    </div>
  )
}

function RatingHistogram({ dist }: { dist: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(dist))
  return (
    <div className="mt-3 flex h-16 items-end gap-1" title="评分分布（1–10）">
      {Array.from({ length: 10 }, (_, i) => String(i + 1)).map((k) => (
        <div key={k} className="flex flex-1 flex-col items-center gap-0.5">
          <div className="w-full rounded-t bg-ink/70" style={{ height: `${((dist[k] ?? 0) / max) * 48}px` }} />
          <span className="text-[9px] text-muted">{k}</span>
        </div>
      ))}
    </div>
  )
}
