import { expect, it, vi } from 'vitest'
import { externalImageApprovalForMode } from './externalImageApproval'
import { normalizePermissionMode } from '../../shared/permissions'

it('honors full access and the legacy bypass value without a second popup', async () => {
  const confirm = vi.fn(async () => false)
  for (const saved of ['full-access', 'bypass', undefined]) {
    const approve = externalImageApprovalForMode(normalizePermissionMode(saved), confirm)
    expect(await approve('/explicit-image.png', new AbortController().signal)).toBe(true)
  }
  expect(confirm).not.toHaveBeenCalled()
})
it.each(['sensitive-only', 'always-ask', undefined] as const)(
  'retains exact-file consent for %s',
  async (mode) => {
    const confirm = vi.fn(async () => false)
    const signal = new AbortController().signal
    expect(await externalImageApprovalForMode(mode, confirm)('/explicit-image.png', signal)).toBe(
      false
    )
    expect(confirm).toHaveBeenCalledWith('/explicit-image.png', signal)
  }
)
it('does not authorize a cancelled read even with bypass', async () => {
  const controller = new AbortController()
  controller.abort()
  expect(await externalImageApprovalForMode('full-access')('/image.png', controller.signal)).toBe(
    false
  )
})
