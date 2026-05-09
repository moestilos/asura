import { exec } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { promisify } from 'util'

const execp = promisify(exec)

async function safeExec(cmd: string, cwd: string, timeout = 4000): Promise<string> {
  try {
    const { stdout } = await execp(cmd, { cwd, windowsHide: true, timeout })
    return stdout.trim()
  } catch {
    return ''
  }
}

export interface ProjectDetail {
  recentCommits:    Array<{ hash: string; ts: number; msg: string; author: string }>
  filesModifiedToday: string[]
  scripts:          Array<{ name: string; cmd: string }>
  todoCount:        number
  branchAge:        number | null   // days since first commit (repo age)
  commitsByDay:     number[]        // last 14 days
  packageVersion:   string | null
  envMissing:       string[]        // vars in .env.example not in .env
  testCommand:      string | null
  description:      string | null   // package.json description or README first paragraph
  license:          string | null
  remoteUrl:        string | null   // git remote origin (https form)
  branches:         number          // local branch count
  tags:             Array<{ name: string; ts: number }>   // last 5
  topAuthors:       Array<{ name: string; commits: number }>  // last 90d
  hotFiles:         Array<{ path: string; changes: number }>  // most modified last 30d
  linesAdded30d:    number
  linesRemoved30d:  number
  repoSizeMb:       number | null   // project size on disk excl deps/build
  lastBuildAt:      number | null   // mtime of dist/.next/build
  buildArtifact:    string | null
}

