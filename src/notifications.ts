import { Notification, BrowserWindow } from 'electron'
import { addAlert, AlertEntry, getConfig } from './config'

let mainWindow: BrowserWindow | null = null

export function setNotifyWindow(win: BrowserWindow) { mainWindow = win }

export function notify(opts: {
  kind: AlertEntry['kind']
  title: string
  body: string
  target?: string
  silent?: boolean
}) {
  const cfg = getConfig()

  /* respect snooze */
  const snoozeKey = opts.kind + ':' + (opts.target || '')
  if (cfg.snoozedUntil[snoozeKey] && cfg.snoozedUntil[snoozeKey] > Date.now()) return

  /* respect per-kind toggles */
  if (opts.kind === 'bot-done'    && !cfg.notifyOnBotDone)  return
  if (opts.kind === 'bot-stuck'   && !cfg.notifyOnBotStuck) return
  if (opts.kind === 'bot-crashed' && !cfg.notifyOnBotCrash) return

  const alert = addAlert({ kind: opts.kind, title: opts.title, body: opts.body, target: opts.target })

  if (Notification.isSupported()) {
    try {
      const n = new Notification({
        title:  opts.title,
        body:   opts.body,
        silent: !cfg.soundOnAlert || !!opts.silent,
      })
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('focus-alert', { kind: opts.kind, target: opts.target })
        }
      })
      n.show()
    } catch (e) {
      console.error('notify error:', e)
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('alert-update', alert)
  }
}
