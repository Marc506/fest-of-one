import { describe, expect, it } from 'vitest'
import { isCjk, nameSim, normalizeTitle, splitAltTitles, titleSim } from '@/resolver/normalize'

describe('normalize', () => {
  it('lowercases, strips punctuation and diacritics, folds full-width', () => {
    expect(normalizeTitle('Amélie!')).toBe('amelie')
    expect(normalizeTitle('ＡＢＣ　１２３')).toBe('abc 123')
    expect(normalizeTitle('花樣年華：導演版')).toBe('花样年华 导演版') // 繁 → 简
    expect(titleSim('牯岭街少年杀人事件', '牯嶺街少年殺人事件')).toBe(1)
    expect(normalizeTitle('Crouching Tiger, Hidden Dragon')).toBe('crouching tiger hidden dragon')
  })
  it('scores title similarity', () => {
    expect(titleSim('The Thing', 'the thing')).toBe(1)
    expect(titleSim('Thing', 'The Thing')).toBeGreaterThan(0.95)
    expect(titleSim('Yi Yi', 'Yi yi: A One and a Two')).toBeLessThan(0.6)
    expect(titleSim('Stalker', 'Stalker 2')).toBeGreaterThan(0.7)
  })
  it('splits douban alt titles', () => {
    expect(splitAltTitles('花样年华 / 花樣年華')).toEqual(['花样年华', '花樣年華'])
    expect(splitAltTitles('AC/DC: Let There Be Rock')).toEqual(['AC/DC: Let There Be Rock'])
  })
  it('detects CJK and compares names order-insensitively', () => {
    expect(isCjk('悲情城市')).toBe(true)
    expect(isCjk('Stalker')).toBe(false)
    expect(nameSim('Hou Hsiao-hsien', 'Hsiao-hsien Hou')).toBeGreaterThan(0.9)
    expect(nameSim('Johnnie To', 'John Woo')).toBeLessThan(0.7)
  })
})
