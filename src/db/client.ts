import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type DB = BetterSQLite3Database<typeof schema>

type Holder = { db?: DB; sqlite?: Database.Database; path?: string }
// 挂到 globalThis，避免 Next dev 热重载时反复打开连接。
const g = globalThis as unknown as { __festDb?: Holder }
const holder: Holder = (g.__festDb ??= {})

export function resolveDbPath(url = process.env.DATABASE_URL ?? 'file:./data/fest.db'): string {
  const p = url.replace(/^file:/, '')
  if (p === ':memory:' || p === '') return ':memory:'
  return resolve(p)
}

export function openDatabase(path: string): { db: DB; sqlite: Database.Database } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  // web 与 worker 两个进程共用一个文件
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')
  return { db: drizzle(sqlite, { schema }), sqlite }
}

export function getDb(): DB {
  const path = resolveDbPath()
  if (!holder.db || holder.path !== path) {
    holder.sqlite?.close()
    const { db, sqlite } = openDatabase(path)
    Object.assign(holder, { db, sqlite, path })
  }
  return holder.db!
}

export function getSqlite(): Database.Database {
  getDb()
  return holder.sqlite!
}

/** 测试用：关闭并丢弃当前连接。 */
export function closeDb(): void {
  holder.sqlite?.close()
  holder.db = undefined
  holder.sqlite = undefined
  holder.path = undefined
}

/**
 * 同步事务（better-sqlite3）。已在事务中时直接执行（不嵌套 BEGIN），
 * 让 repo 函数既能单独调用、也能被外层批量写入包起来。
 */
export function tx<T>(fn: () => T): T {
  const sqlite = getSqlite()
  if (sqlite.inTransaction) return fn()
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    sqlite.exec('COMMIT')
    return r
  } catch (err) {
    sqlite.exec('ROLLBACK')
    throw err
  }
}
