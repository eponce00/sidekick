import { describe, expect, it } from 'vitest'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'
import {
  AgentToolRecoveryController,
  canonicalToolFingerprint
} from './agentToolRecoveryController'

describe('AgentToolRecoveryController', () => {
  it('canonicalizes argument objects independently of key order', () => {
    expect(canonicalToolFingerprint('edit', { b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalToolFingerprint('EDIT', { a: { c: 3, d: 4 }, b: 2 })
    )
  })

  it('warns and stops identical failures even when they are correctable', () => {
    const controller = new AgentToolRecoveryController()
    const result = toolExecutionFailed({
      title: 'Edit',
      code: 'invalid_arguments',
      message: 'Missing old_string',
      retryable: true,
      recoveryAction: 'correct_input'
    })
    const observations = Array.from({ length: 5 }, () =>
      controller.observeCall({
        name: 'edit',
        arguments: { file_path: 'app.ts' },
        result,
        readOnly: false
      })
    )

    expect(observations[1]).toMatchObject({ reason: 'exact_failure', count: 2 })
    expect(observations[4].stopReason).toContain('5 identical failed calls')
  })

  it('catches same-tool argument churn and resets it after success', () => {
    const controller = new AgentToolRecoveryController()
    const failure = (index: number) =>
      controller.observeCall({
        name: 'edit',
        arguments: { file_path: `file-${index}.ts` },
        result: toolExecutionFailed({
          title: 'Edit',
          code: 'invalid_arguments',
          message: 'Missing content',
          retryable: true
        }),
        readOnly: false
      })

    expect(failure(1)).toEqual({})
    expect(failure(2)).toEqual({})
    expect(failure(3)).toMatchObject({ reason: 'same_tool_failure', count: 3 })
    controller.observeCall({
      name: 'edit',
      arguments: { file_path: 'fixed.ts' },
      result: toolExecutionSucceeded({ title: 'Edit', data: { changed: true } }),
      readOnly: false
    })
    expect(failure(4)).toEqual({})
  })

  it('stops alternating malformed calls that evade an exact-call counter', () => {
    const controller = new AgentToolRecoveryController()
    const observations = Array.from({ length: 8 }, (_, index) =>
      controller.observeCall({
        name: 'edit',
        arguments:
          index % 2 === 0
            ? { file_path: 'app.ts', accessLevel: 'auto' }
            : { file_path: 'app.ts', old_string: 'before', accessLevel: 'auto' },
        result: toolExecutionFailed({
          title: 'Edit',
          code: 'invalid_arguments',
          message: index % 2 === 0 ? 'Missing old_string' : 'Missing new_string',
          retryable: true
        }),
        readOnly: false
      })
    )

    expect(observations[7]).toMatchObject({ reason: 'same_tool_failure', count: 8 })
    expect(observations[7].stopReason).toContain('8')
  })

  it('stops read-only calls that repeatedly return identical output', () => {
    const controller = new AgentToolRecoveryController()
    const result = toolExecutionSucceeded({ title: 'Read', modelContent: 'same output' })
    const observations = Array.from({ length: 5 }, () =>
      controller.observeCall({ name: 'read', arguments: { path: 'a.ts' }, result, readOnly: true })
    )

    expect(observations[1].warning).toContain('same result')
    expect(observations[4].stopReason).toContain('identical read-only calls')
  })

  it('tracks consecutive all-failed turns independently of call signatures', () => {
    const controller = new AgentToolRecoveryController()
    for (let index = 0; index < 4; index++) {
      controller.observeCall({
        name: 'write',
        arguments: { file_path: 'theme.css' },
        result: toolExecutionFailed({
          title: 'Write',
          code: 'invalid_arguments',
          message:
            'write received invalid arguments. Missing required fields: content. Received fields: file_path.'
        }),
        readOnly: false
      })
    }
    for (let index = 0; index < 2; index++) {
      controller.observeCall({
        name: 'edit',
        arguments: { file_path: 'theme.css' },
        result: toolExecutionFailed({
          title: 'Edit',
          code: 'invalid_arguments',
          message:
            'edit received invalid arguments. Missing required fields: old_string, new_string. Received fields: file_path.'
        }),
        readOnly: false
      })
    }
    const observations = Array.from({ length: 6 }, () => controller.observeTurn(0, 2))
    expect(observations[2]).toMatchObject({ reason: 'failed_turn', count: 3 })
    expect(observations[5].stopReason).toContain('6 consecutive tool turns')
    expect(observations[5].stopReason).toContain('write omitted required field: content (4 calls)')
    expect(observations[5].stopReason).toContain(
      'edit omitted required fields: old_string, new_string (2 calls)'
    )
  })
})
