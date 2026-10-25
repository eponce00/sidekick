import { describe, expect, it, vi } from 'vitest'

const getFileIcon = vi.fn()
const createFromPath = vi.fn()
vi.mock('electron', () => ({ app: { getFileIcon }, nativeImage: { createFromPath } }))

const { browserIcon } = await import('./browserIcons')

describe('browser icons', () => {
  it('never looks at a file the renderer names', async () => {
    for (const browser of ['C:\\Windows\\System32\\calc.exe', '../chrome', 'constructor', 7, null])
      expect(await browserIcon(browser)).toBeNull()
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(createFromPath).not.toHaveBeenCalled()
  })
})
