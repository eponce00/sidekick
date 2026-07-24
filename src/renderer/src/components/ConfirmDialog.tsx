import { useId } from 'react'
import { useModalDialog } from '../hooks/useModalDialog'
import './ConfirmDialog.css'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm: () => void
  onCancel: () => void
  variant?: 'default' | 'danger' | 'success'
}

function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'default'
}: ConfirmDialogProps): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, onCancel)
  const titleId = useId()
  const descriptionId = useId()
  if (!isOpen) return null

  const handleConfirm = () => {
    onConfirm()
  }

  const handleCancel = () => {
    onCancel()
  }

  return (
    <div className="confirm-overlay" role="presentation" onClick={handleCancel}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-header">
          <h3 id={titleId} className="confirm-title">
            {title}
          </h3>
        </div>
        <div className="confirm-body">
          <p id={descriptionId} className="confirm-message">
            {message}
          </p>
        </div>
        <div className="confirm-footer">
          <button type="button" onClick={handleCancel} className="confirm-btn confirm-btn-cancel">
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className={`confirm-btn confirm-btn-confirm confirm-btn-${variant}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
