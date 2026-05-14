import https from 'https'

export interface GitHubRepoData {
  openIssues: number
  openPRs:    number
  ciStatus:   'success' | 'failure' | 'pending' | 'unknown'
  stars:      number
  cachedAt:   number
}

export interface GitHubNotification {
  id:         string
  reason:     string
  unread:     boolean
  subject:    { title: string; type: string; url: string | null }
  repository: { full_name: string; html_url: string }
  updated_at: string
}

export interface GitHubUserRepo {
  id:               number
  full_name:        string
  description:      string | null
  html_url:         string
  language:         string | null
  stargazers_count: number
  pushed_at:        string | null
  private:          boolean
  fork:             boolean
}

function apiCall(method: string, apiPath: string, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: 'api.github.com',
      path:     apiPath,
      headers: {
        Authorization:          `token ${token}`,
        'User-Agent':           'Asura-Dashboard/0.2',
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Length':       '0',
      },
    }, (res) => {
      let body = ''
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body || 'null')) } catch { resolve(null) }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

export function parseGitHubRepo(remoteUrl: string): string | null {
  const m = remoteUrl.match(/github\.com[/:]([^/\s]+\/[^/\s.]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

const repoCache = new Map<string, GitHubRepoData>()
const CACHE_TTL = 5 * 60_000

export async function fetchRepoData(token: string, repoPath: string): Promise<GitHubRepoData> {
  const hit = repoCache.get(repoPath)
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL) return hit

  const [repoRes, pullsRes, runsRes] = await Promise.allSettled([
    apiCall('GET', `/repos/${repoPath}`, token),
    apiCall('GET', `/repos/${repoPath}/pulls?state=open&per_page=100`, token),
    apiCall('GET', `/repos/${repoPath}/actions/runs?per_page=1`, token),
  ])

  const repo   = repoRes.status  === 'fulfilled' ? (repoRes.value   ?? {}) : {}
  const pulls  = pullsRes.status === 'fulfilled' && Array.isArray(pullsRes.value) ? pullsRes.value : []
  const openPRs    = pulls.length
  const openIssues = Math.max(0, (repo.open_issues_count ?? 0) - openPRs)

  let ciStatus: GitHubRepoData['ciStatus'] = 'unknown'
  if (runsRes.status === 'fulfilled' && runsRes.value?.workflow_runs?.[0]) {
    const run = runsRes.value.workflow_runs[0]
    if (run.status === 'in_progress' || run.status === 'queued') ciStatus = 'pending'
    else if (run.conclusion === 'success')                        ciStatus = 'success'
    else if (['failure', 'timed_out', 'cancelled'].includes(run.conclusion)) ciStatus = 'failure'
  }

  const result: GitHubRepoData = {
    openIssues, openPRs, ciStatus,
    stars: repo.stargazers_count ?? 0,
    cachedAt: Date.now(),
  }
  repoCache.set(repoPath, result)
  return result
}

export async function fetchNotifications(token: string): Promise<GitHubNotification[]> {
  try {
    const r = await apiCall('GET', '/notifications?per_page=50', token)
    return Array.isArray(r) ? r : []
  } catch { return [] }
}

export async function fetchUserRepos(token: string): Promise<GitHubUserRepo[]> {
  try {
    const r = await apiCall('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator', token)
    return Array.isArray(r) ? r : []
  } catch { return [] }
}

export async function markNotificationRead(token: string, id: string): Promise<void> {
  try { await apiCall('PATCH', `/notifications/threads/${id}`, token) } catch { /* silent */ }
}
