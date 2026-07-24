export interface GroupFileTree {
  files: string[]
  childrenByFolder: Map<string, string[]>
}

export function normalizeGroupWorkspacePath(path: string): string {
  return path.replaceAll('\\', '/')
}

export function buildGroupFileTree(rawFiles: string[]): GroupFileTree {
  const files = rawFiles.map(normalizeGroupWorkspacePath)
  const childrenByFolder = new Map<string, string[]>()
  childrenByFolder.set('', [])

  for (const entry of files) {
    const directory = entry.endsWith('/')
    const clean = directory ? entry.slice(0, -1) : entry
    const slash = clean.lastIndexOf('/')
    const parent = slash >= 0 ? `${clean.slice(0, slash)}/` : ''
    if (!childrenByFolder.has(parent)) childrenByFolder.set(parent, [])
    childrenByFolder.get(parent)!.push(entry)
    if (directory && !childrenByFolder.has(entry)) childrenByFolder.set(entry, [])
  }

  for (const children of childrenByFolder.values()) {
    children.sort((left, right) => {
      const leftDirectory = left.endsWith('/')
      const rightDirectory = right.endsWith('/')
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1
      return left.localeCompare(right)
    })
  }

  return { files, childrenByFolder }
}

export function filterGroupWorkspaceFiles(files: string[], query: string): string[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []
  return files.filter(
    (file) => !file.endsWith('/') && file.toLocaleLowerCase().includes(normalizedQuery)
  )
}
