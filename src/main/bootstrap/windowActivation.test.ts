import { describe, expect, it, vi } from 'vitest'
import { revealWindow } from './windowActivation'

function createWindow({ destroyed = false, minimized = false } = {}) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn()
  }
}

describe('revealWindow', () => {
  it('restores, shows, and focuses a reusable window', () => {
    const window = createWindow({ minimized: true })

    expect(revealWindow(window)).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('requires a new window when no reusable window exists', () => {
    const destroyed = createWindow({ destroyed: true })

    expect(revealWindow(null)).toBe(false)
    expect(revealWindow(destroyed)).toBe(false)
    expect(destroyed.show).not.toHaveBeenCalled()
  })
})
