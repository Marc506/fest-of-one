import { signIn } from '@/auth'

/** DEV_LOGIN=1 时：GET /api/auth/dev 以 dev@local 直接登录。 */
export async function GET(req: Request) {
  if (process.env.DEV_LOGIN !== '1') return new Response('Not found', { status: 404 })
  const to = new URL(req.url).searchParams.get('to') ?? '/plan'
  await signIn('dev', { redirectTo: to.startsWith('/') ? to : '/plan' })
  return new Response(null, { status: 204 })
}
