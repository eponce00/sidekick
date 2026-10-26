import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { chatFolderPath, configureChatFoldersRoot, copyUploadIntoChatFolder } from './chatFolders'

describe('copyUploadIntoChatFolder', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sidekick-chat-folders-'))
  afterEach(() => rmSync(temp, { recursive: true, force: true }))

  it('never replaces an earlier upload of the same name, and only copies into a chat folder', async () => {
    configureChatFoldersRoot(join(temp, 'chat-folders'))
    const folder = chatFolderPath('chat-1')!
    const source = join(temp, 'notes.txt')
    writeFileSync(source, 'first')
    await copyUploadIntoChatFolder(folder, source)
    writeFileSync(source, 'second')

    const again = await copyUploadIntoChatFolder(folder, source)

    expect(again.relativePath).toBe('uploads/notes (2).txt')
    expect(readFileSync(join(folder, 'uploads', 'notes.txt'), 'utf8')).toBe('first')
    await expect(copyUploadIntoChatFolder(temp, source)).rejects.toThrow('Not a chat folder')
  })
})
