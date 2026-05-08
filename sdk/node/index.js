'use strict'

const http = require('http')

const HOST = process.env.STACKWATCH_HOST || '127.0.0.1'
const PORT = parseInt(process.env.STACKWATCH_PORT || '27315', 10)
const ENABLED = process.env.STACKWATCH_DISABLE !== '1'

function request(method, pathname, body) {
  if (!ENABLED) return Promise.resolve(null)
  const data = body ? JSON.stringify(body) : ''
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method, headers, timeout: 1500 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end',  () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
          catch { resolve(null) }
        })
      }
    )
    req.on('error',   () => resolve(null))   // fail silent
    req.on('timeout', () => { req.destroy(); resolve(null) })
    if (data) req.write(data)
    req.end()
  })
}

const post = (path, body) => request('POST', path, body)
const get  = (path)       => request('GET',  path, null)

class Bot {
  constructor(id, opts) {
    this.id          = id
    this.name        = opts.name
    this.target      = opts.target || null
    this._tickQueue  = 0
    this._flushTimer = null
    this._paused     = false
    this._pollTimer  = null
    if (id && !id.startsWith('offline-')) this._startPolling()
  }

  _startPolling() {
    /* poll every 4s to receive pause/resume signal */
    this._pollTimer = setInterval(async () => {
      const r = await get('/bot/' + this.id + '/control')
      if (r && typeof r.paused === 'boolean') this._paused = r.paused
    }, 4000)
    if (this._pollTimer.unref) this._pollTimer.unref()
  }

  isPaused() { return this._paused }

  /** Block until unpaused. Returns Promise. */
  async waitIfPaused() {
    while (this._paused) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  tick(payload = {}) {
    this._tickQueue++
    const item = payload && typeof payload === 'object' ? payload : {}
    if (item.item || item.data !== undefined || (item.flush === true)) {
      this._flush(item)
      return
    }
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this._flush({}), 250)
    }
  }

  _flush(payload) {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null }
    const count = this._tickQueue
    this._tickQueue = 0
    if (count === 0 && !payload.item && payload.data === undefined) return
    post('/bot/' + this.id + '/tick', { count: count || 1, ...payload })
  }

  error(msg, meta) {
    this._flush({})
    post('/bot/' + this.id + '/error', { msg: String(msg), meta })
  }

  done() {
    this._flush({})
    post('/bot/' + this.id + '/done', {})
    if (this._pollTimer) clearInterval(this._pollTimer)
  }

  crashed(msg) {
    this._flush({})
    post('/bot/' + this.id + '/crashed', { msg: msg ? String(msg) : 'crashed' })
    if (this._pollTimer) clearInterval(this._pollTimer)
  }
}

async function bot(name, opts = {}) {
  const reg = await post('/bot/register', {
    name,
    target:  opts.target  || null,
    project: opts.project || null,
    meta:    opts.meta    || {},
    pid:     process.pid,
  })
  if (!reg || !reg.id) {
    return new Bot('offline-' + name, { name, target: opts.target })
  }
  const b = new Bot(reg.id, { name, target: opts.target })

  process.once('exit', (code) => {
    if (code !== 0) b.crashed('exit code ' + code)
  })
  process.once('uncaughtException', (e) => b.crashed(e && e.message || String(e)))

  return b
}

module.exports = { bot }
module.exports.default = { bot }
