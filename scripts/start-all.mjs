// 单容器同时跑 web + worker（SQLite 卷只能挂一台机器的平台用）。任一进程退出则整体退出，交给平台重启。
import { spawn, spawnSync } from 'node:child_process'

const migrate = spawnSync('pnpm', ['db:migrate'], { stdio: 'inherit' })
if (migrate.status !== 0) process.exit(migrate.status ?? 1)

const procs = [
  spawn('pnpm', ['start'], { stdio: 'inherit' }),
  spawn('pnpm', ['worker'], { stdio: 'inherit' }),
]
let exiting = false
const stopAll = (code) => {
  if (exiting) return
  exiting = true
  for (const p of procs) p.kill('SIGTERM')
  setTimeout(() => process.exit(code), 6000).unref()
}
for (const p of procs) p.on('exit', (code) => stopAll(code ?? 1))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0))
