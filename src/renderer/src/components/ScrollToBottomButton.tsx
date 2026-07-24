import { ArrowDown } from 'lucide-react'

interface ScrollToBottomButtonProps {
  visible: boolean
  onClick: () => void
}

export function ScrollToBottomButton({
  visible,
  onClick
}: ScrollToBottomButtonProps): React.JSX.Element | null {
  if (!visible) return null
  return (
    <button
      type="button"
      className="scroll-to-bottom-button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      title="Jump to latest message"
      aria-label="Jump to latest message"
    >
      <ArrowDown size={18} strokeWidth={1.9} />
    </button>
  )
}
