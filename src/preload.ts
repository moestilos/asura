import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('asura', {
  /* projects */
  requestProjects:  ()        => ipcRenderer.send('request-projects'),
  onProjects:       (cb: (p: any[]) => void) =>
    ipcRenderer.on('projects-update', (_e, data) => cb(data)),

  /* bots */
  requestBots:      ()        => ipcRenderer.send('request-bots'),
  onBots:           (cb: (b: any[]) => void) =>
    ipcRenderer.on('bots-update', (_e, data) => cb(data)),
  clearBot:         (id: string) => ipcRenderer.invoke('clear-bot', id),
  pauseBot:         (id: string) => ipcRenderer.invoke('pause-bot', id),
  resumeBot:        (id: string) => ipcRenderer.invoke('resume-bot', id),

  /* infra (docker / podman / wsl containers) */
  requestInfra:     ()        => ipcRenderer.send('request-infra'),
  onInfra:          (cb: (s: any) => void) =>
    ipcRenderer.on('infra-update', (_e, data) => cb(data)),
  containerAction:  (runtime: string, id: string, action: string) =>
    ipcRenderer.send('infra-action', { runtime, id, action }),

  /* config & favorites */
  getConfig:        ()        => ipcRenderer.invoke('get-config'),
  setConfig:        (patch: any) => ipcRenderer.invoke('set-config', patch),
  toggleFavorite:   (name: string) => ipcRenderer.invoke('toggle-favorite', name),
  toggleHidden:     (name: string) => ipcRenderer.invoke('toggle-hidden', name),
  dismissNew:       (name: string) => ipcRenderer.invoke('dismiss-new', name),
  alwaysOnTop:      (on: boolean) => ipcRenderer.invoke('always-on-top', on),
  clearAlerts:      ()        => ipcRenderer.invoke('clear-alerts'),
  onConfigUpdate:   (cb: (c: any) => void) =>
    ipcRenderer.on('config-update', (_e, data) => cb(data)),
  onAlert:          (cb: (a: any) => void) =>
    ipcRenderer.on('alert-update', (_e, data) => cb(data)),
  onFocusAlert:     (cb: (data: any) => void) =>
    ipcRenderer.on('focus-alert', (_e, data) => cb(data)),

  /* detail */
  getDetail:        (name: string) => ipcRenderer.invoke('get-detail', name),

  /* actions */
  action:           (kind: string, project: string, extra?: string) =>
    ipcRenderer.invoke('action', kind, project, extra),

  /* github */
  requestGithubRefresh: ()         => ipcRenderer.send('request-github-refresh'),
  onGithubUpdate:       (cb: (g: any) => void) =>
    ipcRenderer.on('github-update', (_e, data) => cb(data)),
  markNotificationRead: (id: string) => ipcRenderer.invoke('mark-notification-read', id),
  cloneRepo:            (fullName: string) => ipcRenderer.invoke('clone-repo', fullName),
  deleteProject:        (projectPath: string) => ipcRenderer.invoke('delete-project', projectPath),

  /* window */
  close:            ()        => ipcRenderer.send('close-window'),
  hide:             ()        => ipcRenderer.send('hide-window'),
})
