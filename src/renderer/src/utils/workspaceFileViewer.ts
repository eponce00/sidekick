/**
 * Requests to show a workspace file in the side panel viewer. A file reference
 * can be clicked from deep inside a message, while the viewer lives in the
 * activity panel; this keeps the two decoupled without threading a callback
 * through every layer between them.
 */
export interface WorkspaceFileViewRequest {
  workspaceRoot: string
  filePath: string
  /** 1-based line to bring into view, when the reference carried one. */
  line?: number
}

type Listener = (request: WorkspaceFileViewRequest) => void

const listeners = new Set<Listener>()

export function requestWorkspaceFileView(request: WorkspaceFileViewRequest): boolean {
  if (!listeners.size) return false
  for (const listener of listeners) listener(request)
  return true
}

export function subscribeWorkspaceFileView(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
