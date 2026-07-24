import { describe, expect, it } from 'vitest'
import { isAppCommand } from './appCommands'

describe('isAppCommand', () => {
  it('accepts only the bounded native-menu command vocabulary', () => {
    expect(isAppCommand('open-settings')).toBe(true)
    expect(isAppCommand('new-chat')).toBe(true)
    expect(isAppCommand('open-project')).toBe(true)
    expect(isAppCommand('run-shell')).toBe(false)
    expect(isAppCommand({ command: 'open-settings' })).toBe(false)
  })
})
