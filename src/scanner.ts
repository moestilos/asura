import fsp from 'fs/promises'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { exec } from 'child_process'
import { promisify } from 'util'
import { gitInfo, GitInfo } from './git'
import { getConfig, markProjectFirstSeen } from './config'

const execp = promisify(exec)

export interface Project {
  name:         string
  path:         string
  stack:        string[]
  status:       'active' | 'recent' | 'idle' | 'archived'
  mtime:        number
  hasBots:      boolean
  hasHandoff:   boolean
  handoffPath:  string | null
  devPort:      number | null
  git:          GitInfo
  outputs:      string[]
  favorite:     boolean
  hidden:       boolean
  isNew:        boolean
  scriptsCount: number
  firstSeen:    number
  commitsByDay: number[]   // last 14 days
  prodUrl:      string | null   // production URL if detected
  githubRepo:   string | null   // "owner/repo" for GitHub remotes
}

const STACK_HINTS: Record<string, string> = {
  'next':              'Next.js',
  'react':             'React',
  'vue':               'Vue',
  'svelte':            'Svelte',
  'electron':          'Electron',
  'vite':              'Vite',
  'express':           'Express',
  'fastify':           'Fastify',
  'playwright':        'Playwright',
  'puppeteer':         'Puppeteer',
  '@clerk/nextjs':     'Clerk',
  '@neondatabase/serverless': 'Neon',
  'stripe':            'Stripe',
  'prisma':            'Prisma',
  'tailwindcss':       'Tailwind',
}

const PY_HINTS: Record<string, string> = {
  'fastapi':    'FastAPI',
  'flask':      'Flask',
  'django':     'Django',
  'playwright': 'Playwright',
  'scrapy':     'Scrapy',
  'pandas':     'Pandas',
  'streamlit':  'Streamlit',
}

const COMMON_DEV_PORTS = [3000, 3001, 3002, 5173, 5174, 8000, 8080, 4000, 4200, 5000, 27314, 27315]

async function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok) } }
    sock.setTimeout(200)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error',   () => finish(false))
    sock.connect(port, '127.0.0.1')
  })
}

async function scanLivePorts(): Promise<Set<number>> {
  const live = new Set<number>()
  await Promise.all(COMMON_DEV_PORTS.map(async (p) => {
    if (await probePort(p)) live.add(p)
  }))
  return live
}

async function detectDevPort(projectPath: string): Promise<number | null> {
  // try package.json scripts for explicit port flags
  const pkg = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
      const scripts = (json.scripts || {}) as Record<string, string>
      for (const cmd of Object.values(scripts)) {
        const m = cmd.match(/-p\s+(\d{2,5})|--port\s+(\d{2,5})|PORT=(\d{2,5})/)
        if (m) return parseInt(m[1] || m[2] || m[3], 10)
      }
      if (json.dependencies?.['next'] || json.devDependencies?.['next']) return 3000
      if (json.dependencies?.['vite'] || json.devDependencies?.['vite']) return 5173
    } catch { /* skip */ }
  }
  if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    return 8000
  }
  return null
}

async function readDeps(projectPath: string): Promise<{ stack: string[], hasBot: boolean }> {
  const stack: string[] = []
  let hasBot = false
  const push = (label: string) => { if (!stack.includes(label)) stack.push(label) }

  // Node
  const pkg = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
      const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) }
      for (const [dep, label] of Object.entries(STACK_HINTS)) {
        if (deps[dep]) push(label)
      }
      if (deps['playwright'] || deps['playwright-core'] || deps['puppeteer']) hasBot = true
    } catch { /* skip */ }
  }

  // Python — pyproject.toml
  const py = path.join(projectPath, 'pyproject.toml')
  if (fs.existsSync(py)) {
    try {
      const content = await fsp.readFile(py, 'utf-8')
      for (const [dep, label] of Object.entries(PY_HINTS)) {
        if (new RegExp(`\\b${dep}\\b`, 'i').test(content)) {
          push(label)
          if (dep === 'playwright' || dep === 'scrapy') hasBot = true
        }
      }
    } catch { /* skip */ }
  }

  // Python — requirements.txt
  const req = path.join(projectPath, 'requirements.txt')
  if (fs.existsSync(req)) {
    try {
      const content = await fsp.readFile(req, 'utf-8')
      for (const [dep, label] of Object.entries(PY_HINTS)) {
        if (new RegExp(`^${dep}\\b`, 'im').test(content)) {
          push(label)
          if (dep === 'playwright' || dep === 'scrapy') hasBot = true
        }
      }
      if (/paddleocr|tesseract|easyocr/i.test(content)) push('OCR')
    } catch { /* skip */ }
  }

  // Docker / n8n / generic markers
  if (fs.existsSync(path.join(projectPath, 'docker-compose.yml')) ||
      fs.existsSync(path.join(projectPath, 'docker-compose.yaml'))) {
    push('Docker')
  }
  if (fs.existsSync(path.join(projectPath, 'workflows'))) push('n8n')

  // bots/scrapers folder convention
  if (fs.existsSync(path.join(projectPath, 'bots')))     hasBot = true
  if (fs.existsSync(path.join(projectPath, 'scrapers'))) hasBot = true
  if (fs.existsSync(path.join(projectPath, 'scripts'))) {
    // scan scripts/ for playwright/puppeteer presence
    try {
      const items = await fsp.readdir(path.join(projectPath, 'scripts'))
      if (items.some(f => /scrape|crawl|bot/i.test(f))) hasBot = true
    } catch { /* skip */ }
  }

  return { stack, hasBot }
}

