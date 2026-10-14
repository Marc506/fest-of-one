import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Button({ variant = 'solid', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'solid' | 'outline' | 'ghost' }) {
  const base = 'inline-flex items-center justify-center gap-1 rounded-full px-4 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40'
  const v =
    variant === 'solid'
      ? 'bg-ink text-paper hover:opacity-90'
      : variant === 'outline'
        ? 'border border-ink hover:bg-ink hover:text-paper'
        : 'text-muted hover:text-ink'
  return <button className={`${base} ${v} ${className}`} {...props} />
}

export function Card({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-lg border border-rule p-5">
      {title && <h2 className="mb-3 font-serif text-lg">{title}</h2>}
      <div className="space-y-3 text-sm">{children}</div>
      {footer && <div className="mt-4 border-t border-rule pt-3 text-xs text-muted">{footer}</div>}
    </section>
  )
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'ink' }) {
  const t = tone === 'accent' ? 'border-accent text-accent' : tone === 'ink' ? 'border-ink text-ink' : 'border-rule text-muted'
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] leading-none ${t}`}>{children}</span>
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}
