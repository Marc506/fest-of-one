/** 页面（Server Component）侧的登录校验。 */
import { redirect } from 'next/navigation'
import { currentUser } from './api'
import type { User } from '@/db/schema'

export async function requirePageUser(): Promise<User> {
  const user = await currentUser()
  if (!user) redirect('/')
  return user
}
