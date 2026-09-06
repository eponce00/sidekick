import { describe, expect, it } from 'vitest'
import { AgentToolLoopError, classifyAgentKernelFailure, withToolGuard } from './agentKernelFailure'
import { toolExecutionFailed, toolExecutionSucceeded } from '../../shared/agentRuntime'

describe('kernel terminal policy', () => {
  it('adds recovery guidance without rewriting tool results or mutating prior evidence', () => {
    const failure = toolExecutionFailed({
      title: 'Patch',
      code: 'stale_read',
      message: 'Changed',
      recovery: 'Read again.',
      retryable: true
    })
    const before = structuredClone(failure)
    const guarded = withToolGuard(failure, 'Change strategy')
    expect(failure).toEqual(before)
    expect(guarded.error).toEqual({
      ...failure.error,
      recovery:
        'Read again. SideKick detected repeated behavior; do not repeat the unchanged approach.'
    })
    expect(guarded.status).toBe(failure.status)
    expect(guarded.data).toBe(failure.data)
    expect(guarded.modelContent).toBe(`${failure.modelContent}\nChange strategy`)
    const success = toolExecutionSucceeded({ title: 'Read', data: { text: 'unchanged' } })
    expect(withToolGuard(success, 'Do not re-read')).toEqual({
      ...success,
      modelContent: `${success.modelContent}\nDo not re-read`
    })
  })
  it('retains internal errors as retryable without inventing a successful final response', () => {
    expect(classifyAgentKernelFailure(new Error('provider failed'), false)).toEqual({
      phase: 'failed',
      message: 'provider failed',
      error: {
        code: 'internal',
        message: 'provider failed',
        retryable: true,
        recoveryAction: 'retry_later'
      }
    })
    expect(classifyAgentKernelFailure('non-Error rejection', false).message).toBe(
      'non-Error rejection'
    )
  })

  it('keeps no-progress failures terminal and preserves their recovery contract', () => {
    expect(
      classifyAgentKernelFailure(new AgentToolLoopError('unchanged approach'), false)
    ).toMatchObject({
      phase: 'failed',
      error: {
        code: 'loop_detected',
        retryable: false,
        recoveryAction: 'stop',
        recovery: expect.stringContaining('Change the approach')
      }
    })
    // A provider cannot opt into the kernel loop policy merely by naming its error.
    const impostor = new Error('provider failed')
    impostor.name = 'AgentToolLoopError'
    expect(classifyAgentKernelFailure(impostor, false).error.code).toBe('internal')
  })

  it('gives cancellation precedence over late tool or provider failures', () => {
    for (const failure of [new Error('late failure'), new AgentToolLoopError('loop')]) {
      expect(classifyAgentKernelFailure(failure, true)).toMatchObject({
        phase: 'cancelled',
        message: 'Agent run cancelled',
        error: { code: 'cancelled', retryable: false, recoveryAction: 'stop' }
      })
    }
    expect(classifyAgentKernelFailure(new DOMException('cancel', 'AbortError'), false).phase).toBe(
      'cancelled'
    )
  })
})
