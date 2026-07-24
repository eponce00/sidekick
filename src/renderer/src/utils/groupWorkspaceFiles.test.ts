import { describe, expect, it } from 'vitest'
import {
  buildGroupFileTree,
  filterGroupWorkspaceFiles,
  normalizeGroupWorkspacePath
} from './groupWorkspaceFiles'

describe('GroupWorkspacePanel file projection', () => {
  it('normalizes Windows paths and groups folders before files', () => {
    const tree = buildGroupFileTree([
      'src\\main.ts',
      'README.md',
      'src\\',
      'docs\\',
      'docs\\plan.md'
    ])

    expect(normalizeGroupWorkspacePath('src\\main.ts')).toBe('src/main.ts')
    expect(tree.childrenByFolder.get('')).toEqual(['docs/', 'src/', 'README.md'])
    expect(tree.childrenByFolder.get('src/')).toEqual(['src/main.ts'])
  })

  it('filters files in real time without returning directory placeholders', () => {
    expect(
      filterGroupWorkspaceFiles(['src/', 'src/App.tsx', 'src/App.css', 'README.md'], 'app')
    ).toEqual(['src/App.tsx', 'src/App.css'])
    expect(filterGroupWorkspaceFiles(['src/App.tsx'], '  ')).toEqual([])
  })
})
