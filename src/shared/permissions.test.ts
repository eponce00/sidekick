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
  it('keeps agent-decides as the compatibility default', () => {
    expect(normalizePermissionMode(undefined)).toBe('agent-decides')
    expect(normalizePermissionMode('unexpected')).toBe('agent-decides')
  })

  it('always asks in strict mode', () => {
    expect(resolvePermissionPolicy('always-ask', 'auto').effectiveAccess).toBe('confirm')
    expect(resolvePermissionPolicy('always-ask', 'confirm').effectiveAccess).toBe('confirm')
  })

  it('preserves the agent requested access in agent-decides mode', () => {
    expect(resolvePermissionPolicy('agent-decides', 'auto').effectiveAccess).toBe('auto')
    expect(resolvePermissionPolicy('agent-decides', 'confirm').effectiveAccess).toBe('confirm')
  })

  it('never asks in bypass mode', () => {
    expect(resolvePermissionPolicy('bypass', 'auto').effectiveAccess).toBe('auto')
    expect(resolvePermissionPolicy('bypass', 'confirm').effectiveAccess).toBe('auto')
  })

  it('applies the same policy to every operation kind', () => {
    expect(resolvePermissionPolicy('always-ask', 'auto').effectiveAccess).toBe('confirm')
    expect(resolvePermissionPolicy('bypass', 'confirm').effectiveAccess).toBe('auto')
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
