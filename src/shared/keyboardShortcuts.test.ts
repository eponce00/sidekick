import { describe, expect, it } from 'vitest'
import {
  conversationJumpIndex,
  KEYBOARD_SHORTCUTS,
  matchesShortcut,
  shortcutAccelerator,
  shortcutLabel
} from './keyboardShortcuts'

const key = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers
})

describe('keyboard shortcut table', () => {
  it('has one entry per id, each with a description', () => {
    const ids = KEYBOARD_SHORTCUTS.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(KEYBOARD_SHORTCUTS.every(({ description }) => description.length > 0)).toBe(true)
  })

  it('gives no two shortcuts in one scope the same keys', () => {
    for (const platform of ['macos', 'windows'] as const) {
      const seen = new Set<string>()
      for (const shortcut of KEYBOARD_SHORTCUTS) {
        const combo = `${shortcut.scope}:${shortcutLabel(shortcut.id, platform)}`
        expect(seen.has(combo), combo).toBe(false)
        seen.add(combo)
      }
    }
  })

  it('opens the palette with Cmd+K on macOS and Ctrl+K elsewhere', () => {
    expect(matchesShortcut(key('KeyK', { metaKey: true }), 'command-palette', 'macos')).toBe(true)
    expect(matchesShortcut(key('KeyK', { ctrlKey: true }), 'command-palette', 'macos')).toBe(false)
    expect(matchesShortcut(key('KeyK', { ctrlKey: true }), 'command-palette', 'windows')).toBe(true)
    expect(
      matchesShortcut(key('KeyK', { ctrlKey: true, shiftKey: true }), 'command-palette', 'linux')
    ).toBe(false)
  })

  it('reads Ctrl+1…9 as a jump to that sidebar conversation', () => {
    expect(conversationJumpIndex(key('Digit3', { ctrlKey: true }), 'windows')).toBe(3)
    expect(conversationJumpIndex(key('Digit9', { metaKey: true }), 'macos')).toBe(9)
    // Ctrl+0 resets the zoom and Ctrl+Shift+1 is not a jump.
    expect(conversationJumpIndex(key('Digit0', { ctrlKey: true }), 'windows')).toBeNull()
    expect(
      conversationJumpIndex(key('Digit1', { ctrlKey: true, shiftKey: true }), 'windows')
    ).toBeNull()
  })

  it('moves between conversations with Ctrl+Shift+[ and ]', () => {
    const previous = key('BracketLeft', { ctrlKey: true, shiftKey: true })
    expect(matchesShortcut(previous, 'previous-conversation', 'windows')).toBe(true)
    expect(matchesShortcut(previous, 'next-conversation', 'windows')).toBe(false)
    expect(shortcutLabel('next-conversation', 'windows')).toBe('Ctrl+Shift+]')
    expect(shortcutLabel('next-conversation', 'macos')).toBe('⇧⌘]')
  })

  it('writes labels and menu accelerators for each platform', () => {
    expect(shortcutLabel('command-palette', 'macos')).toBe('⌘K')
    expect(shortcutLabel('command-palette', 'windows')).toBe('Ctrl+K')
    expect(shortcutLabel('toggle-voice', 'windows')).toBe('Ctrl+Space')
    expect(shortcutLabel('toggle-voice', 'macos')).toBe('⌥Space')
    expect(shortcutLabel('paste-plain-text', 'linux')).toBe('Ctrl+Shift+V')
    expect(shortcutLabel('dismiss', 'windows')).toBe('Esc')
    expect(shortcutAccelerator('new-chat')).toBe('CmdOrCtrl+N')
    expect(shortcutAccelerator('open-settings', 'macos')).toBe('Command+,')
    expect(shortcutAccelerator('open-settings', 'windows')).toBe('Ctrl+,')
  })
})
