import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import ConfirmDialog from './ConfirmDialog'
import { SettingsEmptyState } from './SettingsLayout'
import { WorkspaceFileViewer } from './WorkspaceFileViewer'
import { trashQuestion, trashRefusal } from '../../../shared/workspaceTrash'
import { workspacePermissionOperation } from '../../../shared/permissions'
import type { WorkspaceFileViewRequest } from '../utils/workspaceFileViewer'
import type { WorkspaceFolder } from '../../../shared/projects'
import './FilesPanel.css'

export interface FilesPanelProps {
  workspaceFolder: string | null
  /** The folder is the chat's own, as it has no project. */
  chatFolder?: boolean
  /** Holds back deleting while the agent may be using the files. */
  isAgentBusy?: boolean
  /** A file someone asked to see, from anywhere in the app; changes open it in the viewer. */
  fileRequest?: { request: WorkspaceFileViewRequest; at: number } | null
  /** Opens a project folder for the chat, offered while it has none. */
  onOpenProject?: () => void
}

function folderName(folder: string): string {
  return folder.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folder
}

/**
 * The project's files: a tree that follows its folders on disk, one root node for each folder
 * when it has several, and a viewer over it.
 */
export function FilesPanel({
  workspaceFolder,
  chatFolder = false,
  isAgentBusy = false,
  fileRequest = null,
  onOpenProject
}: FilesPanelProps): React.JSX.Element {
  const systemTrashName = window.api.app.platform === 'windows' ? 'Recycle Bin' : 'Trash'
  const [fileMap, setFileMap] = useState<Map<string, string[]>>(new Map())
  // Loading from the first frame, so an unread tree never shows as "No project folder".
  const [fileTreeLoading, setFileTreeLoading] = useState(Boolean(workspaceFolder))
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set())
  const [fileRootName, setFileRootName] = useState<string>('')
  /** The project's other folders; with any, each folder is a root node of the tree. */
  const [otherFolders, setOtherFolders] = useState<WorkspaceFolder[]>([])
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
        setOtherFolders([])
        setFileTreeLoading(false)
        return
      }
      const rootName = chatFolder ? 'Chat files' : folderName(workspaceFolder)
      if (!cancelled) setFileRootName(rootName)
      // Another folder's files start with its name, so each lands under its own root node.
      const result = await window.api.workspace.listProjectFiles(workspaceFolder)
      if (!result.ok || cancelled) {
        setFileTreeLoading(false)
        return
      }
      const normalize = (p: string): string => p.replace(/\\/g, '/')
      const map = new Map<string, string[]>()
      map.set('', [])
      for (const folder of result.folders) map.set(`${folder.name}/`, [])
      for (const rawFile of result.files) {
        const f = normalize(rawFile)
        const isDir = f.endsWith('/')
        const fClean = isDir ? f.slice(0, -1) : f
        const lastSlash = fClean.lastIndexOf('/')
        // `./name/` is the primary's own folder of an extra folder's name, at the top.
        const parent =
          lastSlash >= 0 && fClean.slice(0, lastSlash + 1) !== './'
            ? fClean.slice(0, lastSlash + 1)
            : ''
        if (!map.has(parent)) map.set(parent, [])
        map.get(parent)!.push(f)
        if (isDir && !map.has(f)) map.set(f, [])
      }
      if (!cancelled) {
        setFileMap(map)
        setOtherFolders(result.folders)
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

  // The tree follows the folders on disk, so it never needs a manual refresh.
  const watchedFolders = [
    ...(workspaceFolder ? [workspaceFolder] : []),
    ...otherFolders.map(({ path }) => path)
  ].join('\n')
  useEffect(() => {
    if (!watchedFolders) return
    const stops = watchedFolders
      .split('\n')
      .map((folder) =>
        window.api.workspace.watchFiles(folder, () => setFileRefreshKey((k) => k + 1))
      )
    return () => {
      for (const stop of stops) stop()
    }
  }, [watchedFolders])

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

  /** A folder of the project as a node of its own, its files under it. */
  const renderRootNode = (
    key: string,
    label: string,
    title: string,
    childrenOf: string,
    primary: boolean
  ): React.ReactNode => {
    const isExpanded = !collapsedRoots.has(key)
    const menuPath = primary ? '' : childrenOf.slice(0, -1)
    return (
      <div key={key}>
        <div
          className="file-node-row file-root-row"
          onContextMenu={(event) => {
            event.preventDefault()
            showPathMenu(menuPath, true)
          }}
        >
          <button
            className="file-node file-node-dir"
            style={{ paddingLeft: '10px' }}
            aria-expanded={isExpanded}
            onClick={() =>
              setCollapsedRoots((prev) => {
                const next = new Set(prev)
                next.has(key) ? next.delete(key) : next.add(key)
                return next
              })
            }
            title={title}
          >
            <span className="file-node-chevron">
              <ChevronRight
                size={10}
                style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              />
            </span>
            <span className="file-node-icon">
              {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
            </span>
            <span className="file-node-name">{label}</span>
            {primary && <span className="file-root-mark">Primary</span>}
          </button>
          <button
            className="file-node-action"
            onClick={() => showPathMenu(menuPath, true)}
            title={`More actions for ${label}`}
            aria-label={`More actions for the ${label} folder`}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
        {isExpanded && renderFileTreeLevel(childrenOf, 1)}
      </div>
    )
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
                {isDir ? (
                  isExpanded ? (
                    <FolderOpen size={13} />
                  ) : (
                    <Folder size={13} />
                  )
                ) : (
                  <File size={13} />
                )}
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
            <span className="file-explorer-root-name section-heading">
              {otherFolders.length ? 'Folders' : fileRootName || 'Workspace'}
            </span>
            {/* With no folder there is nothing to refresh or act on. */}
            {workspaceFolder && (
              <>
                <button
                  type="button"
                  className="settings-ghost-action is-small is-icon"
                  onClick={() => setFileRefreshKey((k) => k + 1)}
                  title="Refresh file tree"
                  aria-label="Refresh file tree"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  type="button"
                  className="settings-ghost-action is-small is-icon"
                  onClick={() => showPathMenu('', true)}
                  title={`More actions for the ${chatFolder ? 'chat' : 'project'} folder`}
                  aria-label={`More actions for the ${chatFolder ? 'chat' : 'project'} folder`}
                >
                  <MoreHorizontal size={14} />
                </button>
              </>
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
            <div className="files-panel-empty">
              <SettingsEmptyState
                compact
                centered
                icon={FolderOpen}
                title="No project folder"
                description="Open a folder to browse its files here."
                action={
                  onOpenProject && (
                    <button
                      type="button"
                      className="settings-secondary-action"
                      onClick={onOpenProject}
                      disabled={isAgentBusy}
                      title={isAgentBusy ? 'Stop the agent to open a project' : undefined}
                    >
                      Open project
                    </button>
                  )
                }
              />
            </div>
          ) : (
            <div className="file-tree">
              {otherFolders.length && workspaceFolder
                ? [
                    renderRootNode('', fileRootName, workspaceFolder, '', true),
                    ...otherFolders.map((folder) =>
                      renderRootNode(
                        `${folder.name}/`,
                        folder.name,
                        folder.path,
                        `${folder.name}/`,
                        false
                      )
                    )
                  ]
                : renderFileTreeLevel('', 0)}
            </div>
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
