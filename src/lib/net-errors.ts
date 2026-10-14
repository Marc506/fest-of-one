/** 把网络 / HTTP 错误翻译成用户能照着做的话。 */
import { HttpError } from './http'
import { maskProxy, proxyUrl } from './proxy'

const NET_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
])

export function errorCode(err: unknown): string | undefined {
  let e: unknown = err
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') return code
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

export function isNetworkError(err: unknown): boolean {
  const code = errorCode(err)
  if (code && NET_CODES.has(code)) return true
  const name = (err as { name?: string })?.name ?? ''
  const msg = err instanceof Error ? err.message : ''
  return name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || /fetch failed|network|socket/i.test(msg)
}

const PROXY_HINT =
  '如果你在中国大陆：开着代理软件，并在 .env 里加一行 HTTPS_PROXY=http://127.0.0.1:7890（端口换成你代理软件的 HTTP 代理端口，Clash 默认 7890），然后重启 pnpm dev 和 pnpm worker。'

export function explainError(err: unknown, service: 'TMDB' | 'Claude API'): string {
  const host = service === 'TMDB' ? 'api.themoviedb.org' : 'api.anthropic.com'
  if (err instanceof HttpError) {
    if (err.status === 401)
      return service === 'TMDB'
        ? 'TMDB 拒绝了令牌（HTTP 401）：检查 .env 里的 TMDB_READ_TOKEN 是不是 TMDB 设置页「API Read Access Token」那一长串（eyJ 开头），不是短的 API Key。'
        : 'Claude API 拒绝了密钥（HTTP 401）：检查 .env 里的 ANTHROPIC_API_KEY。'
    if (err.status === 403) return `${service} 返回 HTTP 403（被拒绝访问）。${PROXY_HINT}`
    return `${service} 返回 HTTP ${err.status}。`
  }
  const status = (err as { status?: number })?.status
  if (service === 'Claude API' && status === 401) return 'Claude API 拒绝了密钥（HTTP 401）：检查 .env 里的 ANTHROPIC_API_KEY。'
  if (service === 'Claude API' && status === 403) return `Claude API 返回 HTTP 403。${PROXY_HINT}`
  if (isNetworkError(err) || errorCode(err) === 'UND_ERR_ABORTED') {
    const code = errorCode(err)
    const head = `连不上 ${host}${code ? `（${code}）` : ''}`
    const proxy = proxyUrl()
    if (proxy)
      return `${head}：已经设置了代理 ${maskProxy(proxy)}，但仍然不通。确认代理软件正在运行、端口与它的「HTTP 代理端口」一致，必要时切到全局模式，然后重启 pnpm dev 和 pnpm worker。`
    return `${head}：网络不通。${PROXY_HINT}`
  }
  return `${service} 请求失败：${err instanceof Error ? err.message : String(err)}`
}
