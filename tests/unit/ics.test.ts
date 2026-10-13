import ical, { type VEvent } from 'node-ical'
import { describe, expect, it } from 'vitest'
import { buildEvent } from '@/calendar/event'
import { buildIcs, escapeText, foldLine } from '@/calendar/ics'
import { googleTemplateLink, webcalUrls } from '@/calendar/links'
import { DEFAULT_PREFS } from '@/db/types'

const film = {
  tmdbId: 843,
  titleEn: 'In the Mood for Love',
  titleZh: '花样年华',
  year: 2000,
  directors: [{ tmdb_person_id: 1, name: 'Wong Kar-wai' }],
  countries: ['HK', 'FR'],
  runtimeMin: 98,
}
const note = '走廊、楼梯、雨；一件旗袍换过一件旗袍——这是一部关于重复的电影, 也是一部关于克制的电影; 王家卫让每个场景都回来两次。'.repeat(2)
const ev = buildEvent({
  screening: { id: 's1', calendarUid: 'screening-s1@fest-of-one', calendarSequence: 2, programNoteMd: note, startsAt: '2026-10-21T11:30:00.000Z', endsAt: '2026-10-21T13:08:00.000Z', tmdbId: 843 },
  festival: { id: 'f1', kind: 'motif', title: '房间里的雨' },
  film,
  user: { locale: 'zh-CN', prefs: DEFAULT_PREFS },
  baseUrl: 'https://fest.example.com',
})!

describe('calendar export (9 章)', () => {
  it('builds the event fields', () => {
    expect(ev.summary).toBe('房间里的雨 · 花样年华 (2000)')
    expect(ev.description).toContain('导演 Wong Kar-wai · HK / FR · 98 分钟')
    expect(ev.description).toContain('https://fest.example.com/festival/f1')
    expect(ev.description).toContain('TMDB: https://www.themoviedb.org/movie/843')
    expect(ev.alarmMin).toBe(30)
  })

  it('escapes text and folds at 75 octets without splitting UTF-8', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\;c\\\\d\\ne')
    const folded = foldLine('DESCRIPTION:' + '雨'.repeat(60))
    for (const l of folded.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75)
    expect(folded.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true)
    // 转义序列不被拆开
    const esc = foldLine('DESCRIPTION:' + 'a'.repeat(62) + '\\n' + 'b'.repeat(20))
    expect(esc.split('\r\n')[0]!.endsWith('\\')).toBe(false)
  })

  it('round-trips through node-ical; no LOCATION; CRLF', () => {
    const ics = buildIcs([ev], { name: '一个人的影展', now: new Date('2026-10-13T00:00:00Z') })
    expect(ics).not.toMatch(/LOCATION/)
    expect(ics.split('\r\n').every((l) => !l.includes('\n'))).toBe(true)
    const parsed = ical.sync.parseICS(ics)
    const vevent = Object.values(parsed).find((x) => x?.type === 'VEVENT') as VEvent
    expect(vevent.uid).toBe('screening-s1@fest-of-one')
    expect(vevent.summary).toBe('房间里的雨 · 花样年华 (2000)')
    expect(vevent.description).toBe(ev.description)
    expect((vevent.start as Date).toISOString()).toBe('2026-10-21T11:30:00.000Z')
    expect((vevent.end as Date).toISOString()).toBe('2026-10-21T13:08:00.000Z')
    expect(String(vevent.sequence)).toBe('2')
    expect(vevent.location).toBeUndefined()
    expect(ics).toContain('TRIGGER:-PT30M')
  })

  it('makes Google template links and webcal URLs', () => {
    const link = googleTemplateLink(ev)
    expect(link).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=/)
    expect(link).toContain('dates=20261021T113000Z/20261021T130800Z')
    expect(link).toMatch(/&location=$/)
    expect(decodeURIComponent(link.split('&details=')[1]!.split('&')[0]!)).toBe(ev.description)
    expect(webcalUrls('https://fest.example.com/', 'tok')).toEqual({
      https: 'https://fest.example.com/api/cal/tok.ics',
      webcal: 'webcal://fest.example.com/api/cal/tok.ics',
    })
  })

  it('omits summary prefix for single picks and skips unscheduled screenings', () => {
    const single = buildEvent({
      screening: { id: 's2', calendarUid: 'u', calendarSequence: 0, programNoteMd: 'x', startsAt: '2026-10-21T11:30:00Z', endsAt: '2026-10-21T13:00:00Z', tmdbId: 843 },
      festival: { id: 'f2', kind: 'single', title: '花样年华' },
      film,
      user: { locale: 'zh-CN', prefs: { ...DEFAULT_PREFS, alarm_min: null } },
      baseUrl: 'http://x',
    })!
    expect(single.summary).toBe('花样年华 (2000)')
    expect(buildIcs([single], { name: 'x' })).not.toContain('VALARM')
    expect(
      buildEvent({
        screening: { id: 's3', calendarUid: 'u', calendarSequence: 0, programNoteMd: 'x', startsAt: null, endsAt: null, tmdbId: 843 },
        festival: { id: 'f2', kind: 'single', title: 't' },
        film,
        user: { locale: 'zh-CN', prefs: DEFAULT_PREFS },
        baseUrl: 'http://x',
      }),
    ).toBeNull()
  })
})