function hasProjectMarker(p: string): boolean {
  const markers = [
    'package.json', 'pyproject.toml', 'requirements.txt',
    'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
    'Cargo.toml', 'go.mod',
  ]
  return markers.some(m => fs.existsSync(path.join(p, m)))
}

async function newestMtime(dir: string, maxDepth = 2): Promise<number> {
  let newest = 0
  async function walk(d: string, depth: number) {
    if (depth > maxDepth) return
    try {
      const entries = await fsp.readdir(d, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.git') continue
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next' ||
            e.name === '__pycache__' || e.name === '.venv' || e.name === 'venv') continue
        const full = path.join(d, e.name)
        try {
          const st = await fsp.stat(full)
          if (st.mtimeMs > newest) newest = st.mtimeMs
          if (e.isDirectory()) await walk(full, depth + 1)
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  await walk(dir, 0)
  return newest
}

function statusFromMtime(mtime: number): Project['status'] {
  const ageMs = Date.now() - mtime
  const day = 86_400_000
  if (ageMs <  1 * day)  return 'active'
  if (ageMs <  7 * day)  return 'recent'
  if (ageMs < 30 * day)  return 'idle'
  return 'archived'
}

async function detectOutputs(projectPath: string): Promise<string[]> {
  const candidates = ['output', 'outputs', 'data', 'scraped', 'results', 'exports']
  const found: string[] = []
  for (const c of candidates) {
    const p = path.join(projectPath, c)
    if (fs.existsSync(p)) found.push(p)
  }
  // also any .db files in root
  try {
    const entries = await fsp.readdir(projectPath, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith('.db') || e.name.endsWith('.sqlite') || e.name.endsWith('.sqlite3'))) {
        found.push(path.join(projectPath, e.name))
      }
    }
  } catch { /* skip */ }
  return found
}

async function findProjectDirs(root: string, maxDepth = 2): Promise<Array<{ name: string, path: string }>> {
  const found: Array<{ name: string, path: string }> = []
  const SKIP = new Set(['node_modules', 'dist', '.next', '.git', '__pycache__', '.venv', 'venv', 'build', 'out'])

  async function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }

    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || e.name.startsWith('_') || SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      const label = prefix ? prefix + '/' + e.name : e.name

      if (hasProjectMarker(full)) {
        // dedupe consecutive duplicate segments + cap at 2 levels
        const segs = label.split('/').filter((s, i, a) => i === 0 || s !== a[i - 1])
        const cleanLabel = segs.length > 2 ? segs.slice(-2).join('/') : segs.join('/')
        found.push({ name: cleanLabel, path: full })
      } else if (depth < maxDepth) {
        await walk(full, depth + 1, label)
      }
    }
  }

  await walk(root, 0, '')
  return found
}

async function commitsByDay(projectPath: string): Promise<number[]> {
  const buckets = new Array(14).fill(0)
  try {
    const since = Math.floor((Date.now() - 14 * 86_400_000) / 1000)
    const { stdout } = await execp(
      `git log --since=${since} --pretty=format:%ct`,
      { cwd: projectPath, windowsHide: true, timeout: 2500 }
    )
    if (!stdout) return buckets
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const dayMs = 86_400_000
    for (const tsRaw of stdout.split('\n').filter(Boolean)) {
      const ts = parseInt(tsRaw, 10) * 1000
      const daysAgo = Math.floor((todayStart.getTime() - ts) / dayMs)
      const idx = 13 - daysAgo
      if (idx >= 0 && idx < 14) buckets[idx]++
    }
  } catch { /* skip */ }
  return buckets
}

async function countScripts(projectPath: string): Promise<number> {
  const pkg = path.join(projectPath, 'package.json')
  if (!fs.existsSync(pkg)) return 0
  try {
    const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
    return Object.keys(json.scripts || {}).length
  } catch { return 0 }
}

