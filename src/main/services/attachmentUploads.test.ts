import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatFolderPath, configureChatFoldersRoot } from './chatFolders'
import { saveUpload } from './attachmentUploads'

describe('saveUpload', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sidekick-uploads-'))
  afterEach(() => rmSync(temp, { recursive: true, force: true }))

  it('never replaces an earlier upload of the same name', async () => {
    configureChatFoldersRoot(join(temp, 'chat-folders'))
    const folder = chatFolderPath('chat-1')!
    const source = join(temp, 'notes.txt')
    writeFileSync(source, 'first')
    await saveUpload(folder, { path: source })
    writeFileSync(source, 'second')

    const again = await saveUpload(folder, { path: source })

    expect(again.relativePath).toBe('uploads/notes (2).txt')
    expect(readFileSync(join(folder, 'uploads', 'notes.txt'), 'utf8')).toBe('first')
  })

  it('keeps a dropped file in a git-ignored project folder under a name that is not a path', async () => {
    const project = join(temp, 'project')
    mkdirSync(project, { recursive: true })

    const saved = await saveUpload(project, {
      name: '..\\..\\escape.txt',
      bytes: new TextEncoder().encode('dropped')
    })

    expect(saved.relativePath).toBe('.sidekick/uploads/escape.txt')
    expect(readFileSync(join(project, '.sidekick', 'uploads', 'escape.txt'), 'utf8')).toBe(
      'dropped'
    )
    expect(readFileSync(join(project, '.sidekick', 'uploads', '.gitignore'), 'utf8')).toBe('*\n')
  })
})
