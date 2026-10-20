import { describe, expect, it } from 'vitest'
import {
  WORKTREE_SLUG_MAX_LENGTH,
  parseWorkspaceBusyMessage,
  workspaceBusyMessage,
  worktreeSlug
} from './worktrees'

describe('worktree names', () => {
  it('names a worktree folder from a chat title, cutting long titles at a word boundary', () => {
    expect(worktreeSlug('Fix the cards!')).toBe('fix-the-cards')
    expect(worktreeSlug('api-tests')).toBe('api-tests')
    expect(worktreeSlug('Add keyboard shortcuts to the sidebar please')).toBe('add-keyboard')
    expect(worktreeSlug('Fix the login page redirect loop')).toBe('fix-the-login-page')
    expect(worktreeSlug('Café crème')).toBe('cafe-creme')
    expect(worktreeSlug('')).toBe('chat')
    expect(worktreeSlug('x'.repeat(50))).toHaveLength(WORKTREE_SLUG_MAX_LENGTH)
  })

  it('never makes a slug that could leave its folder or mean something special', () => {
    for (const label of [
      '../../etc/passwd',
      '..\\..\\Windows',
      'C:\\Windows\\System32',
      '/absolute/path',
      '.git',
      '...',
      'CON',
      'name\u0000with\nbreaks',
      '   ',
      '🚀🚀🚀',
      '名前のないチャット',
      `${'a-'.repeat(40)}end`
    ]) {
      const slug = worktreeSlug(label)
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(slug.length).toBeLessThanOrEqual(WORKTREE_SLUG_MAX_LENGTH)
    }
    expect(worktreeSlug('../../etc/passwd')).toBe('etc-passwd')
    expect(worktreeSlug('🚀🚀🚀')).toBe('chat')
  })

  it('carries busy-folder occupants through an error message', () => {
    const occupants = [{ runId: 'r', conversationId: 'c', title: 'Other', workspaceRoot: '/x' }]
    expect(parseWorkspaceBusyMessage(`Error: ${workspaceBusyMessage(occupants)}`)).toEqual(
      occupants
    )
    expect(parseWorkspaceBusyMessage('Some other failure')).toBeNull()
  })
})
