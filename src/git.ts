import { exec } from 'child_process'
import { promisify } from 'util'

const execp = promisify(exec)

export interface GitInfo {
  isRepo:        boolean
  branch:        string | null
  lastCommitTs:  number | null
  lastCommitMsg: string | null
  dirtyCount:    number
  ahead:         number
  behind:        number
}

async function safeExec(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execp(cmd, { cwd, windowsHide: true, timeout: 3000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function gitInfo(projectPath: string): Promise<GitInfo> {
  const empty: GitInfo = {
    isRepo: false, branch: null, lastCommitTs: null, lastCommitMsg: null,
    dirtyCount: 0, ahead: 0, behind: 0,
  }

  const inside = await safeExec('git rev-parse --is-inside-work-tree', projectPath)
  if (inside !== 'true') return empty

  const [branch, lastTs, lastMsg, dirty, aheadBehind] = await Promise.all([
    safeExec('git rev-parse --abbrev-ref HEAD', projectPath),
    safeExec('git log -1 --format=%ct', projectPath),
    safeExec('git log -1 --format=%s', projectPath),
    safeExec('git status --porcelain', projectPath),
    safeExec('git rev-list --left-right --count HEAD...@{upstream}', projectPath),
  ])

  const dirtyCount = dirty ? dirty.split('\n').filter(Boolean).length : 0
  let ahead = 0, behind = 0
  if (aheadBehind) {
    const [a, b] = aheadBehind.split(/\s+/).map(n => parseInt(n, 10) || 0)
    ahead  = a
    behind = b
  }

  return {
    isRepo:        true,
    branch:        branch || null,
    lastCommitTs:  lastTs ? parseInt(lastTs, 10) * 1000 : null,
    lastCommitMsg: lastMsg || null,
    dirtyCount,
    ahead,
    behind,
  }
}
