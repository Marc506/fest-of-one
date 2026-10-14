import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'

export function newId(): string {
  return nanoid()
}

/** 32 字节随机、URL 安全，用于 webcal 订阅 token。 */
export function newCalendarToken(): string {
  return randomBytes(32).toString('base64url')
}
