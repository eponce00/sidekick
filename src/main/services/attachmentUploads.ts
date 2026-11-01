import { constants } from 'fs'
import { copyFile, mkdir, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { chatIdForFolder, ensureChatFolder } from './chatFolders'
import { resolveSecureWorkspacePath } from '../utils/workspacePaths'
import { MAX_ATTACHED_FILE_BYTES } from '../../shared/messageContextAttachments'

export interface SavedUpload {
  relativePath: string
  name: string
  size: number
}

/** A dropped file's name as a file name on every platform, never a path. */
export function uploadName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .replace(/[\p{C}<>:"/\\|?*]/gu, '')
    .replace(/[. ]+$/, '')
    .slice(0, 200)
  // CON, NUL, COM1 and the like name devices on Windows, whatever their extension.
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned))
    return `File ${cleaned}`.trim()
  return cleaned
}

/**
 * Where a workspace keeps copies of attached files: a chat without a project in its own folder's
 * `uploads`, a project in `.sidekick/uploads`, which tells git to ignore it so the copies are never
 * committed or kept in History.
 */
async function uploadsFolder(workspaceRoot: string): Promise<{ folder: string; prefix: string }> {
  const chatFolder = Boolean(chatIdForFolder(workspaceRoot))
  const prefix = chatFolder ? 'uploads' : '.sidekick/uploads'
  // A chat's own folder is made when something first works in it.
  if (chatFolder) ensureChatFolder(workspaceRoot)
  // Never through a link, which could put the copy anywhere.
  const folder = await resolveSecureWorkspacePath(workspaceRoot, prefix, { rejectLinks: true })
  await mkdir(folder, { recursive: true })
  await resolveSecureWorkspacePath(workspaceRoot, prefix, { rejectLinks: true })
  if (!chatFolder) {
    await writeFile(join(folder, '.gitignore'), '*\n', { flag: 'wx' }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
  }
  return { folder, prefix }
}

/**
 * Saves a copy of a file the user attached, under its own name or a numbered one when that is
 * taken, and returns its path in the workspace. The agent reads the copy with its file tools, as it
 * reads project files; the original is never opened for writing. A dropped file comes as its
 * bytes, so the window never names a file for SideKick to read.
 */
export async function saveUpload(
  workspaceRoot: string,
  source: { path: string } | { name: string; bytes: Uint8Array }
): Promise<SavedUpload> {
  const name = 'path' in source ? basename(source.path) : uploadName(source.name)
  let size: number
  if ('path' in source) {
    const file = await stat(source.path)
    if (!file.isFile()) throw new Error('Choose files')
    size = file.size
  } else {
    size = source.bytes.byteLength
  }
  if (size > MAX_ATTACHED_FILE_BYTES) throw new Error(`${name} is over 100 MB`)
  const { folder, prefix } = await uploadsFolder(workspaceRoot)
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let copy = 1; copy < 1_000; copy += 1) {
    const candidate = copy === 1 ? name : `${stem} (${copy})${extension}`
    const target = join(folder, candidate)
    try {
      // Never over an earlier upload: the chat may refer to it.
      if ('path' in source) await copyFile(source.path, target, constants.COPYFILE_EXCL)
      else await writeFile(target, source.bytes, { flag: 'wx' })
      return { relativePath: `${prefix}/${candidate}`, name: candidate, size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Too many files named ${name} attached here`)
}
