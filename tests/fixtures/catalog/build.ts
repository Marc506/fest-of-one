/**
 * 离线片目 fixture 的紧凑写法 → CatalogFilm（与 TMDB 同形，供 CatalogTmdbClient 使用）。
 *
 * 片目数据仅用于测试 / 离线开发；tmdb_id 尽量用真实 TMDB id，不确定的用 9_000_000 以上的合成 id。
 * 人物 id 由姓名稳定哈希得到（同名即同人），无需手工维护。
 */
import type { CatalogFilm } from '@/resolver/tmdb'

export function personId(name: string): number {
  let h = 2166136261
  for (const ch of name.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 16777619)
  }
  return 10_000_000 + (Math.abs(h) % 80_000_000)
}

const list = (s: string, sep: RegExp | string = ',') =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * f(tmdb_id, title_en, original_title, title_zh, year, runtime_min,
 *   countries 'TW,FR', languages 'zh,fr', genres 'Drama|Romance',
 *   directors 'A & B', cast 'X, Y, Z', keywords 'rain, hotel, …',
 *   vote_avg, vote_count, popularity)
 */
export function f(
  tmdb_id: number,
  title_en: string,
  original_title: string,
  title_zh: string | null,
  year: number,
  runtime_min: number | null,
  countries: string,
  languages: string,
  genres: string,
  directors: string,
  cast: string,
  keywords: string,
  vote_avg: number,
  vote_count: number,
  popularity: number,
): CatalogFilm {
  return {
    tmdb_id,
    title_en,
    original_title,
    title_zh,
    year,
    release_date: `${year}-06-01`,
    runtime_min,
    countries: list(countries),
    languages: list(languages),
    genres: list(genres, '|'),
    directors: list(directors, '&').map((name) => ({ tmdb_person_id: personId(name), name })),
    cast_top: list(cast).map((name, order) => ({ tmdb_person_id: personId(name), name, character: null, order })),
    keywords: list(keywords),
    vote_avg,
    vote_count,
    popularity,
    poster_path: null,
  }
}

/** 观影记录 fixture 一行：[tmdb_id, rating10 | null, flags, watched YYYY-MM-DD | null]；flags 含 L=liked R=rewatch */
export type LogRow = [number, number | null, string, string | null]

export type Persona = {
  key: string
  name: string
  locale: 'zh-CN' | 'en'
  description: string
  log: LogRow[]
  watchlist: number[]
}
