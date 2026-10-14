import Link from 'next/link'
import { libraryCounts, matchRate, matchStats } from '@/db/repo/library'
import { listSources } from '@/db/repo/sources'
import { requirePageUser } from '@/lib/session'
import { Badge, Card, fmtDate } from '../_components/ui'
import { ClearCookieButton, DoubanConnect, LetterboxdRss } from './ConnectForms'
import { LetterboxdUpload } from './LetterboxdUpload'
import { SourceActions } from './SourceActions'

export const dynamic = 'force-dynamic'

const PROVIDER = { letterboxd: 'Letterboxd', douban: '豆瓣' } as const
const MODE = { upload: '上传', rss: 'RSS', scrape: '抓取' } as const

export default async function OnboardingPage() {
  const user = await requirePageUser()
  const sources = listSources(user.id)
  const counts = libraryCounts(user.id)
  const r = matchRate(matchStats(user.id))
  const rate = r == null ? null : r * 100

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-serif text-3xl">接入观影记录</h1>
        <p className="mt-2 text-muted">
          策展人要读完你看过的每一部片。目前片库：{counts.films} 部 · {counts.entries} 条记录 · 想看 {counts.watchlist}
          {rate !== null && ` · TMDB 匹配率 ${rate.toFixed(1)}%`}
          {counts.unresolved > 0 && (
            <>
              {' · '}
              <Link className="underline" href="/library?tab=pending">
                待确认 {counts.unresolved}
              </Link>
            </>
          )}
          {counts.notFilm > 0 && ` · 剧集等非电影 ${counts.notFilm}（已跳过）`}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Letterboxd · 导出 ZIP" footer="Settings → Import & Export → Export your data。无需登录、全量导入。">
          <LetterboxdUpload />
        </Card>
        <Card title="Letterboxd · RSS 增量" footer="只含最近约 50 条 diary，导入 ZIP 之后用它做日常增量（每 12 小时自动同步）。只在影片页打星、没写 diary 的评分不会出现在 RSS。">
          <LetterboxdRss />
        </Card>
        <Card title="豆瓣" footer="非官方、可能失效：豆瓣没有开放 API，也没有官方导出。">
          <DoubanConnect />
        </Card>
      </div>

      {sources.length > 0 && (
        <section>
          <h2 className="mb-3 font-serif text-xl">已接入的来源</h2>
          <ul className="divide-y divide-rule rounded-lg border border-rule">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{PROVIDER[s.provider]}</span>
                    <Badge>{MODE[s.syncMode]}</Badge>
                    {s.handle !== 'export' && <span className="text-muted">{s.handle}</span>}
                    {s.provider === 'douban' && <Badge tone="accent">非官方</Badge>}
                  </div>
                  <p className="text-xs text-muted">上次同步：{fmtDate(s.lastSyncAt)}</p>
                  {s.lastError && <p className="text-xs text-accent">上次失败：{s.lastError}</p>}
                  {s.syncMode === 'scrape' && (
                    <p className="flex gap-2 text-xs text-muted">
                      Cookie：{s.authEnc ? '已设置' : '未设置'}
                      {s.authEnc && <ClearCookieButton id={s.id} />}
                    </p>
                  )}
                </div>
                <SourceActions id={s.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
