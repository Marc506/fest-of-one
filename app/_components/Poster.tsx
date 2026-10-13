import Image from 'next/image'

/** TMDB 海报；无海报时显示标题占位。 */
export function Poster({ path, title, size = 'w342', className = '' }: { path: string | null; title: string; size?: 'w92' | 'w185' | 'w342'; className?: string }) {
  const w = size === 'w92' ? 92 : size === 'w185' ? 185 : 342
  if (!path)
    return (
      <div
        className={`flex aspect-[2/3] items-center justify-center overflow-hidden bg-rule/60 p-1 text-center font-serif text-muted ${size === 'w92' ? 'text-sm' : 'text-xs'} ${className}`}
        title={title}
      >
        {size === 'w92' ? [...title.trim()][0] : <span className="line-clamp-4">{title}</span>}
      </div>
    )
  return (
    <Image
      src={`https://image.tmdb.org/t/p/${size}${path}`}
      alt={title}
      width={w}
      height={Math.round(w * 1.5)}
      unoptimized
      className={`aspect-[2/3] object-cover ${className}`}
    />
  )
}
