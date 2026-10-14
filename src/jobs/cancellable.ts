/** 排队中可以由用户取消的任务类型（都幂等、没有依赖它们的请求行）。客户端组件也用，所以不引任何服务端模块。 */
export const CANCELLABLE_TYPES = ['build_taste', 'enrich_films', 'sync_source'] as const

export function isCancellable(type: string | undefined): boolean {
  return (CANCELLABLE_TYPES as readonly string[]).includes(type ?? '')
}

export const CANCELLED_MESSAGE = '已取消'
