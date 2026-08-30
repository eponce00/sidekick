import { describe, expect, it } from 'vitest'
import {
  browserPermissionOperation,
  checkpointPermissionOperation,
  commandPermissionOperation,
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

  it('applies the same policy to every operation kind', () => {
    expect(resolvePermissionPolicy('always-ask', 'auto').effectiveAccess).toBe('confirm')
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
    expect(checkpointPermissionOperation('restore', 'abcdef123456')).not.toEqual(
      checkpointPermissionOperation('hard-reset', 'abcdef123456')
    )
    expect(checkpointPermissionOperation('restore', 'abcdef123456').requestedAccess).toBe('confirm')
    expect(checkpointPermissionOperation('restore', 'abcdef123456').kind).toBe('checkpoint')
    expect(workspacePermissionOperation('write', 'a.txt', 'one', 'confirm').kind).toBe('workspace')
    expect(browserPermissionOperation('navigate', 'https://example.com', 'confirm')).toMatchObject({
      kind: 'browser',
      details: { action: 'navigate', target: 'https://example.com' }
    })
  })
})
