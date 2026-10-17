import { describe, expect, it } from 'vitest'
import { parseWorkspaceBusyMessage, workspaceBusyMessage, worktreeSlug } from './worktrees'

describe('worktree names', () => {
  it('names a worktree folder from a chat title, cutting long titles at a word boundary', () => {
    expect(worktreeSlug('Fix the cards!')).toBe('fix-the-cards')
    expect(worktreeSlug('Add keyboard shortcuts to the sidebar please')).toBe(
      'add-keyboard-shortcuts-to-the'
    )
    expect(worktreeSlug('')).toBe('chat')
    expect(worktreeSlug('x'.repeat(50))).toHaveLength(32)
  })

  it('carries busy-folder occupants through an error message', () => {
    const occupants = [{ runId: 'r', conversationId: 'c', title: 'Other', workspaceRoot: '/x' }]
    expect(parseWorkspaceBusyMessage(`Error: ${workspaceBusyMessage(occupants)}`)).toEqual(
      occupants
    )
    expect(parseWorkspaceBusyMessage('Some other failure')).toBeNull()
  })
})
