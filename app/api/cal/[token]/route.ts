import { feedEvents } from '@/calendar/feed'
import { buildIcs } from '@/calendar/ics'
import { getUserByCalendarToken } from '@/db/repo/users'

/** 9.2：webcal 订阅源，token 鉴权（无 session）。只暴露排片，不暴露评分。 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const user = getUserByCalendarToken(token.replace(/\.ics$/, ''))
  if (!user) return new Response('Not found', { status: 404 })
  const ics = buildIcs(feedEvents(user), { name: '一个人的影展', refreshHours: 6 })
  return new Response(ics, {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300' },
  })
}
