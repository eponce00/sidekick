import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AnnotationOverlayMessage, AnnotationOverlayState } from '../shared/annotationOverlay'

// The annotation overlay's whole API: what to draw, and what the user did. Nothing else of
// SideKick's is reachable from it.
contextBridge.exposeInMainWorld('sidekickOverlay', {
  onState: (callback: (state: AnnotationOverlayState) => void) => {
    const listener = (_event: IpcRendererEvent, state: AnnotationOverlayState): void =>
      callback(state)
    ipcRenderer.on('annotationOverlay:state', listener)
    ipcRenderer.send('annotationOverlay:ready')
    return () => ipcRenderer.removeListener('annotationOverlay:state', listener)
  },
  send: (message: AnnotationOverlayMessage) =>
    ipcRenderer.send('annotationOverlay:message', message)
})
