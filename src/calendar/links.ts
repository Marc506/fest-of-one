/** Google 日历模板链接（9.3）：单场、零授权。location 留空。 */
import type { CalendarEvent } from './event'
import { icsDate } from './ics'

export function googleTemplateLink(e: CalendarEvent): string {
  const q = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(e.summary)}`,
    `dates=${icsDate(e.start)}/${icsDate(e.end)}`,
    `details=${encodeURIComponent(e.description)}`,
    'location=',
  ].join('&')
  return `https://calendar.google.com/calendar/render?${q}`
}

/** webcal 订阅地址（9.2）。 */
export function webcalUrls(baseUrl: string, token: string): { webcal: string; https: string } {
  const https = `${baseUrl.replace(/\/$/, '')}/api/cal/${token}.ics`
  return { https, webcal: https.replace(/^https?:/, 'webcal:') }
}
