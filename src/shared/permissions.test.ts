import { describe, expect, it } from 'vitest'
import {
  effectivePermissionMode,
  permissionModeWithin,
  browserPermissionOperation,
  commandPermissionOperation,
  historyRestorePermissionOperation,
  normalizePermissionMode,
  resolvePermissionPolicy,
  workspacePermissionOperation
} from './permissions'

describe('command permission policy', () => {
  it('uses full access as the default and migrates historical values', () => {
    expect(normalizePermissionMode(undefined)).toBe('full-access')
    expect(normalizePermissionMode('unexpected')).toBe('full-access')
    expect(normalizePermissionMode('bypass')).toBe('full-access')
    expect(normalizePermissionMode('agent-decides')).toBe('sensitive-only')
  })

  it('always asks in strict mode', () => {
    expect(resolvePermissionPolicy('always-ask', 'auto').effectiveAccess).toBe('confirm')
    expect(resolvePermissionPolicy('always-ask', 'confirm').effectiveAccess).toBe('confirm')
  })

  it('preserves host-classified access in sensitive-only mode', () => {
    expect(resolvePermissionPolicy('sensitive-only', 'auto').effectiveAccess).toBe('auto')
    expect(resolvePermissionPolicy('sensitive-only', 'confirm').effectiveAccess).toBe('confirm')
  })

  it('never asks in full access mode', () => {
    expect(resolvePermissionPolicy('full-access', 'auto').effectiveAccess).toBe('auto')
    expect(resolvePermissionPolicy('full-access', 'confirm').effectiveAccess).toBe('auto')
  })

  it('binds authorization requests to exact operation details', () => {
    expect(
      commandPermissionOperation({
        id: 'run-1',
        title: 'List files',
        command: 'Get-ChildItem',
        timeoutSecs: 30,
        background: false,
        requestedAccess: 'auto'
      }).details
    ).toMatchObject({ id: 'run-1', command: 'Get-ChildItem', background: false })

    expect(workspacePermissionOperation('write', 'a.txt', 'one', 'confirm')).not.toEqual(
      workspacePermissionOperation('write', 'a.txt', 'two', 'confirm')
    )
    const rewind = historyRestorePermissionOperation([
      { workspaceRoot: 'C:/project', hashes: ['abcdef123456'] }
    ])
    expect(rewind).not.toEqual(
      historyRestorePermissionOperation([
        { workspaceRoot: 'C:/project', hashes: ['abcdef123456', 'fedcba654321'] }
      ])
    )
    // An approval for one folder's point does not cover another folder's.
    expect(rewind).not.toEqual(
      historyRestorePermissionOperation([{ workspaceRoot: 'C:/other', hashes: ['abcdef123456'] }])
    )
    expect(rewind.requestedAccess).toBe('confirm')
    expect(rewind.kind).toBe('checkpoint')
    expect(workspacePermissionOperation('write', 'a.txt', 'one', 'confirm').kind).toBe('workspace')
    expect(browserPermissionOperation('navigate', 'https://example.com', 'confirm')).toMatchObject({
      kind: 'browser',
      details: { action: 'navigate', target: 'https://example.com' }
    })
  })
})

describe('effectivePermissionMode', () => {
  it('lets a stored ceiling narrow the setting but never widen it', () => {
    expect(effectivePermissionMode('full-access', 'always-ask')).toBe('always-ask')
    expect(effectivePermissionMode('full-access', 'sensitive-only')).toBe('sensitive-only')
    expect(effectivePermissionMode('sensitive-only', 'full-access')).toBe('sensitive-only')
    expect(effectivePermissionMode('always-ask', 'sensitive-only')).toBe('always-ask')
    expect(effectivePermissionMode('sensitive-only', null)).toBe('sensitive-only')
    expect(effectivePermissionMode('sensitive-only', 'bypass')).toBe('sensitive-only')
  })

  it('orders modes by what they ask for', () => {
    expect(permissionModeWithin('always-ask', 'sensitive-only')).toBe(true)
    expect(permissionModeWithin('sensitive-only', 'sensitive-only')).toBe(true)
    expect(permissionModeWithin('full-access', 'sensitive-only')).toBe(false)
  })
})
