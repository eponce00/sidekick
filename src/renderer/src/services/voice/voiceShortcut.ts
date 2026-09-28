import { matchesShortcut, shortcutLabel } from '../../../../shared/keyboardShortcuts'
import type { DesktopPlatform } from '../../../../shared/platform'

// Ctrl+Space turns voice on and off; on macOS, where Ctrl+Space switches input
// sources, it is Option+Space. Alt+Space is not used on Windows: it opens the
// window menu, and launchers such as PowerToys Run take it. The keys live in
// the shared shortcut table.
function platform(): DesktopPlatform {
  return typeof window !== 'undefined' && window.api?.app?.platform === 'macos'
    ? 'macos'
    : 'windows'
}

export function isVoiceShortcut(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat'>
): boolean {
  return !event.repeat && matchesShortcut(event, 'toggle-voice', platform())
}

export function voiceShortcutLabel(): string {
  return shortcutLabel('toggle-voice', platform())
}
