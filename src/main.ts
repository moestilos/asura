import { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import { scanWorkspace, Project } from './scanner'
import { runAction, ActionKind, setAlwaysOnTop } from './actions'
import { startBotDaemon, stopBotDaemon, getBotList, clearBot } from './bots'
import {
  loadConfig, getConfig, setConfig, toggleFavorite, toggleHidden,
  recordProjectActivity, addAlert, clearAlerts,
} from './config'
import { setNotifyWindow, notify } from './notifications'
import { getDetail } from './detail'
import { snapshot as infraSnapshot, containerAction, Runtime as DockerRuntime, Snapshot as InfraSnap } from './docker'

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..')

let win:    BrowserWindow | null = null
let tray:   Tray | null = null
let cache:  Project[] = []
let timer:  NodeJS.Timeout | null = null
let activityTimer: NodeJS.Timeout | null = null
let infraTimer: NodeJS.Timeout | null = null
let lastInfra: InfraSnap | null = null

/* ── Tray icon (16x16 native pixel — Asura Pixel Phantom) ─────────────────── */
const TRAY_ICON_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZUlEQVR4nGNgGGjAiMz5//X3f6I0cbPC9TFR6gImSg1gQeaw8wlSZgAI/NRuZ4AB9quVYDrsz2e42CoWXgacgcjGzENUIP76+4WRPrHAzidIMFyYiLERr2sYBlVCYkQyGZ/Y4AIA38QWr1JwKVMAAAAASUVORK5CYII='

/* ── Window ────────────────────────────────────────────────────────────────── */
function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const cfg = getConfig()

  win = new BrowserWindow({
    width:           Math.min(880, sw - 80),
    height:          Math.min(940, sh - 60),
    minWidth:        420,
    minHeight:       480,
    frame:           false,
    transparent:     false,
    resizable:       true,
    backgroundColor: '#08090b',
    alwaysOnTop:     cfg.alwaysOnTop,
    show:            true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
    },
  })

  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')

  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => refresh())

  // close button = full exit (no tray ghost). Use tray menu "Hide" if want background.
}

/* ── Tray ──────────────────────────────────────────────────────────────────── */
function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA)
  tray = new Tray(icon)
  tray.setToolTip('Asura — workspace dashboard')
  rebuildTrayMenu()
  tray.on('click', () => { win?.show(); win?.focus() })
}

function rebuildTrayMenu() {
  if (!tray) return
  const cfg = getConfig()
  const activeBots = require('./bots').getBotList().filter((b: any) => b.status === 'running').length
  const tip = `Asura · ${cache.length} proyectos · ${cache.filter(p => p.status === 'active').length} activos · ${activeBots} bots`
  tray.setToolTip(tip)

  const menu = Menu.buildFromTemplate([
    { label: tip, enabled: false },
    { type: 'separator' },
    { label: 'Mostrar Asura', click: () => { win?.show(); win?.focus() } },
    {
      label: 'Always on top',
      type:  'checkbox',
      checked: cfg.alwaysOnTop,
      click: (mi) => {
        if (win) setAlwaysOnTop(win, mi.checked)
        setConfig({ alwaysOnTop: mi.checked })
        win?.webContents.send('config-update', getConfig())
      },
    },
    { type: 'separator' },
    {
      label: 'Refrescar ahora',
      click: () => refresh(),
    },
    { type: 'separator' },
    { label: 'Salir',  click: () => app.exit(0) },
  ])
  tray.setContextMenu(menu)
}

/* ── Refresh + project activity tracking ───────────────────────────────────── */
let refreshing = false
let prevNames: Set<string> = new Set()

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const newCache = await scanWorkspace(WORKSPACE_ROOT)

    /* detect new projects */
    const cfg = getConfig()
    for (const p of newCache) {
      if (!prevNames.has(p.name) && prevNames.size > 0 && p.isNew) {
        notify({
          kind: 'project-new',
          title: 'Nuevo proyecto detectado',
          body: p.name + ' · ' + (p.stack.join(', ') || 'sin stack'),
          target: p.name,
        })
      }
    }
    prevNames = new Set(newCache.map(p => p.name))

    /* branch stale check — silently */
    for (const p of newCache) {
      if (p.git.branch && p.git.branch !== 'main' && p.git.branch !== 'master' &&
          p.git.ahead > 0 && p.git.lastCommitTs) {
        const daysSince = (Date.now() - p.git.lastCommitTs) / 86_400_000
        if (daysSince > 7) {
          // ALERT only once per branch
          const key = 'stale:' + p.name + ':' + p.git.branch
          if (!cfg.snoozedUntil[key]) {
            // mark snooze 30d so doesn't repeat
            cfg.snoozedUntil[key] = Date.now() + 30 * 86_400_000
            setConfig({ snoozedUntil: cfg.snoozedUntil })
            addAlert({
              kind:  'branch-stale',
              title: 'Branch stale · ' + p.name,
              body:  p.git.branch + ' lleva ' + Math.floor(daysSince) + 'd sin push (ahead: ' + p.git.ahead + ')',
              target: p.name,
            })
          }
        }
      }
    }

    cache = newCache
    if (win && !win.isDestroyed()) {
      win.webContents.send('projects-update', cache)
    }
    rebuildTrayMenu()
  } finally {
    refreshing = false
  }
}

