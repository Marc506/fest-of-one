/**
 * 豆瓣第三方导出（5.3 upload 模式，主路径）：CSV 或 Excel（多个工作表时，表名可代表状态：「看过」「想看」）。
 * 按列名启发式识别（不依赖列序）：
 *   含 url / 链接 / link 的列 → subject id；title / 标题 / 片名 → 标题；date / 日期 / 时间 → 日期；
 *   rating / 评分 / 星级 → 1–5 或「力荐 推荐 还行 较差 很差」→ ×2；status / 状态 → 看过 / 想看；
 *   comment / 短评 / 评语 → 短评；tags / 标签；上映日期 / 年份 → 年份；IMDb → imdb id。
 * 非官方格式、可能变化：识别不出必需的列时给出明确错误。
 */
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/node'
import type { AdapterCtx, RawEntry, SourceAdapter } from './types'

type Table = { name: string; header: string[]; rows: string[][] }

const WORDS: Record<string, number> = { 力荐: 5, 推荐: 4, 还行: 3, 较差: 2, 很差: 1 }

export function doubanRating10(v: string | undefined): number | undefined {
  if (!v) return undefined
  const t = v.trim()
  for (const [w, n] of Object.entries(WORDS)) if (t.includes(w)) return n * 2
  const n = Number(t.match(/\d+(\.\d+)?/)?.[0])
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n <= 5) return Math.round(n * 2)
  if (n <= 10) return Math.round(n)
  return undefined
}

export function subjectIdFrom(s: string | undefined): string | undefined {
  return s?.match(/subject\/(\d+)/)?.[1] ?? (s && /^\d{5,}$/.test(s.trim()) ? s.trim() : undefined)
}

function findCol(header: string[], tests: RegExp[]): number {
  const norm = header.map((h) => h.trim().toLowerCase())
  for (const re of tests) {
    const i = norm.findIndex((h) => re.test(h))
    if (i >= 0) return i
  }
  return -1
}

function toDate(v: string | undefined): string | undefined {
  const m = v?.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : undefined
}

function statusOf(v: string | undefined, sheet: string): 'watched' | 'watchlist' | 'skip' {
  const s = `${v ?? ''} ${sheet}`
  if (/想看|wish|want/i.test(s)) return 'watchlist'
  if (/在看|doing/i.test(s)) return 'skip'
  return 'watched'
}

export function tablesToEntries(tables: Table[]): RawEntry[] {
  const out: RawEntry[] = []
  let recognized = false
  for (const t of tables) {
    const h = t.header
    const cUrl = findCol(h, [/^(url|链接|条目链接|link|豆瓣链接)$/, /url|链接|link/])
    const cTitle = findCol(h, [/^(title|标题|片名|电影名|名称|name)$/, /title|标题|片名|名称/])
    if (cUrl < 0 || cTitle < 0) continue
    recognized = true
    const cDate = findCol(h, [/^(date|日期|标记日期|打分日期|时间|创建时间)$/, /标记|打分日期|date|日期|时间/])
    const cRating = findCol(h, [/^(rating|评分|个人评分|我的评分|星级|star)$/, /个人评分|我的评分|rating|星/])
    const cStatus = findCol(h, [/^(status|状态|类型)$/])
    const cComment = findCol(h, [/^(comment|短评|我的短评|评语|review)$/, /短评|comment|评语/])
    const cTags = findCol(h, [/^(tags|标签|我的标签)$/, /标签|tag/])
    const cYear = findCol(h, [/^(year|年份)$/, /上映日期|上映|year|年份/])
    const cImdb = findCol(h, [/imdb/])
    for (const r of t.rows) {
      const get = (i: number) => (i >= 0 ? (r[i] ?? '').toString().trim() || undefined : undefined)
      const id = subjectIdFrom(get(cUrl))
      const title = get(cTitle)
      if (!id || !title) continue
      const kind = statusOf(get(cStatus), t.name)
      if (kind === 'skip') continue
      const year = Number(get(cYear)?.match(/(18|19|20)\d{2}/)?.[0]) || undefined
      const tags = get(cTags)
        ?.replace(/^标签[:：]\s*/, '')
        .split(/[\s,，、]+/)
        .filter(Boolean)
      out.push({
        provider: 'douban',
        externalId: id,
        entryId: kind === 'watched' ? `douban:collect:${id}` : `douban:wish:${id}`,
        title,
        year,
        imdbId: get(cImdb)?.match(/tt\d+/)?.[0],
        watchedAt: kind === 'watched' ? toDate(get(cDate)) : undefined,
        loggedAt: toDate(get(cDate)),
        rating10: kind === 'watched' ? doubanRating10(get(cRating)) : undefined,
        review: kind === 'watched' ? get(cComment) : undefined,
        tags,
        listKind: kind,
        raw: Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])),
      })
    }
  }
  if (!recognized) throw new Error('没有识别出豆瓣导出的列：至少需要「标题 / title」和「链接 / url」两列（非官方格式，可能已变化）')
  // 同一 subject 只留一条（「看过」优先于「想看」）
  const seen = new Map<string, RawEntry>()
  for (const e of out) {
    const prev = seen.get(e.externalId)
    if (!prev || (prev.listKind === 'watchlist' && e.listKind === 'watched')) seen.set(e.externalId, e)
  }
  return [...seen.values()]
}

export function parseDoubanCsv(text: string): RawEntry[] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' })
  const [header, ...rows] = res.data
  return tablesToEntries([{ name: '', header: header ?? [], rows }])
}

export async function parseDoubanXlsx(data: Buffer): Promise<RawEntry[]> {
  const sheets = await readXlsxFile(data)
  const tables: Table[] = sheets.map((s) => {
    const rows = s.data.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c == null ? '' : String(c))))
    const [header, ...rest] = rows
    return { name: s.sheet, header: header ?? [], rows: rest }
  })
  return tablesToEntries(tables)
}

export const doubanUploadAdapter: SourceAdapter = {
  provider: 'douban',
  mode: 'upload',
  async *fetchAll(ctx: AdapterCtx) {
    if (!ctx.uploadPath) throw new Error('缺少上传文件')
    ctx.onProgress(2, '解析豆瓣导出…')
    const buf = readFileSync(ctx.uploadPath)
    const entries = /\.xlsx?$/i.test(ctx.uploadPath) ? await parseDoubanXlsx(buf) : parseDoubanCsv(buf.toString('utf8'))
    ctx.log(`parsed ${entries.length} douban entries`)
    yield* entries
  },
}
