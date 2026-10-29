import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'dcm-boot-'))
const home = join(root, 'dsh-home')
const stateDir = join(home, 'cookie-meter')
const db = join(root, 'Cookies')
mkdirSync(stateDir, { recursive: true })

copyFileSync('C:/Users/11941/.dsh/attachments/v1/objects/58/582b575c49d0dc2ca523b52cd55467d6ec8d805daacba1303b8a664627a97253', db)
writeFileSync(db + '-journal', 'x')

const marker = join(stateDir, 'pending-clean.json')
writeFileSync(
  marker,
  JSON.stringify({ at: new Date().toISOString(), pid: 999999, db, note: 'smoke' }, null, 2),
)

process.env.DSH_HOME = home
process.env.DSH_COOKIE_METER_DB = db

const mod = await import(pathToFileURL('D:/deepseek工作区/dsh-cookie-meter/index.js').href)

const ctx = {
  get() {
    return undefined
  },
  effect(cb) {
    const dispose = cb()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(deps, fn) {
    fn({
      effect(cb) {
        cb()
      },
      webServer: {
        register() {
          return () => undefined
        },
      },
    })
  },
}

mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 600))

const logPath = join(stateDir, 'clean.log')
console.log('log:\n' + (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'))
console.log('db still exists =', existsSync(db), '| journal exists =', existsSync(db + '-journal'))
console.log('marker still exists =', existsSync(marker))

const route = mod.name
console.log('module name =', route)

rmSync(root, { recursive: true, force: true })
