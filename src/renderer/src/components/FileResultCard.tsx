import { FolderOpen, ExternalLink } from 'lucide-react'
import './FileResultCard.css'

const EXT_ICON: Record<string, string> = {
  pdf: '📄',
  docx: '📝',
  doc: '📝',
  xlsx: '📊',
  xls: '📊',
  pptx: '📑',
  ppt: '📑'
}

interface FileResultCardProps {
  filePath: string
  fileName: string
  ext: string
}

export function FileResultCard({
  filePath,
  fileName,
  ext
}: FileResultCardProps): React.JSX.Element {
  const icon = EXT_ICON[ext] ?? '📎'
  const fileManagerName =
    window.api.app.platform === 'macos'
      ? 'Finder'
      : window.api.app.platform === 'windows'
        ? 'File Explorer'
        : 'file manager'

  const openFile = (): void => {
    window.api.workspace.openFile(filePath).catch(() => {})
  }

  const showInFolder = (): void => {
    window.api.workspace.revealFile(filePath).catch(() => {})
  }

  return (
    <div className="file-result-card">
      <span className="file-result-icon">{icon}</span>
      <span className="file-result-name" title={filePath}>
        {fileName}
      </span>
      <div className="file-result-actions">
        <button type="button" className="file-result-btn" onClick={openFile} title="Open file">
          <ExternalLink size={12} />
          Open
        </button>
        <button
          type="button"
          className="file-result-btn"
          onClick={showInFolder}
          title={`Show in ${fileManagerName}`}
        >
          <FolderOpen size={12} />
          Show
        </button>
      </div>
    </div>
  )
}
