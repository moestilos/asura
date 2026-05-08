import http from 'http'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { BrowserWindow } from 'electron'
import { notify } from './notifications'
import { statPid, ProcessStat } from './process-monitor'

const STORE_DIR  = path.join(os.homedir(), '.asura')
const STORE_FILE = path.join(STORE_DIR, 'state.json')
const PORT       = 27315

export interface BotErrorEntry  { ts: number; msg: string; meta?: any }
export interface BotSampleEntry { ts: number; item?: string; data?: any }
export interface RateBucket     { ts: number; count: number }

export interface Bot {
  id:             string
  name:           string
  project:        string | null
  target:         number | null
  startedAt:      number
  lastTickAt:     number
  doneAt:         number | null
  status:         'running' | 'idle' | 'stuck' | 'done' | 'crashed' | 'paused'
  ticks:          number
  errors:         number
  meta:           Record<string, any>
  rateBuckets:    RateBucket[]            // 1-min buckets, last 60
  errorHistory:   BotErrorEntry[]          // last 20
  sampleHistory:  BotSampleEntry[]         // last 5
  currentItem:    string | null
  pid:            number | null
  paused:         boolean                  // remote-set flag — SDK polls
  anomalyFlagged: boolean                  // rate dropped 50%+ recently
  procStat:      ProcessStat | null
}

const bots = new Map<string, Bot>()
let mainWindow: BrowserWindow | null = null
let saveTimer: NodeJS.Timeout | null = null

function bucketTs(ts: number): number {
  return Math.floor(ts / 60000) * 60000
}

function pushRateBucket(bot: Bot, ts: number) {
  const bucket = bucketTs(ts)
  const last = bot.rateBuckets[bot.rateBuckets.length - 1]
  if (last && last.ts === bucket) {
    last.count++
  } else {
    bot.rateBuckets.push({ ts: bucket, count: 1 })
    if (bot.rateBuckets.length > 60) bot.rateBuckets.shift()
  }
}

function recomputeStatus(bot: Bot, now: number) {
  if (bot.status === 'done' || bot.status === 'crashed' || bot.status === 'paused') return
  const idleMs = now - bot.lastTickAt
  const prev = bot.status
  if (idleMs > 10 * 60_000)        bot.status = 'stuck'
  else if (idleMs >  2 * 60_000)   bot.status = 'idle'
  else                             bot.status = 'running'

  /* fire alerts on transitions */
  if (prev === 'running' && bot.status === 'stuck') {
    notify({
      kind: 'bot-stuck',
      title: 'Bot atascado · ' + bot.name,
      body: 'Sin actividad >10 min. Último item: ' + (bot.currentItem || 'desconocido'),
      target: bot.id,
    })
  }
}

function detectAnomaly(bot: Bot, now: number) {
  if (bot.status !== 'running') { bot.anomalyFlagged = false; return }
  const last5 = bot.rateBuckets.filter(b => now - b.ts <= 5 * 60_000)
  const prev5 = bot.rateBuckets.filter(b => now - b.ts > 5 * 60_000 && now - b.ts <= 15 * 60_000)
  if (last5.length < 2 || prev5.length < 3) return
  const recentAvg = last5.reduce((a, b) => a + b.count, 0) / last5.length
  const baseAvg   = prev5.reduce((a, b) => a + b.count, 0) / prev5.length
  if (baseAvg > 5 && recentAvg < baseAvg * 0.5) {
    if (!bot.anomalyFlagged) {
      bot.anomalyFlagged = true
      notify({
        kind: 'bot-anomaly',
        title: 'Rate caído · ' + bot.name,
        body: `Rate ${recentAvg.toFixed(1)}/min vs base ${baseAvg.toFixed(1)}/min — posible captcha o IP ban`,
        target: bot.id,
      })
    }
  } else {
    bot.anomalyFlagged = false
  }
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bots-update', getBotList())
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    await save()
  }, 1500)
}

async function save() {
  try {
    if (!fs.existsSync(STORE_DIR)) await fsp.mkdir(STORE_DIR, { recursive: true })
    const data = Array.from(bots.values())
    await fsp.writeFile(STORE_FILE, JSON.stringify(data, null, 2))
  } catch (e) {
    console.error('bots: save error', e)
  }
}

