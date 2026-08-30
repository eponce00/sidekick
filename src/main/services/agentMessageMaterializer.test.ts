import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentRunStore } from './agentRunStore'
import { AgentMessageMaterializer } from './agentMessageMaterializer'

describe('AgentMessageMaterializer', () => {
  let db: Database.Database
  let runs: AgentRunStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES ('conversation-1', 'Test', 1, 1)`
    ).run()
    runs = new AgentRunStore(db)
  })

  afterEach(() => db.close())

  it('rebuilds one linked assistant materialization from the durable journal', () => {
    runs.start({
      id: 'run-1',
      threadId: 'conversation-1',
      outputMessageId: 'assistant-1',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'test',
      model: 'model'
    })
    runs.appendEvent({
      id: 'delta-1',
      runId: 'run-1',
      type: 'assistant.delta',
      payload: { content: 'Hello' }
    })
    runs.appendEvent({
      id: 'assistant-complete',
      runId: 'run-1',
      type: 'assistant.completed',
      payload: { content: 'Hello', thinking: '' }
    })
    runs.transition('run-1', 'completed', 'run-complete')

    new AgentMessageMaterializer(db, runs).materialize('run-1', {
      checkpointHash: 'checkpoint-1',
      checkpointWorkspaceRoot: 'C:/project'
    })
    const row = db.prepare('SELECT content, run_id, checkpoint_hash FROM messages').get()
    expect(row).toEqual({
      content: 'Hello',
      run_id: 'run-1',
      checkpoint_hash: 'checkpoint-1'
    })
  })

  it('materializes a useful interruption marker from partial output', () => {
    runs.start({
      id: 'run-2',
      threadId: 'conversation-1',
      outputMessageId: 'assistant-2',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'test',
      model: 'model'
    })
    runs.appendEvent({
      id: 'delta-2',
      runId: 'run-2',
      type: 'assistant.delta',
      payload: { content: 'Partial' }
    })
    runs.recoverInterrupted()

    const result = new AgentMessageMaterializer(db, runs).materialize('run-2')
    expect(result.content).toContain('Partial')
    expect(result.content).toContain('interrupted')
  })

  it('persists the compaction marker between the tool calls that surround it', () => {
    runs.start({
      id: 'run-chronology',
      threadId: 'conversation-1',
      outputMessageId: 'assistant-chronology',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'test',
      model: 'model'
    })
    runs.appendEvent({
      id: 'before-pending',
      runId: 'run-chronology',
      type: 'tool.pending',
      payload: { toolCallId: 'before', name: 'read' }
    })
    runs.appendEvent({
      id: 'before-completed',
      runId: 'run-chronology',
      type: 'tool.completed',
      payload: {
        toolCallId: 'before',
        result: {
          status: 'success',
          title: 'Before compaction',
          modelContent: 'before',
          timing: { startedAt: 1, completedAt: 2 }
        }
      }
    })
    runs.appendEvent({
      id: 'compacted',
      runId: 'run-chronology',
      type: 'compaction.completed',
      payload: {
        summary: 'Preserve exact chronology.',
        originalTokens: 10_000,
        summaryTokens: 1_000,
        messagesCompacted: 12
      }
    })
    runs.appendEvent({
      id: 'after-pending',
      runId: 'run-chronology',
      type: 'tool.pending',
      payload: { toolCallId: 'after', name: 'write' }
    })
    runs.appendEvent({
      id: 'after-turn',
      runId: 'run-chronology',
      type: 'assistant.completed',
      payload: { content: '', thinking: '', toolCalls: [{ id: 'after', name: 'write' }] }
    })
    runs.appendEvent({
      id: 'after-completed',
      runId: 'run-chronology',
      type: 'tool.completed',
      payload: {
        toolCallId: 'after',
        result: {
          status: 'success',
          title: 'After compaction',
          modelContent: 'after',
          timing: { startedAt: 5, completedAt: 6 }
        }
      }
    })
    runs.transition('run-chronology', 'completed', 'chronology-complete')

    new AgentMessageMaterializer(db, runs).materialize('run-chronology')
    const row = db
      .prepare('SELECT segments FROM messages WHERE id = ?')
      .get('assistant-chronology') as { segments: string }
    const segments = JSON.parse(row.segments) as Array<{
      type: string
      tool?: { id: string }
      content?: string
    }>

    expect(
      segments.map((segment) =>
        segment.type === 'tool' ? `tool:${segment.tool?.id}` : segment.type
      )
    ).toEqual(['tool:before', 'summary', 'tool:after'])
    expect(segments[1]?.content).toContain('Preserve exact chronology.')
  })
})
