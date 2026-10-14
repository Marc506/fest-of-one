/**
 * 中文区通行译名：豆瓣标题优先于 TMDB zh-CN，进入中文用户的观影记录；旧画像的「TA」显示为「你」。
 */
import { describe, expect, it } from 'vitest'
import { doubanTitlesByTmdb, insertFilmStub, setAliasMatch, upsertAlias, upsertWatchEntry, upsertWatchlistEntry } from '@/db/repo/library'
import { updateUserSettings, upsertUserByEmail } from '@/db/repo/users'
import { toSecondPerson } from '@/taste/memo'
import { currentWatchState } from '@/taste/profile'

function seed(locale: 'zh-CN' | 'en') {
  const user = upsertUserByEmail(`zh-${locale}@test`)
  updateUserSettings(user.id, { locale })
  // TMDB 的 zh-CN 译名与豆瓣不同：以豆瓣为准
  insertFilmStub({ tmdbId: 9871, titleEn: 'Showgirls', originalTitle: 'Showgirls', titleZh: '艳舞女郎', year: 1995 })
  insertFilmStub({ tmdbId: 6977, titleEn: 'No Country for Old Men', originalTitle: 'No Country for Old Men', titleZh: '老无所依', year: 2007 })
  insertFilmStub({ tmdbId: 563, titleEn: 'Starship Troopers', originalTitle: 'Starship Troopers', titleZh: '星河战队', year: 1997 })
  const d = upsertAlias({ provider: 'douban', externalId: '1300001', titleRaw: '艳舞女郎 / Showgirls' })
  setAliasMatch(d.id, { status: 'matched', tmdbId: 9871, confidence: 0.99, candidates: null })
  const d2 = upsertAlias({ provider: 'douban', externalId: '1300002', titleRaw: '美国艳舞女郎' })
  setAliasMatch(d2.id, { status: 'matched', tmdbId: 9871, confidence: 0.99, candidates: null })
  const l = upsertAlias({ provider: 'letterboxd', externalId: 'lb:no-country', titleRaw: 'No Country for Old Men', yearRaw: 2007 })
  setAliasMatch(l.id, { status: 'matched', tmdbId: 6977, confidence: 1, candidates: null })
  const w = upsertAlias({ provider: 'douban', externalId: '1300003', titleRaw: '星河战队' })
  setAliasMatch(w.id, { status: 'matched', tmdbId: 563, confidence: 0.99, candidates: null })
  upsertWatchEntry({ userId: user.id, sourceId: null, aliasId: d2.id, tmdbId: 9871, provider: 'douban', externalEntryId: 'a', watchedAt: '2024-01-01' })
  upsertWatchEntry({ userId: user.id, sourceId: null, aliasId: l.id, tmdbId: 6977, provider: 'letterboxd', externalEntryId: 'b', watchedAt: '2024-02-01' })
  upsertWatchlistEntry({ userId: user.id, sourceId: null, aliasId: w.id, tmdbId: 563, provider: 'douban' })
  return user
}

describe('mainland Chinese titles in the watch log', () => {
  it('prefers the Douban title, falls back to TMDB zh-CN, and only for zh-CN viewers', () => {
    const zh = currentWatchState(seed('zh-CN').id).log.text
    expect(doubanTitlesByTmdb([9871, 6977])).toEqual(new Map([[9871, '艳舞女郎']]))
    expect(zh).toContain('title / 中文区通行片名 when known (year)')
    expect(zh).toContain('9871|Showgirls / 美国艳舞女郎 (1995)|') // 用户自己那条豆瓣标题
    expect(zh).toContain('6977|No Country for Old Men / 老无所依 (2007)|') // Letterboxd 来的：TMDB 中文名
    expect(zh).toContain('WATCHLIST: 563|Starship Troopers / 星河战队 (1997)|')

    const en = currentWatchState(seed('en').id).log.text
    expect(en).toContain('6977|No Country for Old Men (2007)|')
    expect(en).not.toContain('老无所依')
  })
})

describe('second person on the profile page', () => {
  it('turns TA / 这位观众 into 你 without touching Latin words or numbers', () => {
    const memo = { summary: 'TA 看重的是空间。这位观众很少给满分，TA的耐心有限。TAG 不变。', strength: 0.8, evidence: [1, 2], notes: ['TA喜欢范霍文'] }
    expect(toSecondPerson(memo)).toEqual({ summary: '你看重的是空间。你很少给满分，你的耐心有限。TAG 不变。', strength: 0.8, evidence: [1, 2], notes: ['你喜欢范霍文'] })
  })
})
