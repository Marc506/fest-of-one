'use client'

import { useState } from 'react'
import { Button } from '../_components/ui'

type Prefs = {
  day_bounds: { start: string; end: string }
  buffer_min: number
  max_films_per_day: number
  weekday_max_runtime_min: number
  preferred_start: string | null
  alarm_min: number | null
}

const TZS = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney']

export function SettingsForm(props: { locale: 'zh-CN' | 'en'; tz: string; prefs: Prefs }) {
  const [locale, setLocale] = useState(props.locale)
  const [tz, setTz] = useState(props.tz)
  const [p, setP] = useState(props.prefs)
  const [msg, setMsg] = useState<string | null>(null)
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setP((x) => ({ ...x, [k]: v }))
  const num = (v: string) => (v === '' ? 0 : Number(v))
  const input = 'rounded border border-rule bg-transparent px-2 py-1'
  return (
    <form
      className="grid max-w-2xl gap-4 text-sm sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault()
        setMsg(null)
        const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale, tz, prefs: p }) })
        const body = await res.json()
        setMsg(res.ok ? '已保存' : (body.error?.message ?? '保存失败'))
      }}
    >
      <label className="space-y-1">
        <span className="block text-muted">时区</span>
        <input list="tzs" value={tz} onChange={(e) => setTz(e.target.value)} className={`w-full ${input}`} />
        <datalist id="tzs">
          {TZS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      <label className="space-y-1">
        <span className="block text-muted">策展陈述 / 场刊语言</span>
        <select value={locale} onChange={(e) => setLocale(e.target.value as 'zh-CN' | 'en')} className={`w-full ${input}`}>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className="block text-muted">「涂没空」模式下一天的边界</span>
        <span className="flex items-center gap-2">
          <input type="time" value={p.day_bounds.start} onChange={(e) => set('day_bounds', { ...p.day_bounds, start: e.target.value })} className={input} />–
          <input
            value={p.day_bounds.end}
            onChange={(e) => set('day_bounds', { ...p.day_bounds, end: e.target.value })}
            className={`w-20 ${input}`}
            placeholder="24:00"
          />
        </span>
      </label>
      <label className="space-y-1">
        <span className="block text-muted">优先开场时间（留空 = 尽早）</span>
        <input type="time" value={p.preferred_start ?? ''} onChange={(e) => set('preferred_start', e.target.value || null)} className={input} />
      </label>
      <label className="space-y-1">
        <span className="block text-muted">场次间隔（分钟）</span>
        <input type="number" min={0} max={240} value={p.buffer_min} onChange={(e) => set('buffer_min', num(e.target.value))} className={`w-24 ${input}`} />
      </label>
      <label className="space-y-1">
        <span className="block text-muted">每天最多几部</span>
        <input type="number" min={1} max={6} value={p.max_films_per_day} onChange={(e) => set('max_films_per_day', num(e.target.value))} className={`w-24 ${input}`} />
      </label>
      <label className="space-y-1">
        <span className="block text-muted">工作日最长片长（分钟）</span>
        <input type="number" min={60} max={600} value={p.weekday_max_runtime_min} onChange={(e) => set('weekday_max_runtime_min', num(e.target.value))} className={`w-24 ${input}`} />
      </label>
      <label className="space-y-1">
        <span className="block text-muted">日历提醒（开场前几分钟，留空 = 不提醒）</span>
        <input
          type="number"
          min={0}
          max={1440}
          value={p.alarm_min ?? ''}
          onChange={(e) => set('alarm_min', e.target.value === '' ? null : num(e.target.value))}
          className={`w-24 ${input}`}
        />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit">保存</Button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </form>
  )
}

export function RotateToken({ initial }: { initial: { webcal: string; https: string } }) {
  const [urls, setUrls] = useState(initial)
  return (
    <div className="space-y-2 text-sm">
      <p>
        <a className="underline" href={urls.webcal}>
          webcal 订阅
        </a>
        <span className="ml-2 break-all text-xs text-muted">{urls.https}</span>
      </p>
      <Button
        variant="ghost"
        onClick={async () => {
          if (!confirm('轮换后旧的订阅地址立即失效，需要在日历里重新订阅。继续？')) return
          const res = await fetch('/api/settings/calendar-token/rotate', { method: 'POST' })
          if (res.ok) setUrls(await res.json())
        }}
      >
        轮换订阅地址
      </Button>
    </div>
  )
}
