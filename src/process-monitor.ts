import { exec } from 'child_process'
import { promisify } from 'util'

const execp = promisify(exec)

export interface ProcessStat {
  pid: number
  alive: boolean
  cpuPct: number | null
  memMB: number | null
}

/**
 * Windows: use wmic / typeperf alternative — fall back to tasklist for memory only.
 * This is rough — exact CPU% requires sampling.
 */
export async function statPid(pid: number): Promise<ProcessStat> {
  if (!pid || pid <= 0) return { pid: 0, alive: false, cpuPct: null, memMB: null }
  try {
    const { stdout } = await execp(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { windowsHide: true, timeout: 2500 }
    )
    if (!stdout.trim() || stdout.includes('No tasks')) {
      return { pid, alive: false, cpuPct: null, memMB: null }
    }
    /* CSV: "img.exe","pid","Console","1","12,345 K" */
    const cols = stdout.trim().split(',').map(s => s.replace(/^"|"$/g, ''))
    const memStr = cols[4] || ''
    const memKB = parseInt(memStr.replace(/[^\d]/g, ''), 10) || 0
    return { pid, alive: true, cpuPct: null, memMB: memKB / 1024 }
  } catch {
    return { pid, alive: false, cpuPct: null, memMB: null }
  }
}
