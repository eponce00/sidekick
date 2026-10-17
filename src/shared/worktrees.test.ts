import { describe, expect, it } from 'vitest'
import {
  parseWorkspaceBusyMessage,
  workspaceBusyMessage,
  worktreeBranchProblem,
  worktreeSlug
} from './worktrees'

describe('worktree names', () => {
  it('names a worktree folder from a chat title, cutting long titles at a word boundary', () => {
    expect(worktreeSlug('Fix the cards!')).toBe('fix-the-cards')
    expect(worktreeSlug('Add keyboard shortcuts to the sidebar please')).toBe(
      'add-keyboard-shortcuts-to-the'
    )
    expect(worktreeSlug('')).toBe('chat')
    expect(worktreeSlug('x'.repeat(50))).toHaveLength(32)
  })

  it('rejects names Git would refuse or misread', () => {
    expect(worktreeBranchProblem('sidekick/ok-name')).toBeNull()
    for (const name of ['', '-x', 'a..b', 'a/', 'a.lock', 'a b', 'a/.hidden', 'a//b'])
      expect(worktreeBranchProblem(name)).not.toBeNull()
  })

  it('carries busy-folder occupants through an error message', () => {
    const occupants = [{ runId: 'r', conversationId: 'c', title: 'Other', workspaceRoot: '/x' }]
    expect(parseWorkspaceBusyMessage(`Error: ${workspaceBusyMessage(occupants)}`)).toEqual(
      occupants
    )
    expect(parseWorkspaceBusyMessage('Some other failure')).toBeNull()
  })
})
