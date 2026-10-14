import { NextResponse } from 'next/server'
import { getSqlite } from '@/db/client'

/** 健康检查（docker compose healthcheck 用）。 */
export async function GET() {
  try {
    getSqlite().prepare('select 1').get()
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 })
  }
}