function parseGithubRepo(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/github\.com[/:]([^/\s]+\/[^/\s.]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

const PROD_HOST_RE = /https?:\/\/[\w.-]*?(?:vercel\.app|netlify\.app|netlify\.com|fly\.dev|railway\.app|herokuapp\.com|pages\.dev|onrender\.com|deno\.dev|workers\.dev|github\.io|streamlit\.app|hf\.space|render\.com)[\/\w.\-?=&%#]*/i

function normalizeUrl(u: string): string | null {
  if (!u) return null
  let s = u.trim().replace(/[\),.;]+$/, '')
  if (!s.startsWith('http')) s = 'https://' + s.replace(/^\/+/, '')
  try { new URL(s); return s } catch { return null }
}

async function detectProdUrl(projectPath: string): Promise<string | null> {
  /* 1. explicit override: .asura/url or .asura/prodUrl */
  for (const f of ['.asura/url', '.asura/prodUrl', '.asura/url.txt']) {
    const p = path.join(projectPath, f)
    if (fs.existsSync(p)) {
      try {
        const v = (await fsp.readFile(p, 'utf-8')).trim().split('\n')[0].trim()
        const n = normalizeUrl(v)
        if (n) return n
      } catch { /* skip */ }
    }
  }

  /* 2. package.json — homepage / asura.url / repository url (skip git+) */
  const pkg = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
      if (json.asura?.url) {
        const n = normalizeUrl(json.asura.url)
        if (n) return n
      }
      if (typeof json.homepage === 'string' && !json.homepage.startsWith('git')) {
        const n = normalizeUrl(json.homepage)
        if (n && !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(n)) return n
      }
    } catch { /* skip */ }
  }

  /* 3. vercel.json alias */
  const vercel = path.join(projectPath, 'vercel.json')
  if (fs.existsSync(vercel)) {
    try {
      const json = JSON.parse(await fsp.readFile(vercel, 'utf-8'))
      if (json.alias) {
        const a = Array.isArray(json.alias) ? json.alias[0] : json.alias
        if (typeof a === 'string') {
          const n = normalizeUrl(a)
          if (n) return n
        }
      }
    } catch { /* skip */ }
  }

  /* 4. README first match against known hosting providers */
  for (const f of ['README.md', 'readme.md', 'README.MD', 'HANDOFF.md']) {
    const p = path.join(projectPath, f)
    if (!fs.existsSync(p)) continue
    try {
      const text = await fsp.readFile(p, 'utf-8')
      const m = text.match(PROD_HOST_RE)
      if (m) {
        const n = normalizeUrl(m[0])
        if (n) return n
      }
    } catch { /* skip */ }
  }

  return null
}

export async function scanWorkspace(workspaceRoot: string): Promise<Project[]> {
  const cfg     = getConfig()
  const roots   = [workspaceRoot, ...cfg.workspaceRoots.filter(r => fs.existsSync(r))]
  const allDirs: Array<{ name: string, path: string }> = []

  for (const root of roots) {
    const appsDir = fs.existsSync(path.join(root, 'apps')) ? path.join(root, 'apps') : root
    if (!fs.existsSync(appsDir)) continue
    const dirs = await findProjectDirs(appsDir, 2)
    allDirs.push(...dirs)
  }
  if (allDirs.length === 0) return []

  const livePorts = await scanLivePorts()

  const projects = await Promise.all(allDirs.map(async ({ name, path: projectPath }): Promise<Project | null> => {
    const [{ stack, hasBot }, mtime, git, outputs, devPort, commits, scriptsCount, prodUrl] = await Promise.all([
      readDeps(projectPath),
      newestMtime(projectPath),
      gitInfo(projectPath),
      detectOutputs(projectPath),
      detectDevPort(projectPath),
      commitsByDay(projectPath),
      countScripts(projectPath),
      detectProdUrl(projectPath),
    ])

    const handoffPath = ['HANDOFF.md', 'HANDOFF.MD', 'handoff.md']
      .map(f => path.join(projectPath, f))
      .find(p => fs.existsSync(p)) || null

    const portLive = devPort !== null && livePorts.has(devPort) ? devPort : null

    /* first seen tracking */
    markProjectFirstSeen(name)
    const cfg2 = getConfig()
    const firstSeen = cfg2.projectFirstSeen[name] || Date.now()
    /* "new" only if firstSeen was recorded after install + 60s grace (so first-ever scan doesn't mark all) */
    const isNew = !cfg2.dismissedNew.includes(name) &&
                  firstSeen > (cfg2.installedAt + 60_000) &&
                  (Date.now() - firstSeen) < 24 * 60 * 60 * 1000

    return {
      name,
      path:         projectPath,
      stack,
      status:       statusFromMtime(mtime),
      mtime,
      hasBots:      hasBot,
      hasHandoff:   !!handoffPath,
      handoffPath,
      devPort:      portLive,
      git,
      outputs,
      favorite:     cfg.favorites.includes(name),
      hidden:       cfg.hidden.includes(name),
      isNew,
      scriptsCount,
      firstSeen,
      commitsByDay: commits,
      prodUrl,
      githubRepo:   parseGithubRepo(git.remoteUrl),
    }
  }))

  return projects
    .filter((p): p is Project => p !== null)
    .sort((a, b) => {
      /* favorites first, then by mtime */
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
      return b.mtime - a.mtime
    })
}
