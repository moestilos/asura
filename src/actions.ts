import { spawn } from 'child_process'
import { shell, BrowserWindow } from 'electron'
import { getConfig } from './config'

export type ActionKind =
  | 'open-vscode'
  | 'open-terminal'
  | 'open-folder'
  | 'open-handoff'
  | 'open-dev-url'
  | 'open-output'
  | 'run-script'
  | 'open-cursor'
  | 'open-explorer'

function runShell(cmdLine: string): void {
  spawn(cmdLine, [], {
    shell:    true,
    detached: true,
    stdio:    'ignore',
    windowsHide: false,
  }).unref()
}

function quote(p: string): string {
  return '"' + p.replace(/"/g, '\\"') + '"'
}

function pickEditor(): string {
  const cfg = getConfig()
  const ed = cfg.preferredEditor
  if (ed === 'cursor')   return 'cursor'
  if (ed === 'subl')     return 'subl'
  if (ed === 'webstorm') return 'webstorm'
  if (ed === 'code')     return 'code'
  /* auto: try cursor first if installed, else code */
  return 'code'
}

export async function runAction(
  kind: ActionKind,
  projectPath: string,
  extra?: string,
): Promise<string> {
  switch (kind) {
    case 'open-vscode': {
      const editor = pickEditor()
      runShell(`${editor} ${quote(projectPath)}`)
      return editor + ' opened'
    }

    case 'open-cursor':
      runShell(`cursor ${quote(projectPath)}`)
      return 'cursor opened'

    case 'open-terminal': {
      const cfg = getConfig()
      const claudeCmd = cfg.adminMode ? 'claude --dangerously-skip-permissions' : 'claude'
      try {
        runShell(`wt -d ${quote(projectPath)} cmd /k ${claudeCmd}`)
      } catch {
        runShell(`start "" cmd /k "cd /d ${quote(projectPath)} && ${claudeCmd}"`)
      }
      return 'terminal opened'
    }

    case 'open-folder':
    case 'open-explorer':
      await shell.openPath(projectPath)
      return 'folder opened'

    case 'open-handoff':
      if (extra) await shell.openPath(extra)
      return 'handoff opened'

    case 'open-dev-url':
      if (extra) await shell.openExternal(extra)
      return 'url opened'

    case 'open-output':
      if (extra) await shell.openPath(extra)
      return 'output opened'

    case 'run-script':
      // extra is the npm script name
      if (!extra) return 'no script name'
      runShell(`wt -d ${quote(projectPath)} cmd /k "npm run ${extra}"`)
      return 'script run: ' + extra

    default:
      return 'unknown'
  }
}

/* always-on-top toggle */
export function setAlwaysOnTop(win: BrowserWindow, on: boolean) {
  win.setAlwaysOnTop(on, 'floating')
}
