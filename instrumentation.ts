/** Next.js 服务器启动时执行一次：让 Node 的 fetch 走 .env 里配置的代理（见 src/lib/proxy.ts）。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installProxyFromEnv } = await import('./src/lib/proxy')
    installProxyFromEnv()
  }
}
