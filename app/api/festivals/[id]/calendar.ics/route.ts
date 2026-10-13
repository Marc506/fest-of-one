import { eventsForFestival } from '@/calendar/feed'
import { buildIcs } from '@/calendar/ics'
import { getFestivalForUser } from '@/db/repo/festivals'
import { ApiError, requireApiUser, route } from '@/lib/api'

/** 9.1：一个 VCALENDAR，含该影展的全部场次；macOS / iOS 打开即导入。 */
export const GET = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) throw new ApiError(404, 'not_found', '影展不存在')
  const ics = buildIcs(eventsForFestival(f, user), { name: f.title })
  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="festival-${f.id}.ics"; filename*=UTF-8''${encodeURIComponent(f.title)}.ics`,
      'cache-control': 'no-store',
    },
  })
})
