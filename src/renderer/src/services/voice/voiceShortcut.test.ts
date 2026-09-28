import { afterEach, describe, expect, it, vi } from 'vitest'
import { isVoiceShortcut, voiceShortcutLabel } from './voiceShortcut'

const key = (modifiers: Partial<KeyboardEvent>) => ({
  code: 'Space',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  ...modifiers
})

describe('voice shortcut', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is Ctrl+Space on Windows and Linux, never Alt+Space', () => {
    vi.stubGlobal('window', { api: { app: { platform: 'windows' } } })
    expect(isVoiceShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isVoiceShortcut(key({ altKey: true }))).toBe(false)
    expect(isVoiceShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isVoiceShortcut(key({ ctrlKey: true, repeat: true }))).toBe(false)
    expect(voiceShortcutLabel()).toBe('Ctrl+Space')
  })

  it('is Option+Space on macOS, where Ctrl+Space switches input sources', () => {
    vi.stubGlobal('window', { api: { app: { platform: 'macos' } } })
    expect(isVoiceShortcut(key({ altKey: true }))).toBe(true)
    expect(isVoiceShortcut(key({ ctrlKey: true }))).toBe(false)
    expect(voiceShortcutLabel()).toBe('⌥Space')
  })
})
