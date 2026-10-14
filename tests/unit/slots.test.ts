import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS } from '@/db/types'
import { checkFeasibility, currentWeekStart, deriveWindows, localToUtc, maxFittingRuntime, slotsSummary } from '@/scheduler/slots'

const prefs = DEFAULT_PREFS
const WEEK = '2026-10-19' // Monday

describe('deriveWindows (8.1 / 8.2)', () => {
  it('merges adjacent and overlapping blocks in available mode', () => {
    const w = deriveWindows(
      {
        mode: 'available',
        tz: 'Asia/Shanghai',
        prefs,
        blocks: [
          { dow: 0, start: '19:00', end: '20:00' },
          { dow: 0, start: '20:00', end: '21:30' },
          { dow: 0, start: '21:00', end: '23:00' },
          { dow: 5, start: '14:00', end: '24:00' },
        ],
      },
      WEEK,
    )
    expect(w).toEqual([
      { date: '2026-10-19', dow: 0, start: 1140, end: 1380 },
      { date: '2026-10-24', dow: 5, start: 840, end: 1440 },
    ])
  })

  it('takes the complement within day bounds in unavailable mode', () => {
    const w = deriveWindows({ mode: 'unavailable', tz: 'Asia/Shanghai', prefs, blocks: [{ dow: 2, start: '09:00', end: '18:30' }] }, WEEK)
    const wed = w.filter((x) => x.dow === 2)
    expect(wed).toEqual([{ date: '2026-10-21', dow: 2, start: 1110, end: 1440 }])
    expect(w.filter((x) => x.dow === 3)).toEqual([{ date: '2026-10-22', dow: 3, start: 600, end: 1440 }])
  })

  it('cuts time that has already passed this week', () => {
    const now = new Date('2026-10-21T12:02:00Z') // 20:02 in Shanghai, Wednesday
    const w = deriveWindows({ mode: 'available', tz: 'Asia/Shanghai', prefs, blocks: [0, 1, 2, 3].map((dow) => ({ dow, start: '19:00', end: '23:00' })) }, WEEK, now)
    expect(w.map((x) => [x.date, x.start])).toEqual([
      ['2026-10-21', 1205],
      ['2026-10-22', 1140],
    ])
  })

  it('converts local minutes to UTC across midnight and DST', () => {
    expect(localToUtc('2026-10-19', 1170, 'Asia/Shanghai')).toBe('2026-10-19T11:30:00.000Z')
    expect(localToUtc('2026-10-19', 1440, 'Asia/Shanghai')).toBe('2026-10-19T16:00:00.000Z')
    // New York: DST ends 2026-11-01
    expect(localToUtc('2026-10-31', 1200, 'America/New_York')).toBe('2026-11-01T00:00:00.000Z')
    expect(localToUtc('2026-11-01', 1200, 'America/New_York')).toBe('2026-11-02T01:00:00.000Z')
  })

  it('computes the current Monday in the user time zone', () => {
    expect(currentWeekStart('Asia/Shanghai', new Date('2026-10-18T17:00:00Z'))).toBe('2026-10-19') // Mon 01:00 local
    expect(currentWeekStart('America/New_York', new Date('2026-10-18T17:00:00Z'))).toBe('2026-10-12') // Sun local
  })
})

describe('feasibility (8.2)', () => {
  const windows = deriveWindows(
    { mode: 'available', tz: 'Asia/Shanghai', prefs, blocks: [{ dow: 1, start: '19:30', end: '22:30' }, { dow: 5, start: '13:00', end: '17:30' }] },
    WEEK,
  )
  it('caps days to usable days and reports capacity', () => {
    const f = checkFeasibility(windows, 4, 2, prefs)
    expect(f.usableDays).toBe(2)
    expect(f.days).toBe(2)
    expect(f.notes[0]).toMatch(/调整为 2/)
    expect(f.capacity).toBe(3)
    expect(f.error).toBeNull()
  })
  it('fails when the films cannot fit', () => {
    expect(checkFeasibility(windows, 2, 5, prefs).error).toMatch(/最多排 3 部/)
    expect(checkFeasibility([], 2, 1, prefs).error).toMatch(/没有可用时间/)
  })
  it('summarises slots for the prompt', () => {
    const f = checkFeasibility(windows, 2, 2, prefs)
    expect(maxFittingRuntime(windows, prefs)).toBe(250)
    expect(slotsSummary(f, prefs)).toContain('longest 4.5h (Sat)')
  })
})