async function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return
    const data: any[] = JSON.parse(await fsp.readFile(STORE_FILE, 'utf-8'))
    for (const raw of data) {
      const b: Bot = {
        id: raw.id, name: raw.name, project: raw.project ?? null,
        target: raw.target ?? null, startedAt: raw.startedAt, lastTickAt: raw.lastTickAt,
        doneAt: raw.doneAt ?? null, status: raw.status, ticks: raw.ticks || 0,
        errors: raw.errors || 0, meta: raw.meta || {},
        rateBuckets: raw.rateBuckets || [], errorHistory: raw.errorHistory || [],
        sampleHistory: raw.sampleHistory || [], currentItem: raw.currentItem ?? null,
        pid: raw.pid ?? null,
        paused: !!raw.paused, anomalyFlagged: !!raw.anomalyFlagged,
        procStat: raw.procStat ?? null,
      }
      // Bots whose state is mid-run on load get marked crashed (process gone)
      if (b.status === 'running' || b.status === 'idle' || b.status === 'stuck' || b.status === 'paused') {
        b.status = 'crashed'
      }
      bots.set(b.id, b)
    }
  } catch (e) {
    console.error('bots: load error', e)
  }
}

export function getBotList(): Bot[] {
  const now = Date.now()
  const arr = Array.from(bots.values())
  for (const b of arr) {
    recomputeStatus(b, now)
    detectAnomaly(b, now)
  }
  // sort: running > paused > idle/stuck > done > crashed; within group, most recent first
  const order = (s: Bot['status']) => ({ running: 0, paused: 1, idle: 2, stuck: 3, done: 4, crashed: 5 }[s] ?? 9)
  return arr.sort((a, b) => order(a.status) - order(b.status) || b.lastTickAt - a.lastTickAt)
}

export function setBotPaused(id: string, paused: boolean): boolean {
  const bot = bots.get(id)
  if (!bot) return false
  bot.paused = paused
  if (paused) bot.status = 'paused'
  else if (bot.status === 'paused') bot.status = 'running'
  scheduleSave(); broadcast()
  return true
}

/* periodic process stat refresh — only for running bots with pid */
async function refreshProcStats() {
  const tasks: Promise<void>[] = []
  for (const bot of bots.values()) {
    if (!bot.pid) continue
    if (bot.status !== 'running' && bot.status !== 'idle' && bot.status !== 'paused') continue
    tasks.push((async () => {
      bot.procStat = await statPid(bot.pid!)
      if (bot.procStat && !bot.procStat.alive && bot.status !== 'done') {
        // process gone but bot didn't call done — mark crashed
        if (bot.status === 'running' || bot.status === 'idle' || bot.status === 'paused') {
          bot.status = 'crashed'
          notify({
            kind: 'bot-crashed',
            title: 'Bot crashed · ' + bot.name,
            body: 'Proceso terminado sin done(). Items: ' + bot.ticks,
            target: bot.id,
          })
        }
      }
    })())
  }
  await Promise.all(tasks)
}

/* ─────── HTTP daemon ─────── */

