import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

const CONFIG_DIR  = path.join(os.homedir(), '.asura')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export type ThemeId =
  | 'synthwave' | 'brutalist' | 'blueprint' | 'solarpunk' | 'vaporwave'
  | 'risograph' | 'cyberpunk' | 'sumie'      | 'manga'    | 'rain'
  | 'akira'     | 'ghost'     | 'dark'       | 'light'

export interface Config {
  favorites:        string[]              // project names pinned
  hidden:           string[]              // project names hidden (oculto en cualquier vista)
  archived:         string[]              // project names archived (oculto en TODOS, visible en ARCHIVADOS)
  alwaysOnTop:      boolean
  theme:            ThemeId
  soundOnAlert:     boolean
  notifyOnBotDone:  boolean
  notifyOnBotStuck: boolean
  notifyOnBotCrash: boolean
  refreshRateMs:    number
  preferredEditor:  'auto' | 'code' | 'cursor' | 'subl' | 'webstorm'
  workspaceRoots:   string[]
  alertsHistory:    AlertEntry[]
  projectFirstSeen: Record<string, number> // for "new project" detection
  dismissedNew:     string[]              // project names whose "nuevo" badge user dismissed
  projectActivity:  Record<string, number> // ms accumulated tracking
  snoozedUntil:     Record<string, number> // alertKey -> ts
  installedAt:      number                  // first ever launch ts — projects firstSeen near this aren't "new"
  autoStart:        boolean                  // launch on Windows boot
}

export interface AlertEntry {
  ts:     number
  kind:   'bot-done' | 'bot-stuck' | 'bot-crashed' | 'bot-anomaly' | 'project-new' | 'branch-stale' | 'info'
  title:  string
  body:   string
  target?: string  // bot id or project name
}

const DEFAULTS: Config = {
  favorites:        [],
  hidden:           [],
  archived:         [],
  alwaysOnTop:      false,
  theme:            'synthwave',
  soundOnAlert:     false,
  notifyOnBotDone:  true,
  notifyOnBotStuck: true,
  notifyOnBotCrash: true,
  refreshRateMs:    30_000,
  preferredEditor:  'auto',
  workspaceRoots:   [],
  alertsHistory:    [],
  projectFirstSeen: {},
  dismissedNew:     [],
  projectActivity:  {},
  snoozedUntil:     {},
  installedAt:      0,
  autoStart:        false,
}

let cache: Config = { ...DEFAULTS }
let saveTimer: NodeJS.Timeout | null = null

export async function loadConfig(): Promise<Config> {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      cache = { ...DEFAULTS }
      return cache
    }
    const raw = await fsp.readFile(CONFIG_FILE, 'utf-8')
    const data = JSON.parse(raw)
    cache = { ...DEFAULTS, ...data,
      favorites:        Array.isArray(data.favorites) ? data.favorites : [],
      hidden:           Array.isArray(data.hidden) ? data.hidden : [],
      archived:         Array.isArray(data.archived) ? data.archived : [],
      workspaceRoots:   Array.isArray(data.workspaceRoots) ? data.workspaceRoots : [],
      alertsHistory:    Array.isArray(data.alertsHistory) ? data.alertsHistory : [],
      projectFirstSeen: data.projectFirstSeen || {},
      dismissedNew:     Array.isArray(data.dismissedNew) ? data.dismissedNew : [],
      projectActivity:  data.projectActivity  || {},
      snoozedUntil:     data.snoozedUntil     || {},
      installedAt:      data.installedAt || Date.now(),
    }
  } catch {
    cache = { ...DEFAULTS, installedAt: Date.now() }
  }
  if (!cache.installedAt) cache.installedAt = Date.now()
  scheduleSave()
  return cache
}

export function getConfig(): Config { return cache }

export function setConfig(patch: Partial<Config>): Config {
  cache = { ...cache, ...patch }
  scheduleSave()
  return cache
}

export function addAlert(entry: Omit<AlertEntry, 'ts'>): AlertEntry {
  const a: AlertEntry = { ts: Date.now(), ...entry }
  cache.alertsHistory.unshift(a)
  if (cache.alertsHistory.length > 100) cache.alertsHistory.length = 100
  scheduleSave()
  return a
}

export function clearAlerts() {
  cache.alertsHistory = []
  scheduleSave()
}

export function toggleFavorite(name: string): boolean {
  const i = cache.favorites.indexOf(name)
  if (i >= 0) { cache.favorites.splice(i, 1); scheduleSave(); return false }
  cache.favorites.push(name); scheduleSave()
  return true
}

export function toggleHidden(name: string): boolean {
  const i = cache.hidden.indexOf(name)
  if (i >= 0) { cache.hidden.splice(i, 1); scheduleSave(); return false }
  cache.hidden.push(name); scheduleSave()
  return true
}

export function recordProjectActivity(name: string, deltaMs: number) {
  cache.projectActivity[name] = (cache.projectActivity[name] || 0) + deltaMs
  scheduleSave()
}

export function dismissNewBadge(name: string) {
  if (!cache.dismissedNew.includes(name)) {
    cache.dismissedNew.push(name)
    scheduleSave()
  }
}

export function markProjectFirstSeen(name: string) {
  if (!cache.projectFirstSeen[name]) {
    cache.projectFirstSeen[name] = Date.now()
    scheduleSave()
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    await save()
  }, 800)
}

export async function save() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) await fsp.mkdir(CONFIG_DIR, { recursive: true })
    await fsp.writeFile(CONFIG_FILE, JSON.stringify(cache, null, 2))
  } catch (e) {
    console.error('config: save error', e)
  }
}
