import Link from 'next/link'
import { googleConfigured, hasCalendarScope } from '@/calendar/google'
import { webcalUrls } from '@/calendar/links'
import { llmCostSummary } from '@/db/repo/llm'
import { listSources } from '@/db/repo/sources'
import { env } from '@/lib/env'
import { requirePageUser } from '@/lib/session'
import { cacheHitRate } from '@/llm/cost'
import { Button, Card } from '../_components/ui'
import { connectGoogleFromSettings } from './actions'
import { RotateToken, SettingsForm } from './SettingsForm'

export const dynamic = 'force-dynamic'

const PURPOSE = { taste_memo: '画像备忘', ideate: '概念（Call A）', audit: '审查（Call B）', other: '其他' } as const

function CostTable({ rows }: { rows: ReturnType<typeof llmCostSummary> }) {
  if (!rows.length) return <p className="text-xs text-muted">还没有调用记录。</p>
  const total = rows.reduce(
    (a, r) => ({ calls: a.calls + r.calls, input: a.input + (r.input ?? 0), cacheWrite: a.cacheWrite + (r.cacheWrite ?? 0), cacheRead: a.cacheRead + (r.cacheRead ?? 0), output: a.output + (r.output ?? 0), cost: a.cost + (r.cost ?? 0) }),
    { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 },
  )
  const hit = (r: { input: number | null; cacheWrite: number | null; cacheRead: number | null }) =>
    `${(cacheHitRate({ input_tokens: r.input ?? 0, cache_creation_input_tokens: r.cacheWrite ?? 0, cache_read_input_tokens: r.cacheRead ?? 0 }) * 100).toFixed(0)}%`
  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-muted">
        <tr className="text-left">
          <th className="py-1 font-normal">用途</th>
          <th className="font-normal">次数</th>
          <th className="font-normal">输入 / 缓存写 / 缓存读 / 输出</th>
          <th className="font-normal">缓存命中</th>
          <th className="text-right font-normal">美元</th>
        </tr>
      </thead>
      <tbody>
        {[...rows.map((r) => ({ ...r, label: PURPOSE[r.purpose] })), { ...total, purpose: 'total' as const, label: '合计' }].map((r) => (
          <tr key={r.purpose} className="border-t border-rule">
            <td className="py-1">{r.label}</td>
            <td>{r.calls}</td>
            <td>
              {r.input ?? 0} / {r.cacheWrite ?? 0} / {r.cacheRead ?? 0} / {r.output ?? 0}
            </td>
            <td>{hit(r)}</td>
            <td className="text-right">${(r.cost ?? 0).toFixed(3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default async function SettingsPage() {
  const user = await requirePageUser()
  const sources = listSources(user.id)
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString()
  const g = googleConfigured()
  const connected = g && hasCalendarScope(user.id)
  return (
    <div className="space-y-8">
      <h1 className="font-serif text-3xl">设置</h1>

      <Card title="偏好">
        <SettingsForm locale={user.locale} tz={user.tz} prefs={user.prefs} />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="观影记录来源" footer="删除来源会一并删除从它导入的观影记录。">
          <p>
            已接入 {sources.length} 个来源。
            <Link className="ml-2 underline" href="/onboarding">
              管理来源
            </Link>
          </p>
        </Card>
        <Card title="日历" footer="订阅地址只暴露排片，不暴露评分；泄露了就轮换。Google 刷新订阅源很慢（几小时到一天）。">
          <RotateToken initial={webcalUrls(env().APP_BASE_URL, user.calendarToken)} />
          <div className="border-t border-rule pt-3">
            <p className="mb-2">Google 日历：{!g ? '服务器未配置 Google 登录' : connected ? '已授权（可一键写入）' : '未授权'}</p>
            {g && !connected && (
              <form action={connectGoogleFromSettings}>
                <Button variant="outline" type="submit">
                  授权 Google 日历
                </Button>
              </form>
            )}
          </div>
        </Card>
      </div>

      <Card title="Claude API 用量" footer="成本按 claude-opus-5-5 价目估算（输入 $4 / 输出 $20 / 缓存读 $0.20 每百万 token；1 小时缓存写按 2× 输入价）。">
        <div className="space-y-4">
          <div>
            <h3 className="mb-1 text-xs text-muted">近 30 天</h3>
            <CostTable rows={llmCostSummary(user.id, since30)} />
          </div>
          <div>
            <h3 className="mb-1 text-xs text-muted">全部</h3>
            <CostTable rows={llmCostSummary(user.id)} />
          </div>
        </div>
      </Card>
    </div>
  )
}
