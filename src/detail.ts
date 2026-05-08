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
  branchAge:        number | null   // days since branch created
  commitsByDay:     number[]        // last 14 days
  packageVersion:   string | null
  envMissing:       string[]        // vars in .env.example not in .env
  testCommand:      string | null
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

  /* branch age */
  const branchCreated = await safeExec('git log --reverse --format=%ct --max-count=1 HEAD', projectPath)
  if (branchCreated) {
    const ts = parseInt(branchCreated, 10) * 1000
    detail.branchAge = Math.floor((now - ts) / 86_400_000)
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
