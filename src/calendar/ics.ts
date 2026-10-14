/**
 * 手写 RFC 5545：CRLF 换行、按 75 个 UTF-8 字节折行（不切断多字节字符）、转义 `\ ; , 换行`。
 * 不输出 LOCATION（P7）。
 */
import type { CalendarEvent } from './event'

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/**
 * 折行：每行 ≤ 75 字节，续行以一个空格开头（空格计入该行的 75 字节）。
 * 不切断多字节字符，也不把转义序列（`\\n`、`\\,` …）拆到两行（RFC 允许，但有些客户端会解析错）。
 */
export function foldLine(line: string): string {
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const units: string[] = []
  const chars = [...line]
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\\' && i + 1 < chars.length) {
      units.push(chars[i]! + chars[i + 1]!)
      i++
    } else units.push(chars[i]!)
  }
  const out: string[] = []
  let cur = ''
  let curBytes = 0
  for (const u of units) {
    const b = enc.encode(u).length
    if (curBytes + b > 75) {
      out.push(cur)
      cur = ' '
      curBytes = 1
    }
    cur += u
    curBytes += b
  }
  out.push(cur)
  return out.join('\r\n')
}

export function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function buildIcs(events: CalendarEvent[], opts: { name: string; now?: Date; method?: 'PUBLISH' | null; refreshHours?: number }): string {
  const stamp = icsDate((opts.now ?? new Date()).toISOString())
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fest-of-one//fest-of-one 1.0//ZH', 'CALSCALE:GREGORIAN']
  if (opts.method !== null) lines.push(`METHOD:${opts.method ?? 'PUBLISH'}`)
  lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`)
  if (opts.refreshHours) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${opts.refreshHours}H`, `X-PUBLISHED-TTL:PT${opts.refreshHours}H`)
  }
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${e.sequence}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      `URL:${e.url}`,
    )
    if (e.alarmMin != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:-PT${e.alarmMin}M`, 'END:VALARM')
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
