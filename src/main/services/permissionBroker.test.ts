import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { commandPermissionOperation } from '../../shared/permissions'

const mocks = vi.hoisted(() => ({
  mode: 'agent-decides',
  audit: [] as unknown[],
  showMessageBox: vi.fn(async (_options: { detail?: string }) => ({ response: 1 }))
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: mocks.showMessageBox }
}))

vi.mock('../ipc/state', () => ({
  getStore: () => ({
    get: (key: string, defaultValue?: unknown) => {
      if (key === 'settings') return { commandPermissionMode: mocks.mode }
      if (key === 'permissionAudit') return mocks.audit
      return defaultValue
    },
    set: (key: string, value: unknown) => {
      if (key === 'permissionAudit') mocks.audit = value as unknown[]
    }
  })
}))

import { PermissionBroker } from './permissionBroker'

const operation = commandPermissionOperation({
  id: 'test-command',
  title: 'List files',
  command: 'Get-ChildItem',
  timeoutSecs: 30,
  background: false,
  requestedAccess: 'auto'
})

describe('PermissionBroker', () => {
  beforeEach(() => {
    mocks.mode = 'agent-decides'
    mocks.audit = []
    mocks.showMessageBox.mockClear()
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
  })

  it('issues a single-use token for automatic operations', async () => {
    const broker = new PermissionBroker()
    const result = await broker.authorize(operation, {} as WebContents)
    expect(result.approved).toBe(true)
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(() => broker.consume(result.token, operation)).not.toThrow()
    expect(() => broker.consume(result.token, operation)).toThrow('expired or was already used')
    expect(broker.listAudit().map((record) => record.outcome)).toEqual([
      'auto-approved',
      'consumed',
      'rejected'
    ])
  })

  it('uses trusted confirmation in always-ask mode', async () => {
    mocks.mode = 'always-ask'
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    const result = await new PermissionBroker().authorize(operation, {} as WebContents)
    expect(result.approved).toBe(false)
    expect(mocks.showMessageBox).toHaveBeenCalledOnce()
    const detail = mocks.showMessageBox.mock.calls[0]?.[0].detail || ''
    expect(detail).not.toContain('test-command')
    expect(detail).toContain('command: Get-ChildItem')
    expect(result.auditId).toBeTruthy()
    expect(mocks.audit).toMatchObject([{ outcome: 'denied', mode: 'always-ask' }])
  })

  it('rejects a token replayed against a modified operation', async () => {
    const broker = new PermissionBroker()
    const result = await broker.authorize(operation, {} as WebContents)
    const modified = commandPermissionOperation({
      ...operation.details,
      id: 'test-command',
      title: 'List files',
      command: 'Remove-Item secret.txt',
      timeoutSecs: 30,
      background: false,
      requestedAccess: 'auto'
    })
    expect(() => broker.consume(result.token, modified)).toThrow('does not match')
    expect(broker.listAudit().at(-1)).toMatchObject({
      event: 'consumption',
      outcome: 'rejected',
      reason: 'Authorization does not match this operation'
    })
  })
})
