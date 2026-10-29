/**
 * Cookie 百分表 —— 宿主（Node）侧。
 *
 * 三件事：
 *  1. 数出 Chromium jar 里攒了多少条 `dsh-auth-*`，折算成请求头占用百分比；
 *  2. DSH 没锁库时"一键清理"当场删掉；
 *  3. DSH 锁着库时（运行期间必然如此）记一笔"待清理"，**下次进入时**在 shell 打开库
 *     之前把它删掉 —— 不强制重启，点完照常用，下次启动就是干净的。
 *
 * 为什么不能数请求头：桌面版 renderer 的请求是外壳经 IPC 转发到 Host 的，只带
 * 当前这一次启动的那一条 cookie，看不到 jar 的真实体积。只能读 `Network/Cookies`
 * 本体，而它在运行期间被独占打开（ERROR_SHARING_VIOLATION）——probe.js 负责借
 * 外壳进程已打开的句柄把文件读出来；读不到就老实说读不到，不猜数。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { cookieDatabasePath, probeJar } from './probe.js'

export const name = 'dsh-cookie-meter'

/** 插件自己的接口路径，客户端 fetch 同一个地址。 */
const ROUTE = '/dsh-cookie-meter/api'
/** Node 默认 http 请求头上限，超过它服务端直接回 431。 */
const MAX_HEADER = 16384
/** 一条 `dsh-auth-*` 在请求头里的实际字节数（name 52 + '=' + value 173 + '; '）。 */
const BYTES_PER_COOKIE = 228
/** 16384 / 228 ≈ 71.86：第 72 条就把请求头顶爆。 */
const THRESHOLD = 71
/** 借句柄要扫一遍全机句柄表，别让轮询把它当免费接口——缓存 60 秒。 */
const CACHE_MS = 60 * 1000
/** 就算前端催，两次真实探测之间也至少隔 5 秒。 */
const MIN_PROBE_GAP_MS = 5 * 1000

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

const STATE_DIR = join(dshHome(), 'cookie-meter')
/** "下次进入时清理"的待办标记；存在即代表已经点过清理。 */
const MARKER = join(STATE_DIR, 'pending-clean.json')
/** 清理日志，排查用。 */
const LOG = join(STATE_DIR, 'clean.log')

function logLine(message) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    let previous = ''
    try {
      previous = readFileSync(LOG, 'utf8')
    } catch (err) {
      previous = ''
    }
    const trimmed = previous.length > 64 * 1024 ? previous.slice(-48 * 1024) : previous
    writeFileSync(LOG, trimmed + `${new Date().toISOString()} ${message}\r\n`, 'utf8')
  } catch (err) {
    /* 记日志失败不影响功能 */
  }
}

function readMarker() {
  try {
    const value = JSON.parse(readFileSync(MARKER, 'utf8'))
    if (value !== null && typeof value === 'object') return value
  } catch (err) {
    return undefined
  }
  return undefined
}

