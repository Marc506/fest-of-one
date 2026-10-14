/** Route Handler 公共工具：统一错误格式 `{ error: { code, message } }`、登录校验、zod 入参。 */
import { NextResponse } from 'next/server'
import { ZodError, type ZodType } from 'zod'
import { auth } from '@/auth'
import { getUser } from '@/db/repo/users'
import type { User } from '@/db/schema'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status })
}

export async function currentUser(): Promise<User | null> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) return null
  return getUser(id) ?? null
}

export async function requireApiUser(): Promise<User> {
  const user = await currentUser()
  if (!user) throw new ApiError(401, 'unauthorized', '请先登录')
  return user
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw new ApiError(400, 'bad_json', '请求体不是合法 JSON')
  }
  return schema.parse(body)
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>

/** 包一层：把 ApiError / ZodError / 其他异常统一转成错误 JSON。 */
export function route<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof ApiError) return apiError(err.status, err.code, err.message)
      if (err && typeof err === 'object' && (err as { userFacing?: boolean }).userFacing)
        return apiError(422, 'unprocessable', (err as Error).message)
      if (err instanceof ZodError)
        return apiError(400, 'invalid_input', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      // next/navigation 的 redirect / notFound 通过 throw 实现，要继续抛
      if (err && typeof err === 'object' && 'digest' in err) throw err
      console.error('[api]', err)
      return apiError(500, 'internal', '服务器内部错误')
    }
  }
}
