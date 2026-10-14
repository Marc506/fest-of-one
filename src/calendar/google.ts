/**
 * Google Calendar API 批量写入（9.4）。
 * - 令牌来自 Auth.js 的 account 表（provider = google）；过期用 refresh_token 刷新并写回。
 * - insert 时带 iCalUID = screening.calendar_uid：重复插入返回 409 → 按 iCalUID 查到已有事件再 update（幂等）。
 * - 已有 google_event_id → update；reroll / dismiss → delete（404 / 410 视为已删除）。
 * - LOCATION 不写（P7）。
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { accounts } from '@/db/schema'
import type { FetchLike } from '@/lib/http'
import type { CalendarEvent } from './event'

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export class GoogleAuthRequired extends Error {
  readonly userFacing = true
  constructor(message = '需要先授权 Google 日历') {
    super(message)
  }
}

export function googleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET)
}

export function googleAccount(userId: string) {
  return getDb()
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'google')))
    .get()
}

export function hasCalendarScope(userId: string): boolean {
  const a = googleAccount(userId)
  return Boolean(a?.refresh_token || a?.access_token) && (a?.scope ?? '').split(/[\s,]+/).includes(CALENDAR_SCOPE)
}

/** 取可用的 access token；快过期（< 60s）时用 refresh_token 刷新并写回 account 表。 */
export async function accessToken(userId: string, f: FetchLike = (i, init) => fetch(i, init), now = Date.now()): Promise<string> {
  const a = googleAccount(userId)
  if (!a || !(a.scope ?? '').includes(CALENDAR_SCOPE)) throw new GoogleAuthRequired()
  if (a.access_token && a.expires_at && a.expires_at * 1000 > now + 60_000) return a.access_token
  if (!a.refresh_token) throw new GoogleAuthRequired('Google 授权已过期，请重新授权')
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? '',
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: a.refresh_token,
    }),
  })
  if (!res.ok) throw new GoogleAuthRequired('Google 授权已失效，请重新授权')
  const body = (await res.json()) as { access_token: string; expires_in: number; scope?: string }
  getDb()
    .update(accounts)
    .set({ access_token: body.access_token, expires_at: Math.floor(now / 1000) + body.expires_in, ...(body.scope ? { scope: body.scope } : {}) })
    .where(and(eq(accounts.provider, 'google'), eq(accounts.providerAccountId, a.providerAccountId)))
    .run()
  return body.access_token
}

export function toGoogleEvent(e: CalendarEvent) {
  return {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start, timeZone: 'UTC' },
    end: { dateTime: e.end, timeZone: 'UTC' },
    iCalUID: e.uid,
    sequence: e.sequence,
    source: { title: '一个人的影展', url: e.url },
    reminders: e.alarmMin != null ? { useDefault: false, overrides: [{ method: 'popup', minutes: e.alarmMin }] } : { useDefault: true },
  }
}

export class GoogleCalendarClient {
  constructor(
    private readonly token: string,
    private readonly f: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    return this.f(url, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  /** 插入或更新，返回 Google event id。 */
  async upsert(e: CalendarEvent, existingId: string | null): Promise<string> {
    const payload = toGoogleEvent(e)
    if (existingId) {
      const { iCalUID: _uid, ...update } = payload
      const res = await this.call('PUT', `${API}/${encodeURIComponent(existingId)}`, update)
      if (res.ok) return ((await res.json()) as { id: string }).id
      if (res.status !== 404 && res.status !== 410) throw new Error(`Google 日历更新失败：HTTP ${res.status}`)
    }
    const res = await this.call('POST', API, payload)
    if (res.ok) return ((await res.json()) as { id: string }).id
    if (res.status === 409) {
      const found = await this.call('GET', `${API}?iCalUID=${encodeURIComponent(e.uid)}&showDeleted=true`)
      const items = found.ok ? ((await found.json()) as { items?: { id: string }[] }).items ?? [] : []
      if (items[0]) {
        const { iCalUID: _uid, ...update } = payload
        const up = await this.call('PUT', `${API}/${encodeURIComponent(items[0].id)}`, { ...update, status: 'confirmed' })
        if (up.ok) return items[0].id
      }
    }
    if (res.status === 401 || res.status === 403) throw new GoogleAuthRequired('Google 日历拒绝了请求，请重新授权')
    throw new Error(`Google 日历写入失败：HTTP ${res.status}`)
  }

  async remove(eventId: string): Promise<void> {
    const res = await this.call('DELETE', `${API}/${encodeURIComponent(eventId)}`)
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google 日历删除失败：HTTP ${res.status}`)
  }
}
