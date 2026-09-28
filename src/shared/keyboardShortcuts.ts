import type { DesktopPlatform } from './platform'

/**
 * One key combination. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is the
 * Control key on every platform. `code` is a KeyboardEvent.code, so the
 * shortcut follows the physical key whatever the keyboard layout prints on it.
 */
export interface KeyChord {
  code: string
  mod?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

/** Where a shortcut works. */
export type ShortcutScope = 'app' | 'composer'

export const SHORTCUT_SCOPE_LABELS: Record<ShortcutScope, string> = {
  app: 'Anywhere in SideKick',
  composer: 'In the message box'
}

export const CONVERSATION_JUMP_COUNT = 9

type ConversationJumpId = `jump-to-conversation-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type ShortcutId =
  | 'command-palette'
  | 'new-chat'
  | 'open-project'
  | 'open-settings'
  | ConversationJumpId
  | 'previous-conversation'
  | 'next-conversation'
  | 'toggle-voice'
  | 'paste-plain-text'
  | 'send-message'
  | 'new-line'
  | 'dismiss'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'

export interface KeyboardShortcut {
  id: ShortcutId
  description: string
  scope: ShortcutScope
  keys: KeyChord | { macos: KeyChord; other: KeyChord }
  /**
   * Handled elsewhere (the application menu, the window, the composer); the
   * table lists it so it can be shown next to the action.
   */
  handledBy?: 'menu' | 'window' | 'composer' | 'voice'
}

const jumpShortcuts = Array.from(
  { length: CONVERSATION_JUMP_COUNT },
  (_, index): KeyboardShortcut => ({
    id: `jump-to-conversation-${index + 1}` as ConversationJumpId,
    description: `Go to conversation ${index + 1} in the sidebar`,
    scope: 'app',
    keys: { mod: true, code: `Digit${index + 1}` }
  })
)

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
  {
    id: 'command-palette',
    description: 'Open the command palette',
    scope: 'app',
    keys: { mod: true, code: 'KeyK' }
  },
  {
    id: 'new-chat',
    description: 'New chat',
    scope: 'app',
    keys: { mod: true, code: 'KeyN' },
    handledBy: 'menu'
  },
  {
    id: 'open-project',
    description: 'Open a project folder',
    scope: 'app',
    keys: { mod: true, code: 'KeyO' },
    handledBy: 'menu'
  },
  {
    id: 'open-settings',
    description: 'Open settings',
    scope: 'app',
    keys: { mod: true, code: 'Comma' },
    handledBy: 'menu'
  },
  ...jumpShortcuts,
  {
    id: 'previous-conversation',
    description: 'Previous conversation in the sidebar',
    scope: 'app',
    keys: { mod: true, shift: true, code: 'BracketLeft' }
  },
  {
    id: 'next-conversation',
    description: 'Next conversation in the sidebar',
    scope: 'app',
    keys: { mod: true, shift: true, code: 'BracketRight' }
  },
  {
    // Ctrl+Space switches input sources on macOS, so it is Option+Space there.
    id: 'toggle-voice',
    description: 'Turn voice on or off',
    scope: 'app',
    keys: { macos: { alt: true, code: 'Space' }, other: { ctrl: true, code: 'Space' } },
    handledBy: 'voice'
  },
  {
    id: 'paste-plain-text',
    description: 'Paste long text inline instead of attaching it',
    scope: 'composer',
    keys: { mod: true, shift: true, code: 'KeyV' },
    handledBy: 'composer'
  },
  {
    id: 'send-message',
    description: 'Send the message',
    scope: 'composer',
    keys: { code: 'Enter' },
    handledBy: 'composer'
  },
  {
    id: 'new-line',
    description: 'Start a new line',
    scope: 'composer',
    keys: { shift: true, code: 'Enter' },
    handledBy: 'composer'
  },
  {
    id: 'dismiss',
    description: 'Close a menu, or skip the reply being read aloud',
    scope: 'composer',
    keys: { code: 'Escape' },
    handledBy: 'composer'
  },
  {
    id: 'zoom-in',
    description: 'Zoom in',
    scope: 'app',
    keys: { mod: true, code: 'Equal' },
    handledBy: 'window'
  },
  {
    id: 'zoom-out',
    description: 'Zoom out',
    scope: 'app',
    keys: { mod: true, code: 'Minus' },
    handledBy: 'window'
  },
  {
    id: 'zoom-reset',
    description: 'Reset zoom',
    scope: 'app',
    keys: { mod: true, code: 'Digit0' },
    handledBy: 'window'
  }
]

const SHORTCUTS_BY_ID = new Map(KEYBOARD_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]))

export function keyboardShortcut(id: ShortcutId): KeyboardShortcut {
  const shortcut = SHORTCUTS_BY_ID.get(id)
  if (!shortcut) throw new Error(`Unknown keyboard shortcut: ${id}`)
  return shortcut
}

export function shortcutChord(id: ShortcutId, platform: DesktopPlatform): KeyChord {
  const { keys } = keyboardShortcut(id)
  if ('code' in keys) return keys
  return platform === 'macos' ? keys.macos : keys.other
}

export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>

/** Exact match: extra modifiers make it a different shortcut. */
export function matchesShortcut(
  event: ShortcutKeyEvent,
  id: ShortcutId,
  platform: DesktopPlatform
): boolean {
  const chord = shortcutChord(id, platform)
  const mac = platform === 'macos'
  return (
    event.code === chord.code &&
    event.metaKey === Boolean(mac && chord.mod) &&
    event.ctrlKey === Boolean((!mac && chord.mod) || chord.ctrl) &&
    event.altKey === Boolean(chord.alt) &&
    event.shiftKey === Boolean(chord.shift)
  )
}

/** The Nth sidebar conversation a key press asks for (1-based), or null. */
export function conversationJumpIndex(
  event: ShortcutKeyEvent,
  platform: DesktopPlatform
): number | null {
  for (let index = 1; index <= CONVERSATION_JUMP_COUNT; index += 1) {
    if (matchesShortcut(event, `jump-to-conversation-${index}` as ConversationJumpId, platform)) {
      return index
    }
  }
  return null
}

const KEY_LABELS: Record<string, string> = {
  Comma: ',',
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Esc'
}

function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  return code
}

/**
 * The Electron menu accelerator. Without a platform, `mod` is written as
 * CmdOrCtrl so one menu template serves every platform.
 */
export function shortcutAccelerator(id: ShortcutId, platform?: DesktopPlatform): string {
  const chord = shortcutChord(id, platform ?? 'windows')
  const mod = platform === undefined ? 'CmdOrCtrl' : platform === 'macos' ? 'Command' : 'Ctrl'
  return [
    chord.mod ? mod : '',
    chord.ctrl ? 'Ctrl' : '',
    chord.alt ? 'Alt' : '',
    chord.shift ? 'Shift' : '',
    keyLabel(chord.code)
  ]
    .filter(Boolean)
    .join('+')
}

/** How the shortcut is written on this platform: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcutLabel(id: ShortcutId, platform: DesktopPlatform): string {
  const chord = shortcutChord(id, platform)
  const key = keyLabel(chord.code)
  if (platform === 'macos') {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${
      chord.mod ? '⌘' : ''
    }${key}`
  }
  return [
    chord.mod || chord.ctrl ? 'Ctrl' : '',
    chord.alt ? 'Alt' : '',
    chord.shift ? 'Shift' : '',
    key
  ]
    .filter(Boolean)
    .join('+')
}
