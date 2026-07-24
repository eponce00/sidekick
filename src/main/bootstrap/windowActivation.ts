interface ActivatableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function revealWindow(window: ActivatableWindow | null | undefined): boolean {
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}
