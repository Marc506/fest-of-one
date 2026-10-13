import Link from 'next/link'
import { libraryCounts, listLibrary, unresolvedAliasesForUser } from '@/db/repo/library'
import { requirePageUser } from '@/lib/session'
import { Poster } from '../_components/Poster'
import { Badge } from '../_components/ui'
import { ManualAdd } from './ManualAdd'
import { ResolveRow } from './ResolveRow'

export const dynamic = 'force-dynamic'

type SP = Promise<{ tab?: string; q?: string; min?: string; from?: string; to?: string; page?: string }>

const PAGE = 60

export default async function LibraryPage({ searchParams }: { searchParams: SP }) {
  const user = await requirePageUser()
  const sp = await searchParams
  const tab = sp.tab === 'pending' || sp.tab === 'add' ? sp.tab : 'records'
  const counts = libraryCounts(user.id)
  const tabs = [
    { key: 'records', label: `观影记录 · ${counts.films}` },
    { key: 'pending', label: `待确认 · ${counts.unresolved}` },
    { key: 'add', label: '手动添加' },
  ]
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-serif text-3xl">片库</h1>
        <Link href="/onboarding" className="text-sm text-muted underline">
          管理来源
        </Link>
      </header>
      <nav className="flex gap-4 border-b border-rule text-sm">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/library?tab=${t.key}`}
            className={`-mb-px border-b-2 pb-2 ${tab === t.key ? 'border-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'records' && <Records userId={user.id} sp={sp} />}
      {tab === 'pending' && <Pending userId={user.id} />}
      {tab === 'add' && <ManualAdd />}
    </div>
  )
}

function Records({ userId, sp }: { userId: string; sp: Awaited<SP> }) {
  const page = Math.max(1, Number(sp.page) || 1)
  const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : undefined)
  const { rows, total } = listLibrary(userId, {
    q: sp.q || undefined,
    minRating: num(sp.min),
    yearFrom: num(sp.from),
    yearTo: num(sp.to),
    limit: PAGE,
    offset: (page - 1) * PAGE,
  })
  const qs = (p: number) => {
    const u = new URLSearchParams({ tab: 'records', ...(sp.q ? { q: sp.q } : {}), ...(sp.min ? { min: sp.min } : {}), ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), page: String(p) })
    return `/library?${u}`
  }
  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-center gap-2 text-sm" action="/library">
        <input type="hidden" name="tab" value="records" />
        <input name="q" defaultValue={sp.q} placeholder="搜索片名" className="min-w-40 flex-1 rounded border border-rule bg-transparent px-3 py-1.5" />
        <select name="min" defaultValue={sp.min ?? ''} className="rounded border border-rule bg-transparent px-2 py-1.5">
          <option value="">任意评分</option>
          {[10, 9, 8, 7, 6, 5].map((n) => (
            <option key={n} value={n}>
              ≥ {n / 2} 星
            </option>
          ))}
        </select>
        <input name="from" defaultValue={sp.from} placeholder="起始年" className="w-20 rounded border border-rule bg-transparent px-2 py-1.5" />
        <input name="to" defaultValue={sp.to} placeholder="截止年" className="w-20 rounded border border-rule bg-transparent px-2 py-1.5" />
        <button className="rounded-full border border-ink px-4 py-1.5">筛选</button>
      </form>
      <p className="text-xs text-muted">共 {total} 部</p>
      {rows.length === 0 ? (
        <p className="py-12 text-center text-muted">
          还没有记录。去 <Link className="underline" href="/onboarding">接入来源</Link>。
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {rows.map((r) => (
            <li key={`${r.tmdbId ?? 'a' + r.aliasId}`} className="flex items-center gap-3 py-2 text-sm">
              <Poster path={r.posterPath} title={r.title} size="w92" className="w-9 shrink-0 rounded" />
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {r.titleZh ?? r.title} <span className="text-muted">({r.year ?? '?'})</span>
                  {r.titleZh && <span className="ml-2 text-xs text-muted">{r.title}</span>}
                </p>
                <p className="truncate text-xs text-muted">
                  {[r.directors.join(' & '), r.countries.join(', '), r.runtimeMin ? `${r.runtimeMin} 分钟` : null].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                {r.matchStatus !== 'matched' && r.matchStatus !== 'confirmed' && <Badge tone="accent">未匹配</Badge>}
                {r.liked && <span title="喜欢">♥</span>}
                {r.views > 1 && <span className="text-muted">×{r.views}</span>}
                <span className="w-10 text-right tabular-nums">{r.rating10 != null ? (r.rating10 / 2).toFixed(1) + '★' : '—'}</span>
                <span className="hidden w-20 text-right text-muted tabular-nums sm:inline">{r.lastWatched?.slice(0, 10) ?? '—'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > PAGE && (
        <div className="flex justify-between text-sm">
          {page > 1 ? <Link href={qs(page - 1)}>← 上一页</Link> : <span />}
          <span className="text-muted">
            {page} / {Math.ceil(total / PAGE)}
          </span>
          {page * PAGE < total ? <Link href={qs(page + 1)}>下一页 →</Link> : <span />}
        </div>
      )}
    </div>
  )
}

function Pending({ userId }: { userId: string }) {
  const aliases = unresolvedAliasesForUser(userId)
  if (!aliases.length) return <p className="py-12 text-center text-muted">没有待确认的条目。</p>
  return (
    <div>
      <p className="text-sm text-muted">这些条目没能自动对上 TMDB。点候选确认，或搜索正确的那一部；确认后不会再被自动覆盖。</p>
      <ul className="divide-y divide-rule">
        {aliases.map((a) => (
          <ResolveRow
            key={a.id}
            alias={{ id: a.id, provider: a.provider, titleRaw: a.titleRaw, yearRaw: a.yearRaw, status: a.matchStatus, candidates: a.candidates ?? [], watched: a.watched }}
          />
        ))}
      </ul>
    </div>
  )
}
