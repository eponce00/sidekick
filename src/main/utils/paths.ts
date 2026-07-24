import { relative, resolve } from 'path'

export function isPathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  const rel = relative(rootResolved, candidateResolved)
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'))
}

export function assertPathInside(root: string, candidate: string): void {
  if (!isPathInside(root, candidate)) {
    throw new Error('Access denied: path is outside the workspace')
  }
}
