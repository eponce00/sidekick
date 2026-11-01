import { describe, expect, it } from 'vitest'
import { trashRefusal } from './workspaceTrash'

describe('workspace trash', () => {
  it('refuses the project folder and Git’s own folders', () => {
    for (const path of ['', '.', '.git', '.git/objects', 'packages/app/.git', 'a\\.git\\hooks']) {
      expect(trashRefusal(path), path).not.toBeNull()
    }
    for (const path of ['src', 'src/app.ts', '.github', '.gitignore', 'docs/.git-notes']) {
      expect(trashRefusal(path), path).toBeNull()
    }
  })
})
