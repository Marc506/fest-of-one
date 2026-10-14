'use client'

import { useState } from 'react'
import { DEFAULT_RECENCY, RECENCY_LABELS, RECENCY_LEVELS, type RecencyLevelT } from '@/taste/recency'
import { Button } from '../_components/ui'

type Prefs = {
  day_bounds: { start: string; end: string }
  buffer_min: number
  max_films_per_day: number
  weekday_max_runtime_min: number
  preferred_start: string | null
  alarm_min: number | null
  recency_weighting?: RecencyLevelT
  writing_sample?: string
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
        setMsg(res.ok ? (body.taste_rebuild_job_id ? '已保存，正在重建画像（约一两分钟）' : '已保存') : (body.error?.message ?? '保存失败'))
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
      <label className="space-y-1 sm:col-span-2">
        <span className="block text-muted">近期权重：越早看的记录，对画像和策展的影响越小</span>
        <select
          value={p.recency_weighting ?? DEFAULT_RECENCY}
          onChange={(e) => set('recency_weighting', e.target.value as RecencyLevelT)}
          className={`w-full sm:w-80 ${input}`}
        >
          {RECENCY_LEVELS.map((k) => (
            <option key={k} value={k}>
              {RECENCY_LABELS[k]}
              {k === DEFAULT_RECENCY ? ' · 默认' : ''}
            </option>
          ))}
        </select>
        <span className="block text-xs text-muted">
          喜欢、打 ≥4.5★ 或 ≤2★ 的老片保留大部分权重；重看会刷新。所有看过的片仍然都会给策展人看、也永远不会被排进影展。修改后自动重建画像（一次 Claude 调用）。
        </span>
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className="block text-muted">你自己写的影评或观影笔记（可选）</span>
        <textarea
          value={p.writing_sample ?? ''}
          onChange={(e) => set('writing_sample', e.target.value.slice(0, 8000))}
          rows={8}
          placeholder="粘贴几段你写过的东西，长短都行。"
          className={`w-full ${input} leading-relaxed`}
        />
        <span className="block text-xs text-muted">
          策展人会把它当作你口味最直接的证据，写画像和场刊时也参考它的写法（不会照抄）。豆瓣短评导入时已经自动带上，这里适合放更长的文字。{(p.writing_sample ?? '').length}/8000 字。修改后自动重建画像。
        </span>
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
