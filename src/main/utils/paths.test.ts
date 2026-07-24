import { describe, expect, it } from 'vitest'
import { assertPathInside, isPathInside } from './paths'

describe('workspace path containment', () => {
  it('accepts the root and descendants', () => {
    expect(isPathInside('C:/work/project', 'C:/work/project')).toBe(true)
    expect(isPathInside('C:/work/project', 'C:/work/project/src/index.ts')).toBe(true)
  })

  it('rejects siblings and traversal', () => {
    expect(isPathInside('C:/work/project', 'C:/work/project-other/file.txt')).toBe(false)
    expect(() => assertPathInside('C:/work/project', 'C:/work/project/../secret.txt')).toThrow(
      'outside the workspace'
    )
  })
})
