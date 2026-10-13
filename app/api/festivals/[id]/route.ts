import { NextResponse } from 'next/server'
import { getFestivalForUser, getFestivalRequest, getScreenings } from '@/db/repo/festivals'
import { getFilms } from '@/db/repo/library'
import { ApiError, requireApiUser, route } from '@/lib/api'

export const GET = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) throw new ApiError(404, 'not_found', '影展不存在')
  const req = getFestivalRequest(f.requestId)
  const screenings = getScreenings(f.id)
  const films = getFilms(screenings.map((s) => s.tmdbId))
  return NextResponse.json({
    festival: {
      id: f.id,
      kind: f.kind,
      subject: f.subject,
      title: f.title,
      statement_md: f.statementMd,
      status: f.status,
      week_start: req?.weekStart,
      created_at: f.createdAt,
      rerolls_used: req?.rerollCount ?? 0,
    },
    screenings: screenings.map((s) => ({
      id: s.id,
      tmdb_id: s.tmdbId,
      position: s.position,
      role: s.role,
      program_note_md: s.programNoteMd,
      starts_at: s.startsAt,
      ends_at: s.endsAt,
      unscheduled_reason: s.unscheduledReason,
      feedback: s.feedback,
    })),
    films: films.map((m) => ({
      tmdb_id: m.tmdbId,
      title_en: m.titleEn,
      title_zh: m.titleZh,
      original_title: m.originalTitle,
      year: m.year,
      runtime_min: m.runtimeMin,
      directors: m.directors.map((d) => d.name),
      countries: m.countries,
      poster_path: m.posterPath,
    })),
  })
})
