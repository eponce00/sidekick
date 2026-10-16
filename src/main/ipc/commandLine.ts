import { ipcMain } from 'electron'
import { commandLineToolStatus, installCommandLineTool } from '../control/commandLineTool'

export function registerCommandLineHandlers(): void {
  ipcMain.handle('commandLine:status', () => commandLineToolStatus())
  ipcMain.handle('commandLine:install', () => installCommandLineTool())
}
