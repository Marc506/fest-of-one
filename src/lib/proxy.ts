/**
 * 出站代理：Node 自带的 fetch 不走系统代理，也不读 HTTPS_PROXY。
 * .env 里设了 HTTPS_PROXY / HTTP_PROXY（例如 Clash 的 http://127.0.0.1:7890）时，
 * 让所有 fetch（TMDB、Claude API、Letterboxd、豆瓣、Google）都经过它；NO_PROXY 照常生效。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

let installed: string | null | undefined

export function proxyUrl(): string | null {
  const e = process.env
  return e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy || null
}

export function installProxyFromEnv(log: (l: string) => void = console.log): string | null {
  if (installed !== undefined) return installed
  installed = proxyUrl()
  if (installed) {
    setGlobalDispatcher(new EnvHttpProxyAgent())
    log(`[net] 出站请求走代理 ${maskProxy(installed)}`)
  }
  return installed
}

/** 隐去代理 URL 里的账号密码。 */
export function maskProxy(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@')
}
