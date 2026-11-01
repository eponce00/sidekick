import { describe, expect, it } from 'vitest'
import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type { AgentRunEvent, AgentRunSnapshot } from '../../../shared/agentRuntime'
import { liveRunMessage, pendingSendMessage, toDesktopMessage } from './messageAdapter'

describe('toDesktopMessage', () => {
  it('names replies as the desktop does and keeps their parts', () => {
    const message = toDesktopMessage({
      id: 'm',
      role: 'assistant',
      content: 'Done',
      timestamp: 5,
      runId: 'run-1',
      runMode: 'research',
      segments: [{ type: 'text', content: 'Done' }, null, 'stray', { content: 'no kind' }]
    })
    expect(message).toEqual({
      id: 'm',
      role: 'agent',
      content: 'Done',
      timestamp: 5,
      runId: 'run-1',
      runMode: 'research',
      segments: [{ type: 'text', content: 'Done' }]
    })
  })

  it('shows notices as notices and attachments as files that stay on the computer', () => {
    expect(
      toDesktopMessage({ id: 's', role: 'system', content: 'Model changed', timestamp: 0 }).role
    ).toBe('system')
    const user = toDesktopMessage({
      id: 'u',
      role: 'user',
      content: 'See these',
      timestamp: 0,
      images: [
        { id: 'i', name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }
      ],
      attachments: [
        { id: 'f', kind: 'text', name: 'notes.md' },
        { id: 'd', kind: 'folder', name: 'src' },
        {
          id: 'm',
          kind: 'browser',
          name: 'Area 30 × 20',
          number: 1,
          note: 'Too tight',
          url: 'http://localhost:5173/',
          target: 'area',
          box: { x: 1, y: 2, width: 30, height: 20 },
          viewport: { width: 800, height: 600 }
        },
        // A malformed mark is left out rather than shown as something else.
        { id: 'bad', kind: 'browser', name: 'Broken' }
      ]
    })
    expect(user.images).toHaveLength(1)
    expect(user.attachments).toEqual([
      { id: 'f', kind: 'file', name: 'notes.md', relativePath: 'notes.md' },
      { id: 'd', kind: 'folder', name: 'src', relativePath: 'src' },
      expect.objectContaining({ id: 'm', kind: 'browser', number: 1, note: 'Too tight' })
    ])
  })
})

describe('liveRunMessage', () => {
  const run: AgentRunSnapshot = {
    id: 'run-1',
    threadId: 'c',
    surface: 'conversation',
    executionMode: 'act',
    phase: 'streaming',
    provider: 'p',
    model: 'm',
    lastSequence: 2,
    startedAt: 1_000,
    updatedAt: 2_000
  }
  const events: AgentRunEvent[] = [
    { id: 'e1', runId: 'run-1', sequence: 1, type: 'run.started', timestamp: 1_000, payload: {} },
    {
      id: 'e2',
      runId: 'run-1',
      sequence: 2,
      type: 'assistant.delta',
      timestamp: 1_500,
      payload: { content: 'Working on it' }
    }
  ]

  it('is the reply being written, timed from the run’s start', () => {
    const message = liveRunMessage(run, projectAgentRunEvents(events), 'plan')
    expect(message).toMatchObject({
      id: 'run:run-1',
      runId: 'run-1',
      role: 'agent',
      content: 'Working on it',
      runMode: 'plan',
      timestamp: 1_000,
      tokenUsage: { runStartedAt: 1_000 }
    })
    expect(message.segments?.[0]).toMatchObject({ type: 'text', content: 'Working on it' })
  })
})

describe('pendingSendMessage', () => {
  it('shows what this phone sent, with its photos and files', () => {
    expect(
      pendingSendMessage({
        id: 'send-1',
        text: 'Look',
        sentAt: 9,
        baseline: 0,
        images: [
          { id: 'i', name: 'a.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,' }
        ],
        files: ['log.txt']
      })
    ).toMatchObject({
      id: 'pending:send-1',
      role: 'user',
      content: 'Look',
      timestamp: 9,
      images: [{ id: 'i' }],
      attachments: [{ kind: 'file', name: 'log.txt' }]
    })
  })
})