async function sendInfra() {
  try {
    lastInfra = await infraSnapshot()
    if (win && !win.isDestroyed()) win.webContents.send('infra-update', lastInfra)
  } catch (e) {
    console.error('infra snapshot failed', e)
  }
}

function startInfraPolling() {
  if (infraTimer) clearInterval(infraTimer)
  infraTimer = setInterval(sendInfra, 3000)
}

/* track time spent per project — simplified: count refreshes where project is "active" */
function startActivityTracking() {
  let lastTick = Date.now()
  activityTimer = setInterval(() => {
    const now = Date.now()
    const delta = now - lastTick
    lastTick = now
    /* attribute time to projects with active status (modified <24h) */
    for (const p of cache) {
      if (p.status === 'active') recordProjectActivity(p.name, delta / cache.filter(q => q.status === 'active').length || delta)
    }
  }, 60_000)
}

/* ── IPC ───────────────────────────────────────────────────────────────────── */
ipcMain.on('request-projects', () => refresh())
ipcMain.on('request-bots',     () => {
  if (win && !win.isDestroyed()) win.webContents.send('bots-update', getBotList())
})
ipcMain.on('request-infra',    async () => { await sendInfra() })
ipcMain.on('infra-action',     async (_e, p: { runtime: DockerRuntime, id: string, action: 'start'|'stop'|'restart'|'pause'|'unpause' }) => {
  await containerAction(p.runtime, p.id, p.action)
  await sendInfra()
})
ipcMain.on('close-window',     () => { app.exit(0) })
ipcMain.on('hide-window',      () => win?.hide())

ipcMain.handle('clear-bot',      async (_e, id: string) => { clearBot(id); return 'cleared' })
ipcMain.handle('pause-bot',      async (_e, id: string) => {
  const m = require('./bots') as typeof import('./bots')
  m.setBotPaused(id, true); return 'paused'
})
ipcMain.handle('resume-bot',     async (_e, id: string) => {
  const m = require('./bots') as typeof import('./bots')
  m.setBotPaused(id, false); return 'resumed'
})

ipcMain.handle('get-config',     async () => getConfig())
ipcMain.handle('set-config',     async (_e, patch) => {
  const c = setConfig(patch)
  rebuildTrayMenu()
  if ('autoStart' in patch) applyAutoStart()
  return c
})
ipcMain.handle('toggle-favorite',async (_e, name: string) => { const v = toggleFavorite(name); refresh(); return v })
ipcMain.handle('toggle-hidden',  async (_e, name: string) => { const v = toggleHidden(name); refresh(); return v })
ipcMain.handle('clear-alerts',   async () => { clearAlerts(); win?.webContents.send('config-update', getConfig()); return 'cleared' })

ipcMain.handle('always-on-top',  async (_e, on: boolean) => {
  if (win) setAlwaysOnTop(win, on)
  setConfig({ alwaysOnTop: on })
  rebuildTrayMenu()
  return on
})

ipcMain.handle('get-detail',     async (_e, projectName: string) => {
  const proj = cache.find(p => p.name === projectName)
  if (!proj) return null
  return getDetail(proj.path)
})

ipcMain.handle('action', async (_e, kind: ActionKind, projectName: string, extra?: string) => {
  const proj = cache.find(p => p.name === projectName)
  if (!proj) return 'project not found'
  return runAction(kind, proj.path, extra)
})

/* ── App lifecycle ─────────────────────────────────────────────────────────── */
function applyAutoStart() {
  try {
    const cfg = getConfig()
    app.setLoginItemSettings({
      openAtLogin: !!cfg.autoStart,
      args:        ['--hidden'],
    })
  } catch (e) {
    console.error('autostart error:', e)
  }
}

app.whenReady().then(async () => {
  await loadConfig()
  createWindow()
  if (win) {
    setNotifyWindow(win)
    startBotDaemon(win)
  }
  createTray()
  applyAutoStart()
  /* if started with --hidden (boot autostart), keep tray-only */
  if (process.argv.includes('--hidden')) win?.hide()
  timer = setInterval(refresh, getConfig().refreshRateMs || 30_000)
  startActivityTracking()
  startInfraPolling()
  sendInfra()
})

app.on('window-all-closed', () => { /* keep alive in tray */ })
app.on('before-quit', () => {
  if (timer) clearInterval(timer)
  if (activityTimer) clearInterval(activityTimer)
  stopBotDaemon()
})
