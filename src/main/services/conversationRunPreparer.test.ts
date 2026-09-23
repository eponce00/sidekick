import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  durableProviderHistory,
  previousReplyMadeArtifact,
  providerMessage,
  type MessageRow
} from './conversationRunPreparer'

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

  it('compacts legacy verbose browser receipts before rebuilding model history', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agent_runs (id TEXT, thread_id TEXT, provider TEXT, model TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO agent_runs VALUES ('run-1', 'conversation-1', 'openai', 'local', 1);
    `)
    const add = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    add.run('run-1', 1, 'run.started', JSON.stringify({ outputMessageId: 'assistant-1' }))
    add.run(
      'run-1',
      2,
      'assistant.completed',
      JSON.stringify({
        content: '',
        toolCalls: [{ id: 'call-1', name: 'browser_click', arguments: { ref: 'ax-1' } }]
      })
    )
    const verbose = JSON.stringify({
      action: 'click',
      targetMode: 'ref',
      durationMs: 415,
      quiescence: { idle: true, waitedMs: 350 },
      observation: {
        tab: { title: 'Form', url: 'https://example.com/form' },
        viewport: { width: 1280, height: 720 },
        screenshotChanged: true,
        screenshot: { sha256: 'a'.repeat(64) },
        semanticSnapshot: `- textbox "Password" [value="private-value"]\n${'noise'.repeat(1_000)}`
      }
    })
    add.run(
      'run-1',
      3,
      'tool.completed',
      JSON.stringify({
        name: 'browser_click',
        toolCallId: 'call-1',
        result: {
          modelContent: verbose,
          media: [
            {
              type: 'image',
              mimeType: 'image/png',
              source: { type: 'file', path: 'C:\\artifacts\\verbose.png' }
            }
          ]
        }
      })
    )

    const history = durableProviderHistory(db, 'conversation-1', [row({ id: 'assistant-1' })], {
      providerKind: 'openai-compatible',
      model: 'local'
    })
    const tool = history.find((message) => message.role === 'tool')!
    const content = String(tool.content ?? '')
    expect(content).toContain('historicalBrowserReceipt')
    expect(content.length).toBeLessThan(1_000)
    expect(content).not.toContain('private-value')
    expect(tool.media).toBeUndefined()
    db.close()
  })

  it('removes legacy inline image bytes while rebuilding durable provider history', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agent_runs (id TEXT, thread_id TEXT, provider TEXT, model TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO agent_runs VALUES ('run-1', 'conversation-1', 'openai-compatible', 'local-loaded-model', 1);
    `)
    const inlineImage = 'QUFB'.repeat(30_000)
    const add = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    add.run('run-1', 1, 'run.started', JSON.stringify({ outputMessageId: 'assistant-1' }))
    add.run(
      'run-1',
      2,
      'assistant.completed',
      JSON.stringify({
        content: 'I found an image.',
        toolCalls: [{ id: 'search-1', name: 'web_image_search', arguments: { query: 'robot' } }]
      })
    )
    add.run(
      'run-1',
      3,
      'tool.completed',
      JSON.stringify({
        toolCallId: 'search-1',
        result: {
          modelContent: JSON.stringify({
            results: [
              {
                title: 'Robot',
                imageUrl: 'https://images.example/robot.png',
                imageBase64: inlineImage
              }
            ]
          })
        }
      })
    )

    const history = durableProviderHistory(
      db,
      'conversation-1',
      [row({ id: 'assistant-1', content: 'I found an image.' })],
      { providerKind: 'openai-compatible', model: 'local-loaded-model' }
    )
    const toolContent = String(history.find((message) => message.role === 'tool')?.content ?? '')

    expect(toolContent).toContain('https://images.example/robot.png')
    expect(toolContent).toContain('"historicalVisualPayloadsOmitted":1')
    expect(toolContent).not.toContain(inlineImage)
    expect(toolContent.length).toBeLessThan(500)
    db.close()
  })

  it('gives the model the current artifact whole, not the preview the ledger keeps', () => {
    // Asked to add charts, the model copied its artifact from history, where the
    // code was cut at 2,000 characters, and the cut code failed to render.
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE agent_runs (id TEXT, thread_id TEXT, provider TEXT, model TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO agent_runs VALUES ('run-1', 'conversation-1', 'openai-compatible', 'qwen', 1);
      INSERT INTO agent_runs VALUES ('run-dropped', 'conversation-1', 'openai-compatible', 'qwen', 2);
    `)
    const version = (label: string) =>
      `export default function App() { /* ${label} */ }${'x'.repeat(3_000)}`
    const add = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    let sequence = 0
    const artifactCall = (runId: string, callId: string, code: string) => {
      add.run(
        runId,
        ++sequence,
        'assistant.completed',
        JSON.stringify({
          content: '',
          toolCalls: [
            {
              id: callId,
              name: 'create_artifact',
              arguments: { type: 'react', title: 'Weather', code: `${code.slice(0, 2_000)}…` }
            }
          ]
        })
      )
      add.run(
        runId,
        ++sequence,
        'tool.completed',
        JSON.stringify({
          toolCallId: callId,
          name: 'create_artifact',
          result: {
            modelContent: 'rendered',
            data: { artifact: { type: 'react', title: 'Weather', code } }
          }
        })
      )
    }
    add.run('run-1', ++sequence, 'run.started', JSON.stringify({ outputMessageId: 'assistant-1' }))
    artifactCall('run-1', 'first', version('first'))
    artifactCall('run-1', 'second', version('second'))
    // A rewound reply's artifact is not in the conversation and must not count as the latest.
    add.run('run-dropped', ++sequence, 'run.started', JSON.stringify({ outputMessageId: 'gone' }))
    artifactCall('run-dropped', 'dropped', version('dropped'))

    const history = durableProviderHistory(db, 'conversation-1', [row({ id: 'assistant-1' })], {
      providerKind: 'openai-compatible',
      model: 'qwen'
    })
    const codeOf = (callId: string) =>
      history.flatMap((message) => message.tool_calls ?? []).find((call) => call.id === callId)
        ?.function.arguments as { code: string }

    expect(codeOf('second').code).toBe(version('second'))
    expect(codeOf('first').code).toContain('Earlier version of "Weather" omitted')
    expect(codeOf('first').code).not.toContain('…')
    db.close()
  })

  it('keeps the artifact skill loaded for the turn after a reply that made an artifact', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE messages (id TEXT, conversation_id TEXT, role TEXT, run_id TEXT, timestamp INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO messages VALUES ('reply-1', 'with-artifact', 'agent', 'run-1', 1);
      INSERT INTO messages VALUES ('reply-2', 'moved-on', 'agent', 'run-2', 1);
      INSERT INTO messages VALUES ('reply-3', 'moved-on', 'agent', 'run-3', 2);
    `)
    const add = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    add.run('run-1', 1, 'tool.completed', JSON.stringify({ name: 'create_artifact' }))
    add.run('run-2', 1, 'tool.completed', JSON.stringify({ name: 'create_artifact' }))
    add.run('run-3', 1, 'tool.completed', JSON.stringify({ name: 'web_search' }))

    expect(previousReplyMadeArtifact(db, 'with-artifact')).toBe(true)
    // Only the latest reply counts: once the conversation moved on, the skill loads on demand.
    expect(previousReplyMadeArtifact(db, 'moved-on')).toBe(false)
    expect(previousReplyMadeArtifact(db, 'empty')).toBe(false)
    db.close()
  })
})
