/** 标题规范化与相似度（5.4）：小写、去标点、全半角统一、去变音符号、繁体转简体。 */
import { Converter } from 'opencc-js/t2cn'

const COMBINING = /[̀-ͯ]/g
// 标点与符号（含中文标点），保留字母、数字、CJK 与空白
const PUNCT = /[\p{P}\p{S}]+/gu

// 港台片在 TMDB 上常常只有繁体原名，豆瓣用简体：比较前统一成简体
const toSimplified = Converter({ from: 't', to: 'cn' })
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function normalizeTitle(s: string): string {
  return (HAN.test(s) ? toSimplified(s) : s)
    .normalize('NFKC') // 全角 → 半角
    .normalize('NFD')
    .replace(COMBINING, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isCjk(s: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/.test(s)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const A = [...a]
  const B = [...b]
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i)
  for (let i = 1; i <= A.length; i++) {
    const cur = [i]
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[B.length]!
}

const LEADING_ARTICLE = /^(the|a|an|le|la|les|l|el|los|las|il|lo|gli|der|die|das|o|os|as) /

/** 0–1 相似度：规范化后的 Levenshtein 比例；忽略前导冠词差异。 */
export function titleSim(a: string, b: string): number {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const x2 = x.replace(LEADING_ARTICLE, '')
  const y2 = y.replace(LEADING_ARTICLE, '')
  if (x2 === y2) return 0.98
  const len = Math.max([...x2].length, [...y2].length)
  return Math.max(0, 1 - levenshtein(x2, y2) / len)
}

/** 豆瓣标题「中文名 / 原名」拆分；去掉空串与重复。 */
export function splitAltTitles(raw: string): string[] {
  const parts = raw
    .split(/\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(parts.length ? parts : [raw.trim()])]
}

/** 人名相似度（导演核对 7.4）：顺序无关的 token 比较 + Levenshtein。 */
export function nameSim(a: string, b: string): number {
  const ta = normalizeTitle(a).split(' ').filter(Boolean).sort().join(' ')
  const tb = normalizeTitle(b).split(' ').filter(Boolean).sort().join(' ')
  return Math.max(titleSim(a, b), titleSim(ta, tb))
}

/** 含汉字且不含假名 / 谚文：日本片的纯汉字原名对中文读者也可读。 */
export function isHanOnly(s: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s) && !/[\u3040-\u30ff\uac00-\ud7af]/.test(s)
}
