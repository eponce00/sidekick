import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  File,
  Folder,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import ConfirmDialog from './ConfirmDialog'
import { WorkspaceFileViewer } from './WorkspaceFileViewer'
import { trashQuestion, trashRefusal } from '../../../shared/workspaceTrash'
import { workspacePermissionOperation } from '../../../shared/permissions'
import type { WorkspaceFileViewRequest } from '../utils/workspaceFileViewer'
import './FilesPanel.css'

export interface FilesPanelProps {
  workspaceFolder: string | null
  /** The folder is the chat's own, as it has no project. */
  chatFolder?: boolean
  /** Holds back deleting while the agent may be using the files. */
  isAgentBusy?: boolean
  /** A file someone asked to see, from anywhere in the app; changes open it in the viewer. */
  fileRequest?: { request: WorkspaceFileViewRequest; at: number } | null
}

/** The project's files: a tree that follows the folder on disk, and a viewer over it. */
export function FilesPanel({
  workspaceFolder,
  chatFolder = false,
  isAgentBusy = false,
  fileRequest = null
}: FilesPanelProps): React.JSX.Element {
  const systemTrashName = window.api.app.platform === 'windows' ? 'Recycle Bin' : 'Trash'
  const [fileMap, setFileMap] = useState<Map<string, string[]>>(new Map())
  // Loading from the first frame, so an unread tree never shows as "No project folder".
  const [fileTreeLoading, setFileTreeLoading] = useState(Boolean(workspaceFolder))
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [fileRootName, setFileRootName] = useState<string>('')
  const [fileRefreshKey, setFileRefreshKey] = useState(0)
  const [viewedFile, setViewedFile] = useState<WorkspaceFileViewRequest | null>(
    fileRequest?.request ?? null
  )
  const [handledFileRequestAt, setHandledFileRequestAt] = useState(fileRequest?.at)
  if (fileRequest && fileRequest.at !== handledFileRequestAt) {
    setHandledFileRequestAt(fileRequest.at)
    setViewedFile(fileRequest.request)
  }
  /** The file or folder waiting on "Move to Recycle Bin?", with what a folder holds. */
  const [pendingFileDelete, setPendingFileDelete] = useState<{
    path: string
    isDirectory: boolean
    items?: { count: number; more: boolean }
  } | null>(null)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [fileActionError, setFileActionError] = useState<string | null>(null)

  // The viewer and file actions are per-workspace; a project switch closes them. Done while
  // rendering, not in an effect, so the file a request opened at mount stays open.
  const [shownFolder, setShownFolder] = useState(workspaceFolder)
  if (workspaceFolder !== shownFolder) {
    setShownFolder(workspaceFolder)
    setViewedFile(null)
    setPendingFileDelete(null)
    setDeletingFile(null)
    setFileActionError(null)
  }

  // Load the file tree when shown, on refresh, and for a new project.
  useEffect(() => {
    let cancelled = false
    setFileTreeLoading(true)
    const load = async (): Promise<void> => {
      if (!workspaceFolder || cancelled) {
        setFileMap(new Map())
        setFileRootName('')
        setFileTreeLoading(false)
        return
      }
      const rootName = chatFolder
        ? 'Chat files'
        : workspaceFolder.replace(/\\/g, '/').split('/').pop() || workspaceFolder
      if (!cancelled) setFileRootName(rootName)
      const result = await window.api.workspace.listFiles(workspaceFolder)
      if (!result.ok || cancelled) {
        setFileTreeLoading(false)
        return
      }
      const normalize = (p: string): string => p.replace(/\\/g, '/')
      const map = new Map<string, string[]>()
      map.set('', [])
      for (const rawFile of result.files) {
        const f = normalize(rawFile)
        const isDir = f.endsWith('/')
        const fClean = isDir ? f.slice(0, -1) : f
        const lastSlash = fClean.lastIndexOf('/')
        const parent = lastSlash >= 0 ? fClean.slice(0, lastSlash + 1) : ''
        if (!map.has(parent)) map.set(parent, [])
        map.get(parent)!.push(f)
        if (isDir && !map.has(f)) map.set(f, [])
      }
      if (!cancelled) {
        setFileMap(map)
        setFileTreeLoading(false)
      }
    }
    load().catch(() => {
      if (!cancelled) setFileTreeLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [chatFolder, fileRefreshKey, workspaceFolder])

  // The tree follows the folder on disk, so it never needs a manual refresh.
  useEffect(() => {
    if (!workspaceFolder) return
    return window.api.workspace.watchFiles(workspaceFolder, () => {
      setFileRefreshKey((k) => k + 1)
    })
  }, [workspaceFolder])

  const moveFileToTrash = async (filePath: string): Promise<void> => {
    if (!workspaceFolder || deletingFile || isAgentBusy) return
    setDeletingFile(filePath)
    setFileActionError(null)
    try {
      // The in-app confirmation is the explicit approval for this user-initiated action.
      // Always Ask mode may still require the global native approval dialog.
      const requestedAccess = 'auto' as const
      const authorization = await window.api.permissions.authorize(
        workspacePermissionOperation('delete', filePath, undefined, requestedAccess)
      )
      if (!authorization.approved || !authorization.token) return

      const result = await window.api.workspace.trashFile(workspaceFolder, filePath, {
        requestedAccess,
        authorizationToken: authorization.token
      })
      if (!result.ok)
        throw new Error(result.error || `Could not move the file to ${systemTrashName}`)
      setFileRefreshKey((key) => key + 1)
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingFile(null)
    }
  }

  /** Asks before a file or folder goes to the Recycle Bin; a folder's question says what it holds. */
  const requestTrash = async (filePath: string, isDirectory: boolean): Promise<void> => {
    if (!workspaceFolder || trashRefusal(filePath)) return
    setFileActionError(null)
    const items = isDirectory
      ? await window.api.workspace.countPathItems(workspaceFolder, filePath).catch(() => undefined)
      : undefined
    setPendingFileDelete({ path: filePath, isDirectory, ...(items ? { items } : {}) })
  }

  const showPathMenu = (filePath: string, isDirectory: boolean): void => {
    if (!workspaceFolder) return
    setFileActionError(null)
    const offerTrash = !isAgentBusy && deletingFile === null && !trashRefusal(filePath)
    void window.api.workspace
      .showPathMenu(filePath, workspaceFolder, isDirectory, offerTrash)
      .then((choice) => {
        if (choice === 'trash') void requestTrash(filePath, isDirectory)
      })
      .catch((error) => setFileActionError(error instanceof Error ? error.message : String(error)))
  }

  const renderFileTreeLevel = (parentPath: string, depth: number): React.ReactNode => {
    const children = fileMap.get(parentPath) || []
    const sorted = [...children].sort((a, b) => {
      const aDir = a.endsWith('/')
      const bDir = b.endsWith('/')
      if (aDir && !bDir) return -1
      if (!aDir && bDir) return 1
      return a.localeCompare(b)
    })
    return sorted.map((child) => {
      const isDir = child.endsWith('/')
      const withoutTrailing = isDir ? child.slice(0, -1) : child
      const name = withoutTrailing.split('/').pop() || withoutTrailing
      const isExpanded = expandedFolders.has(child)
      return (
        <div key={child}>
          <div
            className="file-node-row"
            onContextMenu={(event) => {
              event.preventDefault()
              showPathMenu(withoutTrailing, isDir)
            }}
          >
            <button
              className={`file-node${isDir ? ' file-node-dir' : ' file-node-file'}`}
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              onClick={() => {
                if (isDir) {
                  setExpandedFolders((prev) => {
                    const next = new Set(prev)
                    next.has(child) ? next.delete(child) : next.add(child)
                    return next
                  })
                } else if (workspaceFolder) {
                  setViewedFile({ workspaceRoot: workspaceFolder, filePath: withoutTrailing })
                }
              }}
              onDoubleClick={() => {
                if (!isDir && workspaceFolder) {
                  void window.api.workspace.openFile(child, workspaceFolder)
                }
              }}
              title={`${child} — double-click to open externally, right-click for file actions`}
            >
              <span className="file-node-chevron">
                {isDir && (
                  <ChevronRight
                    size={10}
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  />
                )}
              </span>
              <span className="file-node-icon">
                {isDir ? <Folder size={13} /> : <File size={13} />}
              </span>
              <span className="file-node-name">{name}</span>
            </button>
            <button
              className="file-node-action"
              onClick={() => showPathMenu(withoutTrailing, isDir)}
              title={`More actions for ${name}`}
              aria-label={`More actions for ${child}`}
            >
              <MoreHorizontal size={13} />
            </button>
            {!trashRefusal(withoutTrailing) && (
              <button
                className="file-node-delete"
                onClick={() => void requestTrash(withoutTrailing, isDir)}
                disabled={deletingFile !== null || isAgentBusy}
                title={`Delete ${name}`}
                aria-label={`Delete ${withoutTrailing}`}
              >
                {deletingFile === withoutTrailing ? (
                  <Loader2 size={12} className="icon-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
              </button>
            )}
          </div>
          {isDir && isExpanded && renderFileTreeLevel(child, depth + 1)}
        </div>
      )
    })
  }

  return (
    <>
      {viewedFile && (
        <WorkspaceFileViewer
          key={`${viewedFile.workspaceRoot}
${viewedFile.filePath}`}
          request={viewedFile}
          onBack={() => setViewedFile(null)}
        />
      )}

      {!viewedFile && (
        <div className="file-explorer-wrap">
          <div
            className="file-explorer-header"
            onContextMenu={(event) => {
              if (!workspaceFolder) return
              event.preventDefault()
              showPathMenu('', true)
            }}
          >
            <span className="file-explorer-root-name">{fileRootName || 'Workspace'}</span>
            <button
              className="file-explorer-action"
              onClick={() => setFileRefreshKey((k) => k + 1)}
              title="Refresh file tree"
            >
              <RefreshCw size={13} />
            </button>
            {workspaceFolder && (
              <button
                className="file-explorer-action"
                onClick={() => showPathMenu('', true)}
                title={`More actions for the ${chatFolder ? 'chat' : 'project'} folder`}
                aria-label={`More actions for the ${chatFolder ? 'chat' : 'project'} folder`}
              >
                <MoreHorizontal size={13} />
              </button>
            )}
          </div>
          {fileActionError && (
            <div className="file-explorer-error" role="alert">
              <AlertTriangle size={12} />
              <span>{fileActionError}</span>
              <button
                onClick={() => setFileActionError(null)}
                title="Dismiss error"
                aria-label="Dismiss file error"
              >
                <X size={11} />
              </button>
            </div>
          )}
          {fileTreeLoading ? (
            <div className="activity-empty">
              <Loader2 size={16} className="icon-spin" />
              <p>Loading files…</p>
            </div>
          ) : chatFolder && !fileMap.get('')?.length ? (
            <div className="activity-empty">
              <p>No files yet</p>
              <p className="hint">Files this chat makes appear here</p>
            </div>
          ) : fileMap.size === 0 ? (
            <div className="activity-empty">
              <p>No project folder</p>
              <p className="hint">Open a project or move this chat into one</p>
            </div>
          ) : (
            <div className="file-tree">{renderFileTreeLevel('', 0)}</div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={pendingFileDelete !== null}
        title={pendingFileDelete?.isDirectory ? 'Delete folder?' : 'Delete file?'}
        message={pendingFileDelete ? trashQuestion(pendingFileDelete, systemTrashName) : ''}
        confirmText={`Move to ${systemTrashName}`}
        cancelText="Cancel"
        variant="danger"
        onConfirm={() => {
          const filePath = pendingFileDelete?.path
          setPendingFileDelete(null)
          if (filePath) void moveFileToTrash(filePath)
        }}
        onCancel={() => setPendingFileDelete(null)}
      />
    </>
  )
}

export default FilesPanel
