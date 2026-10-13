/**
 * 豆瓣 Cookie 加密（12 章）：AES-256-GCM，密钥 = env APP_ENCRYPTION_KEY（32 字节 base64）。
 * 密文格式 `v1:<iv b64>:<tag b64>:<data b64>`。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY
  if (!raw) throw new Error('未配置 APP_ENCRYPTION_KEY（32 字节 base64），无法保存豆瓣 Cookie')
  const k = Buffer.from(raw, 'base64')
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY 必须是 32 字节的 base64')
  return k
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, data] = enc.split(':')
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('无法识别的密文格式')
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
}
