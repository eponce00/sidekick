import { FolderOpen, X } from 'lucide-react'
import './WorkspaceIndicator.css'

interface WorkspaceIndicatorProps {
  workspaceFolder: string
  onClear: () => void
}

function getFolderName(fullPath: string): string {
  return fullPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? fullPath
}

export function WorkspaceIndicator({
  workspaceFolder,
  onClear
}: WorkspaceIndicatorProps): React.JSX.Element {
  const name = getFolderName(workspaceFolder)

  function handleOpenFolder(): void {
    window.api.workspace.openFolder(workspaceFolder)
  }

  return (
    <div
      className="workspace-indicator"
      title={workspaceFolder}
      onClick={handleOpenFolder}
      style={{ cursor: 'pointer' }}
    >
      <FolderOpen size={13} className="workspace-icon" />
      <span className="workspace-name">{name}</span>
      <button
        className="workspace-clear-btn"
        onClick={(e) => {
          e.stopPropagation()
          onClear()
        }}
        title="Close workspace"
        aria-label="Close workspace"
      >
        <X size={11} />
      </button>
    </div>
  )
}
