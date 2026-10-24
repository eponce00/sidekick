import { describe, expect, it } from 'vitest'
import { trashQuestion, trashRefusal } from './workspaceTrash'

describe('workspace trash', () => {
  it('refuses the project folder and Git’s own folders', () => {
    for (const path of ['', '.', '.git', '.git/objects', 'packages/app/.git', 'a\\.git\\hooks']) {
      expect(trashRefusal(path), path).not.toBeNull()
    }
    for (const path of ['src', 'src/app.ts', '.github', '.gitignore', 'docs/.git-notes']) {
      expect(trashRefusal(path), path).toBeNull()
    }
  })

  it('says how much a folder holds before it goes to the bin', () => {
    const folder = (items?: { count: number; more: boolean }) =>
      trashQuestion({ path: 'src', isDirectory: true, ...(items ? { items } : {}) }, 'Recycle Bin')
    expect(folder({ count: 214, more: false })).toBe(
      'Move the folder “src” and the 214 items in it to the Recycle Bin? You can restore it from there.'
    )
    expect(folder({ count: 1, more: false })).toContain('and the 1 item in it')
    expect(folder({ count: 10_000, more: true })).toContain('more than 10,000 items')
    expect(folder({ count: 0, more: false })).toBe(
      'Move the folder “src” to the Recycle Bin? You can restore it from there.'
    )
    expect(folder()).toContain('and everything in it')
    expect(trashQuestion({ path: 'a.txt', isDirectory: false }, 'Trash')).toBe(
      'Move “a.txt” to the Trash? You can restore it from there.'
    )
  })
})
