import { useId, useState } from 'react'
import { Folder, FolderPlus, Star, X } from 'lucide-react'
import type { Project } from '../../../shared/projects'
import { useModalDialog } from '../hooks/useModalDialog'
import './ConfirmDialog.css'
import './EditProjectDialog.css'

interface EditProjectDialogProps {
  project: Project
  /** Holds back removing or swapping folders while one of the project's chats is working. */
  busy: boolean
  onClose: () => void
  /** Called with the project as saved. */
  onSaved: (project: Project) => void
}

/** A folder as the dialog lists it: one the project has, or one picked but not saved yet. */
interface DraftFolder {
  path: string
  /** The saved folder's name; a new one is named when it is saved. */
  name: string | null
}

function folderLabel(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

/**
 * Edits a project: its name and its folders. One folder is the primary one, where commands start
 * and whose Git, instructions and memory apply; the agent reads and edits the others by name.
 */
export function EditProjectDialog({
  project,
  busy,
  onClose,
  onSaved
}: EditProjectDialogProps): React.JSX.Element {
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose)
  const titleId = useId()
  const nameId = useId()
  const [name, setName] = useState(project.name)
  const [primary, setPrimary] = useState(project.folder_path)
  const [folders, setFolders] = useState<DraftFolder[]>(() => [
    { path: project.folder_path, name: null },
    ...(project.folders ?? []).map((folder) => ({ path: folder.path, name: folder.name }))
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addFolder = async (): Promise<void> => {
    setError(null)
    const picked = await window.api.workspace.selectFolder()
    if (picked.canceled || !picked.path) return
    const path = picked.path
    if (folders.some((folder) => folder.path.toLowerCase() === path.toLowerCase())) {
      setError(`${folderLabel(path)} is already in this project.`)
      return
    }
    setFolders((current) => [...current, { path, name: null }])
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      let saved = project
      if (name.trim() && name.trim() !== project.name) {
        saved = await window.api.projects.update(project.id, { name: name.trim() })
      }
      const kept = new Set(folders.map((folder) => folder.path))
      const savedFolders = [
        { path: project.folder_path, name: null as string | null },
        ...(project.folders ?? [])
      ]
      const remove = (project.folders ?? [])
        .filter((folder) => !kept.has(folder.path))
        .map((folder) => folder.name)
      const add = folders
        .filter((folder) => !savedFolders.some((existing) => existing.path === folder.path))
        .map((folder) => folder.path)
      if (add.length || remove.length) {
        saved = await window.api.projects.updateFolders({ projectId: project.id, add, remove })
      }
      // A new primary is named once it is saved, so it is swapped in a second step.
      if (primary !== saved.folder_path) {
        const chosen = saved.folders?.find((folder) => folder.path === primary)
        if (chosen) {
          saved = await window.api.projects.updateFolders({
            projectId: project.id,
            makePrimary: chosen.name
          })
        }
      }
      onSaved(saved)
      onClose()
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : String(cause)).replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          ''
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const changesFolders =
    primary !== project.folder_path ||
    folders.length !== (project.folders?.length ?? 0) + 1 ||
    folders.some(
      (folder) =>
        folder.path !== project.folder_path &&
        !(project.folders ?? []).some((saved) => saved.path === folder.path)
    )
  const removesOrSwaps =
    primary !== project.folder_path ||
    (project.folders ?? []).some((saved) => !folders.some((folder) => folder.path === saved.path))

  return (
    <div className="confirm-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="confirm-dialog edit-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="confirm-title">
          Edit project
        </h3>
        <label className="edit-project-field" htmlFor={nameId}>
          <span>Name</span>
          <input
            id={nameId}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !saving) void save()
            }}
          />
        </label>
        <div className="edit-project-folders">
          <div className="edit-project-folders-heading">
            <span className="section-heading">Folders</span>
            <button
              type="button"
              className="edit-project-add"
              onClick={() => void addFolder()}
              disabled={saving}
            >
              <FolderPlus size={14} aria-hidden="true" />
              Add folder
            </button>
          </div>
          <ul className="edit-project-folder-list">
            {folders.map((folder) => {
              const isPrimary = folder.path === primary
              const label = folder.name ?? folderLabel(folder.path)
              return (
                <li key={folder.path} className="edit-project-folder">
                  <Folder size={15} className="edit-project-folder-icon" aria-hidden="true" />
                  <span className="edit-project-folder-copy">
                    <span className="edit-project-folder-name">
                      {label}
                      {isPrimary && <span className="edit-project-primary">Primary</span>}
                    </span>
                    <span className="edit-project-folder-path" title={folder.path}>
                      {folder.path}
                    </span>
                  </span>
                  {!isPrimary && (
                    <span className="edit-project-folder-actions">
                      <button
                        type="button"
                        onClick={() => setPrimary(folder.path)}
                        disabled={saving}
                        title="Make primary"
                        aria-label={`Make ${label} the primary folder`}
                      >
                        <Star size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setFolders((current) =>
                            current.filter((candidate) => candidate.path !== folder.path)
                          )
                        }
                        disabled={saving}
                        title="Remove from project"
                        aria-label={`Remove ${label} from the project`}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="edit-project-note">
            {folders.length > 1
              ? 'Chats start in the primary folder and use its Git, instructions and memory. The agent reads and edits the others by name. Removing a folder leaves its files where they are.'
              : 'Add a folder to work across several repositories or folders in one project.'}
          </p>
        </div>
        {error && (
          <div className="edit-project-error" role="alert">
            {error}
          </div>
        )}
        {busy && removesOrSwaps && !error && (
          <div className="edit-project-busy" role="status">
            Stop the project’s running chats before removing a folder or changing the primary one.
          </div>
        )}
        <div className="confirm-footer">
          <button type="button" className="confirm-btn confirm-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm-btn confirm-btn-confirm confirm-btn-default"
            onClick={() => void save()}
            disabled={
              saving ||
              !name.trim() ||
              (busy && removesOrSwaps) ||
              (name.trim() === project.name && !changesFolders)
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