export async function getDetail(projectPath: string): Promise<ProjectDetail> {
  const detail: ProjectDetail = {
    recentCommits: [],
    filesModifiedToday: [],
    scripts: [],
    todoCount: 0,
    branchAge: null,
    commitsByDay: new Array(14).fill(0),
    packageVersion: null,
    envMissing: [],
    testCommand: null,
    description: null,
    license: null,
    remoteUrl: null,
    branches: 0,
    tags: [],
    topAuthors: [],
    hotFiles: [],
    linesAdded30d: 0,
    linesRemoved30d: 0,
    repoSizeMb: null,
    lastBuildAt: null,
    buildArtifact: null,
  }

  /* recent commits */
  const log = await safeExec('git log -8 --pretty=format:%H%x00%ct%x00%an%x00%s', projectPath)
  if (log) {
    detail.recentCommits = log.split('\n').filter(Boolean).map(line => {
      const [hash, ts, author, msg] = line.split('\0')
      return {
        hash:   (hash || '').slice(0, 7),
        ts:     parseInt(ts, 10) * 1000 || 0,
        author: author || '',
        msg:    msg || '',
      }
    })
  }

  /* commits last 14 days bucketed by day */
  const now = Date.now()
  const since = Math.floor((now - 14 * 86_400_000) / 1000)
  const log14 = await safeExec(`git log --since=${since} --pretty=format:%ct`, projectPath)
  if (log14) {
    const dayMs = 86_400_000
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    for (const tsRaw of log14.split('\n').filter(Boolean)) {
      const ts = parseInt(tsRaw, 10) * 1000
      const daysAgo = Math.floor((todayStart.getTime() - ts) / dayMs)
      const idx = 13 - daysAgo
      if (idx >= 0 && idx < 14) detail.commitsByDay[idx]++
    }
  }

  /* files modified today (uncommitted) */
  const status = await safeExec('git status --porcelain', projectPath)
  if (status) {
    detail.filesModifiedToday = status.split('\n')
      .map(l => l.slice(3).trim())
      .filter(Boolean)
      .slice(0, 30)
  }

  /* package.json scripts + version */
  const pkg = path.join(projectPath, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
      detail.packageVersion = json.version || null
      const scripts = json.scripts || {}
      for (const [name, cmd] of Object.entries(scripts)) {
        detail.scripts.push({ name, cmd: String(cmd) })
      }
      if (scripts.test) detail.testCommand = 'npm test'
    } catch { /* skip */ }
  }

  /* TODO/FIXME counter — quick grep limited */
  detail.todoCount = await countTodos(projectPath)

  /* env diff */
  detail.envMissing = await diffEnv(projectPath)

  /* description: package.json description, fall back to README first paragraph */
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(await fsp.readFile(pkg, 'utf-8'))
      if (typeof json.description === 'string' && json.description.trim()) {
        detail.description = json.description.trim().slice(0, 240)
      }
      if (typeof json.license === 'string') detail.license = json.license
    } catch { /* skip */ }
  }
  if (!detail.description) {
    for (const f of ['README.md', 'readme.md', 'README.MD']) {
      const p = path.join(projectPath, f)
      if (!fs.existsSync(p)) continue
      try {
        const text = await fsp.readFile(p, 'utf-8')
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
        const para = lines.find(l => !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('[!') && !l.startsWith('---') && l.length > 20)
        if (para) detail.description = para.replace(/[*_`]/g, '').slice(0, 240)
      } catch { /* skip */ }
      break
    }
  }

  /* license file fallback */
  if (!detail.license) {
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (fs.existsSync(path.join(projectPath, f))) {
        try {
          const txt = await fsp.readFile(path.join(projectPath, f), 'utf-8')
          const m = txt.match(/\b(MIT|Apache(?:[\s-]2\.0)?|GPL(?:v?[23])?|BSD(?:[\s-][23][\s-]Clause)?|MPL(?:[\s-]2\.0)?|ISC|Unlicense|AGPL)/i)
          if (m) detail.license = m[1].toUpperCase()
        } catch { /* skip */ }
        break
      }
    }
  }

  /* git remote origin → https form */
  const remote = await safeExec('git config --get remote.origin.url', projectPath)
  if (remote) {
    let u = remote
    if (u.startsWith('git@')) {
      u = u.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
    } else if (u.startsWith('http')) {
      u = u.replace(/\.git$/, '')
    }
    detail.remoteUrl = u
  }

  /* local branch count */
  const branches = await safeExec('git branch --list', projectPath)
  if (branches) detail.branches = branches.split('\n').filter(Boolean).length

  /* last 5 tags with timestamps */
  const tagsRaw = await safeExec('git for-each-ref --sort=-creatordate --count=5 --format=%(refname:short)%00%(creatordate:unix) refs/tags', projectPath)
  if (tagsRaw) {
    detail.tags = tagsRaw.split('\n').filter(Boolean).map(line => {
      const [name, ts] = line.split('\0')
      return { name: name || '', ts: parseInt(ts, 10) * 1000 || 0 }
    }).filter(t => t.name)
  }

  /* top authors last 90d */
  const since90 = Math.floor((now - 90 * 86_400_000) / 1000)
  const authorsRaw = await safeExec(`git log --since=${since90} --pretty=format:%an`, projectPath)
  if (authorsRaw) {
    const counts = new Map<string, number>()
    for (const a of authorsRaw.split('\n').filter(Boolean)) {
      counts.set(a, (counts.get(a) || 0) + 1)
    }
    detail.topAuthors = Array.from(counts.entries())
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 5)
  }

  /* hot files + lines added/removed last 30d via numstat */
  const since30 = Math.floor((now - 30 * 86_400_000) / 1000)
  const numstat = await safeExec(`git log --since=${since30} --pretty=format: --numstat`, projectPath, 6000)
  if (numstat) {
    const fileCounts = new Map<string, number>()
    let added = 0, removed = 0
    for (const line of numstat.split('\n')) {
      const parts = line.split('\t')
      if (parts.length !== 3) continue
      const a = parseInt(parts[0], 10)
      const r = parseInt(parts[1], 10)
      const f = parts[2]
      if (!f) continue
      if (!isNaN(a)) added   += a
      if (!isNaN(r)) removed += r
      // skip lockfiles / binary noise
      if (/package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)$/i.test(f)) continue
      fileCounts.set(f, (fileCounts.get(f) || 0) + 1)
    }
    detail.linesAdded30d   = added
    detail.linesRemoved30d = removed
    detail.hotFiles = Array.from(fileCounts.entries())
      .map(([path, changes]) => ({ path, changes }))
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 6)
  }

  /* repo size on disk (skip heavy dirs) */
  detail.repoSizeMb = await dirSizeMb(projectPath)

  /* last build artifact */
  for (const dir of ['dist', '.next', 'build', 'out']) {
    const p = path.join(projectPath, dir)
    if (fs.existsSync(p)) {
      try {
        const st = await fsp.stat(p)
        if (!detail.lastBuildAt || st.mtimeMs > detail.lastBuildAt) {
          detail.lastBuildAt  = st.mtimeMs
          detail.buildArtifact = dir
        }
      } catch { /* skip */ }
    }
  }

  /* repo age — timestamp of first (root) commit reachable from HEAD */
  const firstCommit = await safeExec('git log --max-parents=0 --format=%ct HEAD', projectPath)
  if (firstCommit) {
    const ts = parseInt(firstCommit.split('\n')[0], 10) * 1000
    if (ts > 0) detail.branchAge = Math.floor((now - ts) / 86_400_000)
  }

  return detail
}

async function countTodos(projectPath: string): Promise<number> {
  const SKIP = new Set(['node_modules', 'dist', '.next', '.git', '__pycache__', '.venv', 'venv', 'build'])
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.vue', '.svelte'])
  let count = 0
  let scanned = 0
  const MAX_FILES = 800
  const re = /\b(TODO|FIXME|HACK|XXX)\b/g

  async function walk(dir: string, depth: number) {
    if (depth > 6 || scanned >= MAX_FILES) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= MAX_FILES) return
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!exts.has(ext)) continue
        scanned++
        try {
          const content = await fsp.readFile(full, 'utf-8')
          const m = content.match(re)
          if (m) count += m.length
        } catch { /* skip */ }
      }
    }
  }

  await walk(projectPath, 0)
  return count
}

async function dirSizeMb(root: string): Promise<number | null> {
  const SKIP = new Set(['node_modules', 'dist', '.next', '.git', '__pycache__', '.venv', 'venv', 'build', 'out', '.turbo', '.cache'])
  const start = Date.now()
  let total = 0
  let scanned = 0
  const MAX_FILES   = 5000
  const MAX_TIME_MS = 1500

  async function walk(dir: string) {
    if (scanned >= MAX_FILES || Date.now() - start > MAX_TIME_MS) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (scanned >= MAX_FILES || Date.now() - start > MAX_TIME_MS) return
      if (SKIP.has(e.name) || e.name.startsWith('.git')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        scanned++
        try { total += (await fsp.stat(full)).size } catch { /* skip */ }
      }
    }
  }

  await walk(root)
  if (scanned === 0) return null
  return Math.round(total / 1024 / 1024 * 10) / 10
}

async function diffEnv(projectPath: string): Promise<string[]> {
  const examplePath = path.join(projectPath, '.env.example')
  const envPath     = path.join(projectPath, '.env')
  if (!fs.existsSync(examplePath) || !fs.existsSync(envPath)) return []
  try {
    const example = await fsp.readFile(examplePath, 'utf-8')
    const env     = await fsp.readFile(envPath, 'utf-8')
    const exampleVars = new Set(
      example.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => l.split('=')[0].trim())
    )
    const envVars = new Set(
      env.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => l.split('=')[0].trim())
    )
    const missing: string[] = []
    for (const v of exampleVars) if (!envVars.has(v)) missing.push(v)
    return missing
  } catch {
    return []
  }
}
