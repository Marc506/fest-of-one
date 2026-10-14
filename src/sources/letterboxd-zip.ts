/**
 * Letterboxd 官方导出 ZIP（5.2 upload 模式，主路径）。
 *
 * 合并规则：
 * - `watched.csv` 定全集（影片 URI → externalId）。
 * - `diary.csv` 每行一条观看记录（可多次观看）。diary 里的 URI 是「日志条目」的链接、不是影片链接，
 *   所以 diary 行按 (Name, Year) 关联到影片；条目 URI 作为 entryId。
 * - 没有 diary 行的看过条目生成一条 `watchedAt = undefined` 的记录。
 * - `ratings.csv` 的评分覆盖到该片最新一条记录；`likes/films.csv` 置 liked。
 * - `reviews.csv` 的影评按条目 URI → (Name, Year, Watched Date) → 最新一条 依次挂上。
 * - 按列名读取（不依赖列序），缺列降级；忽略 `deleted/`、`orphaned/` 目录。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import AdmZip from 'adm-zip'
import Papa from 'papaparse'
import type { AdapterCtx, RawEntry, SourceAdapter } from './types'
import { starsToRating10 } from './types'

type Row = Record<string, string>

function parseCsv(text: string): Row[] {
  const res = Papa.parse<Row>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' })
  return res.data
}

/** 按列名（大小写、空白不敏感）取值。 */
function col(row: Row, ...names: string[]): string | undefined {
  for (const name of names) {
    const want = name.toLowerCase().replace(/\s+/g, '')
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase().replace(/\s+/g, '') === want) {
        const t = v?.trim()
        return t ? t : undefined
      }
    }
  }
  return undefined
}

function toYear(s: string | undefined): number | undefined {
  const n = Number(s)
  return Number.isInteger(n) && n > 1800 ? n : undefined
}