function writeMarker(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(MARKER, JSON.stringify(payload, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function clearMarker() {
  try {
    if (existsSync(MARKER)) unlinkSync(MARKER)
    return true
  } catch (err) {
    return false
  }
}

function headerValue(headers, wanted) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const got = headers.get(wanted)
    return typeof got === 'string' ? got : undefined
  }
  const found = headers[wanted]
  return typeof found === 'string' ? found : undefined
}

function parseAuthority(authority) {
  try {
    return new URL('http://' + authority)
  } catch (err) {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * 本机进程能不能直接打这个路由：优先借 harness 自己的门禁，拿不到时退回本地复述
 * （只认 loopback 的 Host 头，拒绝跨站标记，Origin 必须同源）。
 */
function makeFence(ctx) {
  function harnessConnection() {
    for (const source of [ctx, ctx.root]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const connection = source.get('connection')
        if (connection === undefined || connection === null) continue
        if (typeof connection.requestRejection !== 'function') continue
        return connection
      } catch (err) {
        /* 换下一个来源 */
      }
    }
    return undefined
  }

  return function refusal(request) {
    const connection = harnessConnection()
    if (connection !== undefined) {
      try {
        return connection.requestRejection(request)
      } catch (err) {
        /* 退回复述 */
      }
    }
    const headers = request === undefined || request === null ? undefined : request.headers
    const host = headerValue(headers, 'host')
    if (host === undefined) return 403
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return 403
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (headerValue(headers, 'sec-fetch-site') === 'cross-site') return 403
    const origin = headerValue(headers, 'origin')
    if (origin === undefined) return undefined
    try {
      return new URL(origin).host === hostUrl.host ? undefined : 403
    } catch (err) {
      return 403
    }
  }
}

let probeCache

async function inspect(force) {
  const now = Date.now()
  if (probeCache !== undefined) {
    const age = now - probeCache.at
    if (age < CACHE_MS && !force) return { ...probeCache.payload, cached: true }
    if (age < MIN_PROBE_GAP_MS) return { ...probeCache.payload, cached: true }
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  const result = probeJar()
  const payload = result.ok
    ? { ok: true, count: result.count, source: result.source, probeMs: result.elapsedMs, fileSize: result.fileSize }
    : { ok: false, reason: result.reason, fileSize: result.fileSize }
  probeCache = { at: Date.now(), payload }
  return { ...payload, cached: false }
}

function describe(count, extra) {
  const bytes = count * BYTES_PER_COOKIE
  const pct = Math.round((bytes / MAX_HEADER) * 1000) / 10
  return {
    count,
    bytes,
    pct: pct > 100 ? 100 : pct,
    rawPct: pct,
    maxHeader: MAX_HEADER,
    bytesPerCookie: BYTES_PER_COOKIE,
    threshold: THRESHOLD,
    remaining: count >= THRESHOLD ? 0 : THRESHOLD - count,
    level: count >= THRESHOLD ? 'danger' : count * BYTES_PER_COOKIE > MAX_HEADER / 2 ? 'warn' : 'ok',
    updatedAt: new Date().toISOString(),
    ...extra,
  }
}

/** 直接删库：DSH 没在跑（或没锁这条库）时一次就成。 */
function deleteJar() {
  const file = cookieDatabasePath()
  const journal = file + '-journal'
  const results = []
  for (const target of [file, journal]) {
    if (!existsSync(target)) {
      results.push({ file: target, missing: true })
      continue
    }
    try {
      unlinkSync(target)
      results.push({ file: target, deleted: true })
    } catch (err) {
      const code = err === null || err === undefined ? 'UNKNOWN' : err.code ?? String(err)
      results.push({ file: target, error: String(code) })
    }
  }
  const locked = results.some(
    (item) => item.error === 'EPERM' || item.error === 'EBUSY' || item.error === 'EACCES',
  )
  return { locked, deleted: results.some((item) => item.deleted === true), results }
}

/*
 * 退出兜底清理：等 DSH 完全退出再删。
 * 宿主进程可能跟着外壳一起被回收，所以脚本先用 WMI 再 fork 一次，脱离父进程树。
 * 另外"还有别的 DSH 实例在跑就什么都不做"，免得把新实例刚拿到的登录 cookie 删掉。
 */
const WORKER_SCRIPT = `param(
  [switch]$Worker,
  [int]$WaitPid = 0,
  [string]$Db = '',
  [string]$Marker = '',
  [string]$Log = ''
)

function Say([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message
  try { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 } catch {}
}

if (-not $Worker) {
  $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Worker -WaitPid {1} -Db "{2}" -Marker "{3}" -Log "{4}"' -f $PSCommandPath, $WaitPid, $Db, $Marker, $Log
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    Say ("worker spawned rc={0} pid={1}" -f $r.ReturnValue, $r.ProcessId)
  } catch {
    Say ("worker spawn failed: " + $_.Exception.Message)
  }
  exit
}

Say ("worker start pid=$PID wait=$WaitPid")
for ($i = 0; $i -lt 30000; $i++) {
  if (-not (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
Say 'target process exited'

for ($i = 0; $i -lt 40; $i++) {
  if (-not (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Say 'skipped: another DSH instance is running'
  exit
}

if (-not (Test-Path -LiteralPath $Marker)) {
  Say 'skipped: marker removed (cancelled)'
  exit
}

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  foreach ($f in @($Db, "$Db-journal")) {
    if (Test-Path -LiteralPath $f) {
      try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop; Say "deleted $f" } catch { Say ("busy " + $f) }
    }
  }
  if (-not (Test-Path -LiteralPath $Db)) { $ok = $true; break }
  Start-Sleep -Milliseconds 500
}

if ($ok) {
  Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue
  Say 'cleanup done'
} else {
  Say 'cleanup failed: jar still locked'
}
`

/** 记一笔"下次进入时清理"，并挂一个退出兜底。 */
function scheduleClean() {
  const db = cookieDatabasePath()
  if (!existsSync(db)) return { ok: true, scheduled: false, note: 'cookie 库还没生成，不用清理' }
  if (!writeMarker({ at: new Date().toISOString(), pid: process.pid, db })) {
    return { ok: false, reason: '写不了待清理标记' }
  }
  logLine(`armed on-next-start (pid ${process.pid})`)

  const file = join(tmpdir(), 'dsh-cookie-meter-clean.ps1')
  try {
    writeFileSync(file, WORKER_SCRIPT, 'utf8')
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        file,
        '-WaitPid',
        String(process.ppid ?? process.pid),
        '-Db',
        db,
        '-Marker',
        MARKER,
        '-Log',
        LOG,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
  } catch (err) {
    logLine(`worker spawn failed: ${err === undefined || err === null ? 'unknown' : err.message ?? err}`)
  }
  return { ok: true, scheduled: true }
}

/**
 * 启动时把上个会话欠下的清理补上：此刻 shell 还没开始用这条库，删除通常会成功。
 * 失败就留着标记，下次进入再试。
 */
function settlePendingClean() {
  if (readMarker() === undefined) {
    logLine('boot: no pending clean')
    return
  }
  const outcome = deleteJar()
  const failed = outcome.results.some((item) => item.missing !== true && item.deleted !== true)
  if (outcome.deleted && !failed) {
    clearMarker()
    logLine(`boot: pending clean applied (${JSON.stringify(outcome.results)})`)
    probeCache = undefined
    return
  }
  logLine(`boot: pending clean deferred (${JSON.stringify(outcome.results)})`)
}

export function apply(ctx) {
  const refusal = makeFence(ctx)
  settlePendingClean()

  function sendJson(response, status, body) {
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store',
    })
    response.end(text)
  }

  async function snapshot(force) {
    const marker = readMarker()
    const pending =
      marker === undefined
        ? { scheduled: false }
        : { scheduled: true, scheduledAt: marker.at, scheduledPid: marker.pid }
    const probe = await inspect(force)
    if (!probe.ok) {
      return {
        ok: false,
        reason: probe.reason,
        fileSize: probe.fileSize,
        updatedAt: new Date().toISOString(),
        ...pending,
      }
    }
    return describe(probe.count, {
      ok: true,
      source: probe.source,
      probeMs: probe.probeMs,
      fileSize: probe.fileSize,
      cached: probe.cached === true,
      ...pending,
    })
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              const rejected = refusal(request)
              if (rejected !== undefined) {
                sendJson(response, rejected, { error: 'refused', status: rejected })
                return
              }
              const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
              const action = url.searchParams.get('action') ?? 'read'

              if (request.method === 'GET') {
                sendJson(response, 200, await snapshot(url.searchParams.get('force') === '1'))
                return
              }
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' })
                response.end()
                return
              }

              if (action === 'clean') {
                const outcome = deleteJar()
                if (outcome.deleted) {
                  probeCache = undefined
                  clearMarker()
                  logLine('clean: jar deleted now')
                }
                sendJson(response, 200, {
                  ok: outcome.deleted || outcome.locked,
                  cleared: outcome.deleted,
                  locked: outcome.locked,
                  results: outcome.results,
                  updatedAt: new Date().toISOString(),
                })
                return
              }

              if (action === 'schedule-clean') {
                const outcome = scheduleClean()
                sendJson(response, outcome.ok ? 200 : 500, outcome)
                return
              }

              if (action === 'cancel-clean') {
                const cancelled = clearMarker()
                logLine('cancelled on-next-start')
                sendJson(response, 200, { ok: cancelled, scheduled: false })
                return
              }

              sendJson(response, 400, { error: `unknown action: ${action}` })
            } catch (err) {
              try {
                sendJson(response, 500, { error: String(err === undefined || err === null ? err : err.message ?? err) })
              } catch (inner) {
                /* 头已经发出去了 */
              }
            }
          },
        }),
      'dsh-cookie-meter: api route',
    )
  })

  ctx.effect(() => {
    void mkdir(STATE_DIR, { recursive: true }).catch(() => undefined)
  }, 'dsh-cookie-meter: ensure state dir')
}
