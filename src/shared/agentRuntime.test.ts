import { describe, expect, it } from 'vitest'
import {
  agentRunUsesPlan,
  hasAgentCapability,
  isToolExecutionResult,
  normalizeToolResultMedia,
  normalizeToolExecutionResult,
  toolExecutionFailed,
  toolExecutionSucceeded,
  type AgentRunProfile
} from './agentRuntime'

describe('agent runtime contracts', () => {
  it('keeps model-facing content separate from structured data', () => {
    const result = toolExecutionSucceeded({
      title: 'Read file',
      data: { content: 'hello' },
      modelContent: '1: hello',
      startedAt: 10,
      completedAt: 20
    })

    expect(result).toMatchObject({
      status: 'success',
      title: 'Read file',
      modelContent: '1: hello',
      data: { content: 'hello' },
      timing: { startedAt: 10, completedAt: 20 }
    })
    expect(isToolExecutionResult(result)).toBe(true)
  })

  it('records bounded typed image output without folding it into model text', () => {
    const media = normalizeToolResultMedia([
      {
        type: 'image',
        mimeType: 'image/png',
        name: ' viewport.png ',
        description: ' Current page ',
        source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' }
      }
    ])
    const result = toolExecutionSucceeded({
      title: 'Observe browser',
      modelContent: 'Captured the current viewport.',
      media
    })

    expect(result.media).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        name: 'viewport.png',
        description: 'Current page',
        source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' }
      }
    ])
    expect(result.modelContent).not.toContain('base64')
    expect(isToolExecutionResult(result)).toBe(true)
  })

  it('rejects malformed or unsupported tool media before persistence', () => {
    expect(() =>
      normalizeToolResultMedia([
        {
          type: 'image',
          mimeType: 'image/png',
          source: { type: 'data_url', dataUrl: 'data:image/png;base64,not-base64' }
        }
      ])
    ).toThrow('base64')
    expect(() =>
      normalizeToolResultMedia([
        {
          type: 'image',
          mimeType: 'image/svg+xml' as 'image/png',
          source: { type: 'file', path: 'C:\\screens\\page.svg' }
        }
      ])
    ).toThrow('Unsupported tool result image type')
  })

  it('normalizes legacy-shaped failures into stable machine errors', () => {
    const result = normalizeToolExecutionResult(
      'Edit file',
      { success: false, error: 'old_string was not found' },
      10,
      20
    )

    expect(result.status).toBe('error')
    expect(result.error).toMatchObject({
      code: 'internal',
      message: 'old_string was not found',
      retryable: false
    })
    expect(result.timing).toEqual({ startedAt: 10, completedAt: 20 })
  })

  it('uses the registry execution envelope for already-typed tool results', () => {
    const inner = toolExecutionSucceeded({
      title: 'Browser action',
      data: { ok: true },
      startedAt: 19,
      completedAt: 19
    })
    const result = normalizeToolExecutionResult('Browser action', inner, 10, 20)

    expect(result.timing).toEqual({ startedAt: 10, completedAt: 20 })
  })

  it('represents denial distinctly from execution errors', () => {
    const result = toolExecutionFailed({
      title: 'Run command',
      code: 'permission_denied',
      message: 'The user denied this command',
      status: 'denied'
    })

    expect(result.status).toBe('denied')
    expect(result.error?.code).toBe('permission_denied')
    expect(result.modelContent).toContain('permission_denied')
  })

  it.each([
    ['invalid_arguments', true, 'correct_input'],
    ['stale_read', true, 'refresh_state'],
    ['conflict', true, 'refresh_state'],
    ['timeout', true, 'retry_later'],
    ['unknown_tool', false, 'change_strategy'],
    ['permission_denied', false, 'stop'],
    ['loop_detected', false, 'stop']
  ] as const)('classifies %s with retryable=%s as %s', (code, retryable, recoveryAction) => {
    expect(
      toolExecutionFailed({ title: 'Tool', code, message: 'failed', retryable }).error
        ?.recoveryAction
    ).toBe(recoveryAction)
  })

  it('filters behavior through explicit run capabilities', () => {
    const profile: AgentRunProfile = {
      surface: 'collaboration',
      executionMode: 'act',
      capabilities: ['workspace.read', 'collaboration']
    }
    expect(hasAgentCapability(profile, 'workspace.read')).toBe(true)
    expect(hasAgentCapability(profile, 'command.execute')).toBe(false)
  })

  it('classifies both manually selected and model-recommended Plan runs', () => {
    const base = { id: 'event', runId: 'run', sequence: 1, timestamp: 1 }
    expect(
      agentRunUsesPlan([{ ...base, type: 'run.started', payload: { executionMode: 'plan' } }])
    ).toBe(true)
    expect(
      agentRunUsesPlan([
        { ...base, type: 'plan.mode_changed', payload: { from: 'act', to: 'plan' } }
      ])
    ).toBe(true)
    expect(
      agentRunUsesPlan([{ ...base, type: 'run.started', payload: { executionMode: 'act' } }])
    ).toBe(false)
  })
})
