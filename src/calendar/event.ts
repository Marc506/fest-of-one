/**
 * 日历事件内容的单一来源（9 章）：ICS 下载、webcal、Google 模板链接、Google API 都用 buildEvent。
 * LOCATION 一律留空（P7）。时间一律 UTC（带 Z），避免 VTIMEZONE。
 */
import type { Festival, Film, Screening, User } from '@/db/schema'

export type CalendarEvent = {
  uid: string
  sequence: number
  summary: string
  description: string
  url: string
  start: string
  end: string
  alarmMin: number | null
  tmdbId: number
}

export function festivalUrl(baseUrl: string, festivalId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/festival/${festivalId}`
}

export function filmTitleLocal(film: Pick<Film, 'titleEn' | 'titleZh'>, locale: User['locale']): string {
  return locale === 'zh-CN' ? (film.titleZh ?? film.titleEn) : film.titleEn
}

export function buildEvent(input: {
  screening: Pick<Screening, 'id' | 'calendarUid' | 'calendarSequence' | 'programNoteMd' | 'startsAt' | 'endsAt' | 'tmdbId'>
  festival: Pick<Festival, 'id' | 'kind' | 'title'>
  film: Pick<Film, 'tmdbId' | 'titleEn' | 'titleZh' | 'year' | 'directors' | 'countries' | 'runtimeMin'>
  user: Pick<User, 'locale' | 'prefs'>
  baseUrl: string
}): CalendarEvent | null {
  const { screening: s, festival: f, film, user } = input
  if (!s.startsAt || !s.endsAt) return null
  const title = `${filmTitleLocal(film, user.locale)} (${film.year ?? '?'})`
  const url = festivalUrl(input.baseUrl, f.id)
  const zh = user.locale === 'zh-CN'
  const facts = zh
    ? `导演 ${film.directors.map((d) => d.name).join(' & ') || '—'} · ${film.countries.join(' / ') || '—'} · ${film.runtimeMin ?? '?'} 分钟`
    : `Dir. ${film.directors.map((d) => d.name).join(' & ') || '—'} · ${film.countries.join(' / ') || '—'} · ${film.runtimeMin ?? '?'} min`
  return {
    uid: s.calendarUid,
    sequence: s.calendarSequence,
    summary: f.kind === 'single' ? title : `${f.title} · ${title}`,
    description: `${s.programNoteMd}\n\n${facts}\n${url}\nTMDB: https://www.themoviedb.org/movie/${film.tmdbId}`,
    url,
    start: s.startsAt,
    end: s.endsAt,
    alarmMin: user.prefs.alarm_min,
    tmdbId: film.tmdbId,
  }
}
