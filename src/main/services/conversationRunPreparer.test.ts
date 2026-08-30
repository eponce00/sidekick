import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { durableProviderHistory, providerMessage, type MessageRow } from './conversationRunPreparer'

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'message-1',
    role: 'agent',
    content: 'Hello',
    thinking: null,
    segments: null,
    images: null,
    token_usage: null,
    timestamp: 1,
    ...overrides
  }
}

describe('conversation provider history', () => {
  it('does not duplicate visible text or expose thinking as recorded activity', () => {
    const message = providerMessage(
      row({
        segments: JSON.stringify([
          { type: 'thinking', content: 'private reasoning' },
          { type: 'text', content: 'Hello' },
          {
            type: 'summary',
            summary: { originalTokens: 100, newTokens: 20, messagesCompacted: 4 }
          }
        ])
      })
    )

    expect(message).toEqual({ role: 'assistant', content: 'Hello' })
    expect(message.content).not.toContain('Recorded activity:')
    expect(message.content).not.toContain('private reasoning')
  })

  it('never serializes UI activity segments into provider history', () => {
    const message = providerMessage(
      row({
        content: 'I checked the workspace.',
        segments: JSON.stringify([
          { type: 'text', content: 'I checked the workspace.' },
          { type: 'tool', tool: { name: 'read', output: 'configured' } },
          { type: 'interaction', interaction: { status: 'resolved' } }
        ])
      })
    )

    expect(message).toEqual({ role: 'assistant', content: 'I checked the workspace.' })
    expect(message.content).not.toContain('Recorded activity')
    expect(message.content).not.toContain('configured')
  })

  it('passes durable user image attachments to multimodal providers', () => {
    const message = providerMessage(
      row({
        role: 'user',
        content: 'What is in this image?',
        images: JSON.stringify([
          {
            id: 'image-1',
            name: 'clipboard.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA'
          }
        ])
      })
    )

    expect(message).toEqual({
      role: 'user',
      content: 'What is in this image?',
      images: ['data:image/png;base64,AAAA']
    })
  })

  it('adds durable project attachments as a model-facing manifest', () => {
    const message = providerMessage(
      row({
        role: 'user',
        content: 'Review these.',
        attachments: JSON.stringify([
          {
            id: 'attachment-1',
            kind: 'file',
            name: 'main.ts',
            relativePath: 'src/main.ts',
            size: 42
          },
          {
            id: 'attachment-2',
            kind: 'folder',
            name: 'components',
            relativePath: 'src/components'
          }
        ])
      })
    )

    expect(message.role).toBe('user')
    expect(message.content).toContain('Review these.')
    expect(message.content).toContain('file: "src/main.ts"')
    expect(message.content).toContain('folder: "src/components"')
  })

  it('rebuilds typed tool turns from the run ledger without renderer segments', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agent_runs (id TEXT, thread_id TEXT, provider TEXT, model TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO agent_runs VALUES ('run-1', 'conversation-1', 'anthropic', 'claude', 1);
    `)
    const add = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    add.run('run-1', 1, 'run.started', JSON.stringify({ outputMessageId: 'assistant-1' }))
    add.run(
      'run-1',
      2,
      'assistant.completed',
      JSON.stringify({
        content: '',
        thinkingBlocks: [{ type: 'thinking', thinking: 'inspect', signature: 'opaque' }],
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { file_path: 'a.txt' } }]
      })
    )
    add.run(
      'run-1',
      3,
      'tool.completed',
      JSON.stringify({
        toolCallId: 'call-1',
        result: {
          modelContent: 'hello',
          media: [
            {
              type: 'image',
              mimeType: 'image/png',
              name: 'viewport.png',
              source: { type: 'file', path: 'C:\\artifacts\\viewport.png' }
            }
          ]
        }
      })
    )

    const history = durableProviderHistory(
      db,
      'conversation-1',
      [row({ id: 'assistant-1', segments: JSON.stringify([{ type: 'tool', content: 'UI' }]) })],
      { providerKind: 'anthropic', model: 'claude' }
    )
    expect(history).toEqual([
      {
        role: 'assistant',
        content: null,
        thinking_blocks: [{ type: 'thinking', thinking: 'inspect', signature: 'opaque' }],
        tool_calls: [
          { id: 'call-1', function: { name: 'read', arguments: { file_path: 'a.txt' } } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'hello',
        media: [
          {
            type: 'image',
            mimeType: 'image/png',
            name: 'viewport.png',
            source: { type: 'file', path: 'C:\\artifacts\\viewport.png' }
          }
        ]
      }
    ])
    expect(JSON.stringify(history)).not.toContain('UI')

    expect(
      durableProviderHistory(db, 'conversation-1', [row({ id: 'assistant-1' })], {
        providerKind: 'openrouter',
        model: 'gpt'
      })[0]
    ).not.toHaveProperty('thinking_blocks')
    db.close()
  })
})
