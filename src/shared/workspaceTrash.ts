/**
 * Why a project path cannot go to the Recycle Bin from the Files panel, or null when it can. The
 * project folder itself and Git's own folders would break the project.
 */
export function trashRefusal(relativePath: string): string | null {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (!segments.length || segments.every((segment) => segment === '.')) {
    return 'The project folder itself cannot be moved to the Recycle Bin from SideKick.'
  }
  if (segments.includes('.git')) return 'Git’s own folder cannot be moved to the Recycle Bin.'
  return null
}

/** The question before a file or folder goes to the bin; a folder's says how much it holds. */
export function trashQuestion(
  target: { path: string; isDirectory: boolean; items?: { count: number; more: boolean } },
  binName: string
): string {
  const restore = `to the ${binName}? You can restore it from there.`
  if (!target.isDirectory) return `Move “${target.path}” ${restore}`
  const { items } = target
  const holds = !items
    ? ' and everything in it'
    : items.count === 0
      ? ''
      : ` and the ${items.more ? 'more than ' : ''}${items.count.toLocaleString()} ${
          items.count === 1 && !items.more ? 'item' : 'items'
        } in it`
  return `Move the folder “${target.path}”${holds} ${restore}`
}