function toDate(s: string | undefined): string | undefined {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

const nameYearKey = (name: string | undefined, year: number | undefined) => `${(name ?? '').toLowerCase()}|${year ?? ''}`

function readEntries(zip: AdmZip): Map<string, string> {
  const files = new Map<string, string>()
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    const path = e.entryName.replace(/\\/g, '/')
    if (/(^|\/)(deleted|orphaned)\//.test(path)) continue
    files.set(path, e.getData().toString('utf8'))
  }
  return files
}

/** 找导出里的某个文件：允许 ZIP 外面多包一层目录；取路径最短的那个。 */
function findFile(files: Map<string, string>, rel: string): string | undefined {
  const hits = [...files.keys()].filter((p) => p === rel || p.endsWith('/' + rel)).sort((a, b) => a.length - b.length)
  return hits[0] ? files.get(hits[0]) : undefined
}

type FilmRef = { uri: string; name: string; year?: number; addedAt?: string }

export function parseLetterboxdExport(zipData: Buffer): RawEntry[] {
  const files = readEntries(new AdmZip(zipData))
  const csv = (rel: string) => {
    const text = findFile(files, rel)
    return text ? parseCsv(text) : []
  }
  const watchedRows = csv('watched.csv')
  const ratingRows = csv('ratings.csv')
  const diaryRows = csv('diary.csv')
  const likeRows = csv('likes/films.csv')
  const watchlistRows = csv('watchlist.csv')
  const reviewRows = csv('reviews.csv')
  if (!watchedRows.length && !diaryRows.length && !ratingRows.length && !watchlistRows.length) {
    throw new Error('ZIP 里没有找到 watched.csv / diary.csv —— 请上传 Letterboxd「Export your data」得到的原始 ZIP')
  }

  // 1) 影片全集
  const films = new Map<string, FilmRef>() // uri → film
  const byNameYear = new Map<string, string>() // name|year → uri
  const addFilm = (row: Row): FilmRef | undefined => {
    const uri = col(row, 'Letterboxd URI')
    const name = col(row, 'Name')
    if (!uri || !name) return undefined
    const year = toYear(col(row, 'Year'))
    let f = films.get(uri)
    if (!f) {
      f = { uri, name, year, addedAt: toDate(col(row, 'Date')) }
      films.set(uri, f)
    }
    if (!byNameYear.has(nameYearKey(name, year))) byNameYear.set(nameYearKey(name, year), uri)
    return f
  }
  for (const r of watchedRows) addFilm(r)
  // 打过分 / 点过赞也算看过（极少数情况不在 watched.csv）
  for (const r of ratingRows) addFilm(r)
  for (const r of likeRows) addFilm(r)

  const filmForRow = (row: Row): FilmRef => {
    const name = col(row, 'Name') ?? '(untitled)'
    const year = toYear(col(row, 'Year'))
    const uri = byNameYear.get(nameYearKey(name, year))
    if (uri) return films.get(uri)!
    // diary 有、watched 没有：用 name|year 合成一个稳定的影片键
    const synthetic = `letterboxd:film:${nameYearKey(name, year)}`
    const f: FilmRef = { uri: synthetic, name, year }
    films.set(synthetic, f)
    byNameYear.set(nameYearKey(name, year), synthetic)
    return f
  }

  // 2) diary → 每行一条
  const entries = new Map<string, RawEntry[]>() // film uri → entries
  const entryByUri = new Map<string, RawEntry>()
  const push = (f: FilmRef, e: RawEntry) => {
    const list = entries.get(f.uri) ?? []
    list.push(e)
    entries.set(f.uri, list)
  }
  for (const row of diaryRows) {
    const f = filmForRow(row)
    const entryUri = col(row, 'Letterboxd URI')
    const entryId = entryUri ?? `diary:${createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16)}`
    const tags = col(row, 'Tags')
    const e: RawEntry = {
      provider: 'letterboxd',
      externalId: f.uri,
      entryId,
      title: f.name,
      year: f.year,
      watchedAt: toDate(col(row, 'Watched Date')) ?? toDate(col(row, 'Date')),
      loggedAt: toDate(col(row, 'Date')),
      rating10: starsToRating10(Number(col(row, 'Rating'))),
      rewatch: /^yes$/i.test(col(row, 'Rewatch') ?? ''),
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      listKind: 'watched',
      raw: { diary: row },
    }
    push(f, e)
    if (entryUri) entryByUri.set(entryUri, e)
  }

  // 3) 没有 diary 行的看过条目
  for (const f of films.values()) {
    if (entries.has(f.uri)) continue
    push(f, {
      provider: 'letterboxd',
      externalId: f.uri,
      entryId: `watched:${f.uri}`,
      title: f.name,
      year: f.year,
      loggedAt: f.addedAt,
      listKind: 'watched',
      raw: { watched: { uri: f.uri, name: f.name, year: f.year, date: f.addedAt } },
    })
  }

  const latest = (uri: string): RawEntry | undefined =>
    [...(entries.get(uri) ?? [])].sort((a, b) =>
      (b.watchedAt ?? b.loggedAt ?? '').localeCompare(a.watchedAt ?? a.loggedAt ?? ''),
    )[0]

  // 4) ratings 覆盖到最新一条
  for (const row of ratingRows) {
    const r = starsToRating10(Number(col(row, 'Rating')))
    const uri = col(row, 'Letterboxd URI')
    const e = uri && films.has(uri) ? latest(uri) : latest(filmForRow(row).uri)
    if (e && r !== undefined) e.rating10 = r
  }

  // 5) likes
  for (const row of likeRows) {
    const uri = col(row, 'Letterboxd URI')
    const f = uri && films.has(uri) ? films.get(uri)! : filmForRow(row)
    for (const e of entries.get(f.uri) ?? []) e.liked = true
  }

  // 6) reviews
  for (const row of reviewRows) {
    const text = col(row, 'Review')
    if (!text) continue
    const uri = col(row, 'Letterboxd URI')
    let e = uri ? entryByUri.get(uri) : undefined
    if (!e) {
      const f = filmForRow(row)
      const wd = toDate(col(row, 'Watched Date'))
      e = (entries.get(f.uri) ?? []).find((x) => wd && x.watchedAt === wd) ?? latest(f.uri)
    }
    if (!e) continue
    e.review = text
    if (!e.tags?.length) {
      const tags = col(row, 'Tags')
      if (tags) e.tags = tags.split(',').map((t) => t.trim()).filter(Boolean)
    }
  }

  // 7) watchlist
  const out: RawEntry[] = [...entries.values()].flat()
  for (const row of watchlistRows) {
    const uri = col(row, 'Letterboxd URI')
    const name = col(row, 'Name')
    if (!uri || !name) continue
    out.push({
      provider: 'letterboxd',
      externalId: uri,
      entryId: `watchlist:${uri}`,
      title: name,
      year: toYear(col(row, 'Year')),
      loggedAt: toDate(col(row, 'Date')),
      listKind: 'watchlist',
      raw: { watchlist: row },
    })
  }
  return out
}

export const letterboxdZipAdapter: SourceAdapter = {
  provider: 'letterboxd',
  mode: 'upload',
  async *fetchAll(ctx: AdapterCtx) {
    if (!ctx.uploadPath) throw new Error('缺少上传文件')
    ctx.onProgress(2, '解析 Letterboxd 导出…')
    const entries = parseLetterboxdExport(readFileSync(ctx.uploadPath))
    ctx.log(`parsed ${entries.length} entries`)
    yield* entries
  },
}