function jsonResponse(res: http.ServerResponse, status: number, payload: any) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8') || '{}'
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function makeId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '-' + Date.now().toString(36)
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url    = new URL(req.url || '/', 'http://127.0.0.1')
  const parts  = url.pathname.split('/').filter(Boolean)
  const now    = Date.now()

  try {
    /* GET /bots — full list */
    if (req.method === 'GET' && url.pathname === '/bots') {
      return jsonResponse(res, 200, getBotList())
    }

    /* GET /show — focus main window (for /godmode slash) */
    if (req.method === 'GET' && url.pathname === '/show') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        if (mainWindow.isMinimized()) mainWindow.restore()
      }
      return jsonResponse(res, 200, { ok: true })
    }

    /* GET /ping — health check */
    if (req.method === 'GET' && url.pathname === '/ping') {
      return jsonResponse(res, 200, { ok: true, version: '0.2' })
    }

    /* POST /bot/register {name, target?, project?, meta?, pid?} → {id} */
    if (req.method === 'POST' && url.pathname === '/bot/register') {
      const body = await readBody(req)
      if (!body.name) return jsonResponse(res, 400, { error: 'name required' })
      const id = makeId(body.name)
      const bot: Bot = {
        id,
        name:           String(body.name).slice(0, 80),
        project:        body.project ? String(body.project).slice(0, 80) : null,
        target:         typeof body.target === 'number' ? body.target : null,
        startedAt:      now,
        lastTickAt:     now,
        doneAt:         null,
        status:         'running',
        ticks:          0,
        errors:         0,
        meta:           body.meta && typeof body.meta === 'object' ? body.meta : {},
        rateBuckets:    [],
        errorHistory:   [],
        sampleHistory:  [],
        currentItem:    null,
        pid:            typeof body.pid === 'number' ? body.pid : null,
        paused:         false,
        anomalyFlagged: false,
        procStat:      null,
      }
      bots.set(id, bot)
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { id, paused: false })
    }

    /* GET /bot/:id/control — SDK polls for pause/resume signal */
    if (req.method === 'GET' && parts[0] === 'bot' && parts[2] === 'control') {
      const id = parts[1]
      const bot = bots.get(id)
      if (!bot) return jsonResponse(res, 404, { error: 'not found' })
      return jsonResponse(res, 200, { paused: bot.paused })
    }

    /* POST /bot/:id/tick {item?, data?, count?} */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'tick') {
      const id = parts[1]
      const bot = bots.get(id)
      if (!bot) return jsonResponse(res, 404, { error: 'not found' })
      const body  = await readBody(req)
      const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 1
      bot.ticks += count
      bot.lastTickAt = now
      bot.status = 'running'
      if (typeof body.item === 'string') bot.currentItem = body.item.slice(0, 200)
      pushRateBucket(bot, now)
      // sample preserve last 5 with data
      if (body.data !== undefined || body.item) {
        bot.sampleHistory.unshift({
          ts:   now,
          item: typeof body.item === 'string' ? body.item.slice(0, 200) : undefined,
          data: body.data,
        })
        if (bot.sampleHistory.length > 5) bot.sampleHistory.length = 5
      }
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { ok: true, ticks: bot.ticks })
    }

    /* POST /bot/:id/error {msg, meta?} */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'error') {
      const id = parts[1]
      const bot = bots.get(id)
      if (!bot) return jsonResponse(res, 404, { error: 'not found' })
      const body = await readBody(req)
      bot.errors++
      bot.lastTickAt = now
      bot.errorHistory.unshift({
        ts:   now,
        msg:  String(body.msg || 'unknown error').slice(0, 300),
        meta: body.meta,
      })
      if (bot.errorHistory.length > 20) bot.errorHistory.length = 20
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { ok: true })
    }

    /* POST /bot/:id/done */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'done') {
      const id = parts[1]
      const bot = bots.get(id)
      if (!bot) return jsonResponse(res, 404, { error: 'not found' })
      bot.status = 'done'
      bot.doneAt = now
      bot.lastTickAt = now
      const elapsedMin = Math.round((now - bot.startedAt) / 60_000)
      notify({
        kind: 'bot-done',
        title: 'Bot completado · ' + bot.name,
        body: `${bot.ticks} items en ${elapsedMin}min · ${bot.errors} errores`,
        target: bot.id,
      })
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { ok: true })
    }

    /* POST /bot/:id/pause */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'pause') {
      const id = parts[1]
      if (!setBotPaused(id, true)) return jsonResponse(res, 404, { error: 'not found' })
      return jsonResponse(res, 200, { ok: true })
    }

    /* POST /bot/:id/resume */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'resume') {
      const id = parts[1]
      if (!setBotPaused(id, false)) return jsonResponse(res, 404, { error: 'not found' })
      return jsonResponse(res, 200, { ok: true })
    }

    /* POST /bot/:id/crashed {msg?} */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'crashed') {
      const id = parts[1]
      const bot = bots.get(id)
      if (!bot) return jsonResponse(res, 404, { error: 'not found' })
      const body = await readBody(req)
      bot.status = 'crashed'
      bot.doneAt = now
      bot.errorHistory.unshift({ ts: now, msg: String(body.msg || 'crashed') })
      notify({
        kind: 'bot-crashed',
        title: 'Bot crashed · ' + bot.name,
        body: String(body.msg || 'unknown error'),
        target: bot.id,
      })
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { ok: true })
    }

    /* POST /bot/:id/clear — remove bot from panel */
    if (req.method === 'POST' && parts[0] === 'bot' && parts[2] === 'clear') {
      const id = parts[1]
      bots.delete(id)
      scheduleSave(); broadcast()
      return jsonResponse(res, 200, { ok: true })
    }

    return jsonResponse(res, 404, { error: 'not found' })
  } catch (e: any) {
    return jsonResponse(res, 500, { error: e.message || 'server error' })
  }
}

let server: http.Server | null = null

export async function startBotDaemon(win: BrowserWindow) {
  mainWindow = win
  await load()

  server = http.createServer(handleRequest)
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log('bot daemon: port ' + PORT + ' in use — another Asura?')
    } else {
      console.error('bot daemon error:', err)
    }
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Asura bot daemon listening on http://127.0.0.1:' + PORT)
  })

  // periodic broadcast for status recomputation (idle/stuck transitions)
  setInterval(() => {
    if (bots.size > 0) broadcast()
  }, 15_000)

  // periodic process stat refresh
  setInterval(async () => {
    if (bots.size > 0) {
      await refreshProcStats()
      broadcast()
    }
  }, 30_000)
}

export function stopBotDaemon() {
  if (server) server.close()
}

export function clearBot(id: string) {
  bots.delete(id)
  scheduleSave(); broadcast()
}
