import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

import { QuitGuard, quitConfirmationMessage } from './quitConfirmation'

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('quitConfirmationMessage', () => {
  it('names how many conversations are working', () => {
    expect(quitConfirmationMessage(1)).toBe('1 conversation is still working. Quit anyway?')
    expect(quitConfirmationMessage(3)).toBe('3 conversations are still working. Quit anyway?')
  })
})

describe('QuitGuard', () => {
  it('lets the quit through without asking when nothing is running', () => {
    const confirm = vi.fn()
    const guard = new QuitGuard({ activeConversationCount: () => 0, confirm })
    expect(guard.intercept(vi.fn())).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('holds the quit and retries it once the user chooses Quit', async () => {
    const answer = deferred()
    const confirm = vi.fn(() => answer.promise)
    const proceed = vi.fn()
    const guard = new QuitGuard({ activeConversationCount: () => 2, confirm })

    expect(guard.intercept(proceed)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(2)
    // A second quit while the dialog is open waits on the same answer.
    expect(guard.intercept(proceed)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)

    answer.resolve(true)
    await settle()
    expect(proceed).toHaveBeenCalledTimes(1)
    // The retried quit is not asked about again.
    expect(guard.intercept(proceed)).toBe(false)
  })

  it('keeps the app open when the user cancels, and asks again next time', async () => {
    const confirm = vi.fn(async () => false)
    const proceed = vi.fn()
    const guard = new QuitGuard({ activeConversationCount: () => 1, confirm })

    expect(guard.intercept(proceed)).toBe(true)
    await settle()
    expect(proceed).not.toHaveBeenCalled()
    expect(guard.intercept(proceed)).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('never asks once a quit is allowed, as for an update restart or a system shutdown', () => {
    const confirm = vi.fn()
    const guard = new QuitGuard({ activeConversationCount: () => 4, confirm })
    guard.allow()
    expect(guard.intercept(vi.fn())).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('treats a dialog failure as Cancel', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const proceed = vi.fn()
    const guard = new QuitGuard({
      activeConversationCount: () => 1,
      confirm: async () => {
        throw new Error('no dialog')
      }
    })
    expect(guard.intercept(proceed)).toBe(true)
    await settle()
    expect(proceed).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
