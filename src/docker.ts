import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

export type Runtime = 'docker' | 'podman' | 'wsl-docker'
export const RUNTIMES: Runtime[] = ['docker', 'podman', 'wsl-docker']

export interface Container {
  runtime:   Runtime
  id:        string
  name:      string
  image:     string
  state:     string
  status:    string
  ports:     string
  cpu:       string
  cpuPct:    number
  mem:       string
  memPct:    number
}

export interface RuntimeSnapshot {
  runtime:    Runtime
  available:  boolean
  daemonUp:   boolean
  containers: Container[]
}

export interface Snapshot {
  ts:       number
  runtimes: RuntimeSnapshot[]
}

function runtimeArgs(rt: Runtime): { cmd: string; pre: string[] } {
  if (rt === 'wsl-docker') return { cmd: 'wsl', pre: ['docker'] }
  return { cmd: rt, pre: [] }
}

async function runRuntime(rt: Runtime, args: string[], timeoutMs = 5000): Promise<string> {
  const { cmd, pre } = runtimeArgs(rt)
  try {
    const { stdout } = await execFileP(cmd, [...pre, ...args], {
      timeout:   timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch {
    return ''
  }
}

async function which(cmd: string): Promise<boolean> {
  try {
    const tool = process.platform === 'win32' ? 'where' : 'which'
    await execFileP(tool, [cmd], { windowsHide: true, timeout: 2000 })
    return true
  } catch {
    return false
  }
}

async function runtimeAvailable(rt: Runtime): Promise<boolean> {
  if (rt === 'wsl-docker') return which('wsl')
  return which(rt)
}

async function runtimeDaemonUp(rt: Runtime): Promise<boolean> {
  const out = await runRuntime(rt, ['ps', '-q'], 4000)
  return out !== '' || (await runRuntime(rt, ['info', '--format', '{{.ServerVersion}}'], 4000)).trim() !== ''
}

function parsePct(s: string | undefined): number {
  if (!s) return 0
  const m = s.match(/([\d.]+)/)
  return m ? parseFloat(m[1]) : 0
}

async function listContainers(rt: Runtime): Promise<Container[]> {
  const raw = await runRuntime(rt, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'])
  const items: Container[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let d: Record<string, string>
    try { d = JSON.parse(t) } catch { continue }
    items.push({
      runtime: rt,
      id:      ((d.ID ?? d.Id ?? '') as string).slice(0, 12),
      name:    (d.Names ?? d.Name ?? '') as string,
      image:   (d.Image ?? '') as string,
      state:   ((d.State ?? '') as string).toLowerCase(),
      status:  (d.Status ?? '') as string,
      ports:   (d.Ports ?? '') as string,
      cpu:     '-',
      cpuPct:  0,
      mem:     '-',
      memPct:  0,
    })
  }
  return items
}

async function statsMap(rt: Runtime): Promise<Map<string, { cpu: string; cpuPct: number; mem: string; memPct: number }>> {
  const raw = await runRuntime(rt, ['stats', '--no-stream', '--format', '{{json .}}'], 10000)
  const m = new Map<string, { cpu: string; cpuPct: number; mem: string; memPct: number }>()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let d: Record<string, string>
    try { d = JSON.parse(t) } catch { continue }
    const id  = ((d.ID ?? d.Id ?? '') as string).slice(0, 12)
    const name = (d.Name ?? d.Names ?? '') as string
    const cpu = (d.CPUPerc ?? d.CPU ?? '-') as string
    const mem = (d.MemUsage ?? d.MemoryUsage ?? '-') as string
    const memPct = (d.MemPerc ?? d.MemoryPerc ?? '-') as string
    const entry = { cpu, cpuPct: parsePct(cpu), mem, memPct: parsePct(memPct) }
    if (id) m.set(id, entry)
    if (name) m.set(name, entry)
  }
  return m
}

export async function snapshot(): Promise<Snapshot> {
  const out: RuntimeSnapshot[] = []
  for (const rt of RUNTIMES) {
    const available = await runtimeAvailable(rt)
    if (!available) {
      out.push({ runtime: rt, available: false, daemonUp: false, containers: [] })
      continue
    }
    const daemonUp = await runtimeDaemonUp(rt)
    if (!daemonUp) {
      out.push({ runtime: rt, available: true, daemonUp: false, containers: [] })
      continue
    }
    const cs = await listContainers(rt)
    if (cs.length > 0) {
      const sm = await statsMap(rt)
      for (const c of cs) {
        const s = sm.get(c.id) || sm.get(c.name)
        if (s) {
          c.cpu = s.cpu; c.cpuPct = s.cpuPct
          c.mem = s.mem; c.memPct = s.memPct
        }
      }
    }
    out.push({ runtime: rt, available: true, daemonUp: true, containers: cs })
  }
  return { ts: Date.now(), runtimes: out }
}

export async function containerAction(rt: Runtime, id: string, action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause'): Promise<boolean> {
  const out = await runRuntime(rt, [action, id], 15000)
  return out.trim().length > 0 || true
}
