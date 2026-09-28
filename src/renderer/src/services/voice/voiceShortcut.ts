// Ctrl+Space turns voice on and off; on macOS, where Ctrl+Space switches input
// sources, it is Option+Space. Alt+Space is not used on Windows: it opens the
// window menu, and launchers such as PowerToys Run take it.
function isMac(): boolean {
  return typeof window !== 'undefined' && window.api?.app?.platform === 'macos'
}

export function isVoiceShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat'>
): boolean {
  if (event.code !== 'Space' || event.shiftKey || event.metaKey || event.repeat) return false
  return isMac() ? event.altKey && !event.ctrlKey : event.ctrlKey && !event.altKey
}

export function voiceShortcutLabel(): string {
  return isMac() ? '⌥Space' : 'Ctrl+Space'
}
