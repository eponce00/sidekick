import React, { useEffect } from 'react'
import { CheckCircle2, CircleAlert, Info } from 'lucide-react'
import './Toast.css'

interface ToastProps {
  message: string
  type: 'success' | 'error' | 'info'
  isVisible: boolean
  onClose: () => void
  duration?: number
}

function Toast({
  message,
  type,
  isVisible,
  onClose,
  duration = 3000
}: ToastProps): React.JSX.Element | null {
  useEffect(() => {
    if (isVisible && duration > 0) {
      const timer = setTimeout(onClose, duration)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isVisible, duration, onClose])

  if (!isVisible) return null

  const icons = {
    success: <CheckCircle2 size={16} />,
    error: <CircleAlert size={16} />,
    info: <Info size={16} />
  }

  return (
    <div className={`toast toast-${type}`} onClick={onClose}>
      <span className="toast-icon">{icons[type]}</span>
      <span className="toast-message">{message}</span>
    </div>
  )
}

export default Toast
