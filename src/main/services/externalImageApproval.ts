import type { ExternalImageApproval } from './agentVisionToolHandlers'
import type { PermissionMode } from '../../shared/permissions'

/** Mode comes from the prepared run, never from model-supplied tool arguments. */
export function externalImageApprovalForMode(
  mode: PermissionMode | undefined,
  confirm: ExternalImageApproval = approveExternalImage
): ExternalImageApproval {
  return async (path, signal) => {
    if (signal.aborted) return false
    if (mode === 'full-access') return true
    return confirm(path, signal)
  }
}

/** Native exact-file consent; never a persisted folder grant. */
export const approveExternalImage: ExternalImageApproval = async (path, signal) => {
  if (signal.aborted) return false
  const { BrowserWindow, dialog } = await import('electron')
  if (signal.aborted) return false
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'warning' as const,
    title: 'Allow external image access?',
    message: 'Allow SideKick to read this image outside the active project?',
    detail: `Only this file will be read and sent to the configured model for visual inspection:\n\n${path}\n\nThis does not grant access to its folder.`,
    buttons: ['Deny', 'Allow this image'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const result = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return !signal.aborted && result.response === 1
}
