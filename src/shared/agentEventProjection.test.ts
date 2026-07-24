import { describe, expect, it } from 'vitest'
import type { AgentRunEvent } from './agentRuntime'
import { projectAgentRunEvents } from './agentEventProjection'

function event(
  sequence: number,
  type: AgentRunEvent['type'],
  payload: Record<string, unknown>
): AgentRunEvent {
  return { id: `event-${sequence}`, runId: 'run-1', sequence, type, payload, timestamp: sequence }
}

describe('projectAgentRunEvents', () => {
  it('projects streamed turns once and preserves tool ordering', () => {
    const projection = projectAgentRunEvents([
      event(1, 'run.started', {}),
      event(2, 'assistant.delta', { content: 'Checking ' }),
      event(3, 'assistant.delta', { content: 'now.' }),
      event(4, 'tool.pending', { toolCallId: 'tool-1', name: 'read_workspace_file' }),
      event(5, 'assistant.completed', {
        content: 'Checking now.',
        thinking: 'Need the file.',
        toolCalls: [{ id: 'tool-1', name: 'read_workspace_file' }]
      }),
      event(6, 'tool.running', {
        toolCallId: 'tool-1',
        name: 'read_workspace_file',
        title: 'Read README.md'
      }),
      event(7, 'tool.completed', {
        toolCallId: 'tool-1',
        result: {
          status: 'success',
          title: 'Read README.md',
          modelContent: '1: hello',
          timing: { startedAt: 1, completedAt: 2 }
        }
      }),
      event(8, 'assistant.completed', { content: 'Done.', thinking: '', toolCalls: [] }),
      event(9, 'usage.updated', {
        promptTokens: 20,
        completionTokens: 5,
        tokensPerSecond: 42.5
      }),
      event(10, 'run.completed', { phase: 'completed' }),
      event(11, 'run.finalized', { persisted: true })
    ])

    expect(projection.content).toBe('Checking now.Done.')
    expect(projection.thinking).toBe('Need the file.')
    expect(projection.tokenUsage).toEqual({
      promptTokens: 20,
      completionTokens: 5,
      tokensPerSecond: 42.5,
      runStartedAt: 1,
      runCompletedAt: 10
    })
    expect(projection.segments.map(({ type }) => type)).toEqual([
      'thinking',
      'text',
      'tool',
      'text'
    ])
    expect(projection.segments.find(({ type }) => type === 'tool')).toMatchObject({
      tool: { id: 'tool-1', status: 'success', output: '1: hello' }
    })
  })

  it('combines multi-turn generation speed by generated-token duration', () => {
    const projection = projectAgentRunEvents([
      event(1, 'usage.updated', {
        promptTokens: 100,
        completionTokens: 20,
        tokensPerSecond: 10
      }),
      event(2, 'usage.updated', {
        promptTokens: 150,
        completionTokens: 30,
        tokensPerSecond: 30
      })
    ])

    expect(projection.tokenUsage).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      tokensPerSecond: 50 / 3
    })
  })

  it('turns unfinished tools into visible interrupted failures', () => {
    const projection = projectAgentRunEvents([
      event(1, 'tool.pending', { toolCallId: 'tool-1', name: 'execute_command' }),
      event(2, 'tool.running', {
        toolCallId: 'tool-1',
        name: 'execute_command',
        title: 'Build project'
      }),
      event(3, 'assistant.completed', {
        content: '',
        toolCalls: [{ id: 'tool-1', name: 'execute_command' }]
      }),
      event(4, 'run.completed', { phase: 'interrupted' })
    ])

    expect(projection.phase).toBe('interrupted')
    expect(projection.segments.find(({ type }) => type === 'tool')).toMatchObject({
      tool: { status: 'error', error: 'Run interrupted' }
    })
  })

  it('keeps permission interactions durable through resolution', () => {
    const projection = projectAgentRunEvents([
      event(1, 'permission.requested', {
        interactionId: 'permission-1',
        request: { toolCallId: 'tool-1', title: 'Delete generated output' }
      }),
      event(2, 'permission.resolved', {
        interactionId: 'permission-1',
        status: 'resolved',
        response: { approved: false }
      })
    ])

    expect(projection.segments).toContainEqual({
      type: 'interaction',
      interaction: {
        id: 'permission-1',
        kind: 'permission',
        status: 'resolved',
        request: { toolCallId: 'tool-1', title: 'Delete generated output' },
        response: { approved: false }
      }
    })
  })

  it('renders Plan control as a review interaction instead of a duplicate tool row', () => {
    const projection = projectAgentRunEvents([
      event(1, 'tool.pending', { toolCallId: 'plan-1', name: 'present_plan' }),
      event(2, 'assistant.completed', {
        content: '',
        toolCalls: [{ id: 'plan-1', name: 'present_plan' }]
      }),
      event(3, 'question.requested', {
        interactionId: 'review-1',
        kind: 'plan_approval',
        request: { stage: 'review', revision: 'revision-1' }
      }),
      event(4, 'tool.completed', {
        toolCallId: 'plan-1',
        name: 'present_plan',
        result: {
          status: 'success',
          title: 'Review plan',
          modelContent: 'approved',
          timing: { startedAt: 1, completedAt: 2 }
        }
      })
    ])

    expect(projection.segments.some(({ type }) => type === 'tool')).toBe(false)
    expect(projection.segments).toContainEqual(
      expect.objectContaining({
        type: 'interaction',
        interaction: expect.objectContaining({ id: 'review-1', kind: 'plan_approval' })
      })
    )
  })
})
