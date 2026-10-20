import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderChatMessage, ProviderStreamChunk } from '../../shared/providerRuntime'
import { validateProviderTranscript } from '../../shared/providerTranscript'
import type { ProviderSettings } from '../../shared/settings'
import { openApplicationDatabase } from '../bootstrap/database'
import { streamProviderChat } from '../providers/providerRuntime'
import type { AgentToolRuntime } from './agentToolRuntime'
import { ConversationCompactionStore } from './conversationCompactionStore'
import { ConversationGoalStore } from './conversationGoalStore'
import {
  ConversationRunPreparer,
  historyCoveredByCompaction,
  type MessageRow
} from './conversationRunPreparer'

vi.mock('../providers/providerRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/providerRuntime')>()),
  streamProviderChat: vi.fn()
}))

const SUMMARY = 'Summary: the early notes were read; nothing was decided.'
const databases: ReturnType<typeof openApplicationDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  vi.mocked(streamProviderChat).mockReset()
})

function summarizes(): void {
  vi.mocked(streamProviderChat).mockImplementation(async (_request, emit) => {
    emit({ message: { content: SUMMARY } } as ProviderStreamChunk)
    emit({ done: true, done_reason: 'stop' })
    return { ok: true }
  })
}

/** A chat of twelve long turns and the request a run is answering. */
function chat(): { db: ReturnType<typeof openApplicationDatabase>; request: MessageRow } {
  const db = openApplicationDatabase(':memory:')
  databases.push(db)
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('chat', 'Chat', 1, 1)"
  ).run()
  const add = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
  )
  for (let index = 0; index < 12; index++) {
    add.run(
      `turn-${index}`,
      'chat',
      index % 2 ? 'agent' : 'user',
      `TURN-${index} ${'notes on the fixture project '.repeat(300)}`,
      1_000 + index
    )
  }
  add.run('request', 'chat', 'user', 'REQUEST: carry on with the notes.', 2_000)
  return { db, request: db.prepare("SELECT * FROM messages WHERE id = 'request'").get() as never }
}

async function prepare(db: ReturnType<typeof openApplicationDatabase>, runId: string) {
  const preparer = new ConversationRunPreparer(
    db,
    {
      createSession: async () => ({
        catalog: () => ({ surface: 'conversation' as const, capabilities: [] }),
        router: { execute: vi.fn() },
        persistentSkillIds: () => []
      })
    } as unknown as AgentToolRuntime,
    new ConversationGoalStore(db),
    () => ({ autoCompactEnabled: true, autoCompactThreshold: 0.8 }) as ProviderSettings,
    () => 'assets'
  )
  return preparer.prepare(
    {
      id: runId,
      conversationId: 'chat',
      assistantMessageId: `${runId}-reply`,
      model: {
        id: 'model',
        name: 'model',
        provider: 'lmstudio',
        providerKind: 'openai-compatible',
        contextLength: 32_768,
        maxOutputTokens: 4_096,
        supportsTools: true
      }
    },
    async () => undefined
  )
}

const contents = (messages: readonly ProviderChatMessage[]): string =>
  messages.map((message) => message.content ?? '').join('\n')

describe('a compaction during a conversation run', () => {
  it('is saved as it completes, at the last row it summarized, and kept across a retry', async () => {
    summarizes()
    const { db, request } = chat()
    const store = new ConversationCompactionStore(db)
    const first = await prepare(db, 'first')
    const manager = first.kernelInput.contextManager!
    const messages = validateProviderTranscript(first.kernelInput.messages).messages
    const result = await manager.compact(messages, [], new AbortController().signal)
    expect(result.compacted).toBe(true)

    // Saved before the run ends, with no finalization: a cancel or failure next keeps it.
    const saved = store.latest('chat')
    const kept = result.messages.filter((message) => /^TURN-\d+/.test(message.content ?? ''))
    const firstKept = Number(/^TURN-(\d+)/.exec(kept[0].content!)![1])
    expect(firstKept).toBeGreaterThan(0)
    expect(saved).toMatchObject({
      summary: SUMMARY,
      strategy: 'model',
      compactedThroughMessageId: `turn-${firstKept - 1}`,
      compactedThroughTimestamp: 1_000 + firstKept - 1
    })

    // Retrying or editing the request leaves a summary of earlier turns in place.
    store.invalidateAfterTimestamp('chat', request.timestamp)
    store.invalidateFromTimestamp('chat', request.timestamp)
    expect(store.latest('chat')?.id).toBe(saved?.id)

    // The next run starts from the summary and still has the recent turns and the request.
    const retry = await prepare(db, 'retry')
    const sent = contents(retry.kernelInput.messages)
    expect(sent).toContain(SUMMARY)
    for (const message of kept) expect(sent).toContain(message.content)
    expect(sent).toContain('REQUEST: carry on with the notes.')
    expect(sent).not.toContain(`TURN-${firstKept - 1} `)
    expect(retry.kernelInput.contextManager!.shouldCompact(retry.kernelInput.messages, [])).toBe(
      false
    )
  })

  it('goes with the reply when it summarized the run’s own work', async () => {
    summarizes()
    const { db, request } = chat()
    const store = new ConversationCompactionStore(db)
    const run = await prepare(db, 'run')
    // The run's own work pushes everything before it out of the recent tail.
    const own: ProviderChatMessage[] = Array.from({ length: 6 }, (_, index) => ({
      role: 'assistant',
      content: `OWN-${index} ${'working through the fixture notes '.repeat(200)}`
    }))
    const messages = validateProviderTranscript([...run.kernelInput.messages, ...own]).messages
    await run.kernelInput.contextManager!.compact(messages, [], new AbortController().signal)
    const saved = store.latest('chat')
    expect(saved?.compactedThroughMessageId).toBe('request')
    expect(saved?.compactedThroughTimestamp).toBeGreaterThan(request.timestamp)

    // Retrying the request discards the reply, and the summary of it.
    store.invalidateAfterTimestamp('chat', request.timestamp)
    expect(store.latest('chat')).toBeNull()
  })

  it('saves nothing when the run is stopped while the summary is written', async () => {
    const controller = new AbortController()
    vi.mocked(streamProviderChat).mockImplementation(async (_request, emit) => {
      emit({ message: { content: 'Summary: half of' } } as ProviderStreamChunk)
      controller.abort()
      return { ok: false, error: 'aborted' }
    })
    const { db } = chat()
    const run = await prepare(db, 'run')
    const messages = validateProviderTranscript(run.kernelInput.messages).messages
    await expect(
      run.kernelInput.contextManager!.compact(messages, [], controller.signal)
    ).rejects.toThrow()
    expect(new ConversationCompactionStore(db).latest('chat')).toBeNull()
  })
})

describe('historyCoveredByCompaction', () => {
  const row = (id: string): MessageRow =>
    ({ id, role: 'agent', content: id, timestamp: 1 }) as MessageRow
  const user = (content: string): ProviderChatMessage => ({ role: 'user', content })
  const reply = (content: string): ProviderChatMessage => ({ role: 'assistant', content })

  it('counts a row only when every message it gave the model was summarized', () => {
    const history = [
      { row: row('a'), messages: [user('a')] },
      { row: row('b'), messages: [reply('b1'), reply('b2'), reply('b3')] },
      { row: row('c'), messages: [user('c')] }
    ]
    const summarized = [user('instructions'), user('a'), reply('b1'), reply('b2')]
    expect(historyCoveredByCompaction(history, summarized)).toEqual({
      rows: 1,
      beyondHistory: false
    })
    expect(
      historyCoveredByCompaction(history, [...summarized, reply('b3'), user('c'), reply('own')])
    ).toEqual({ rows: 3, beyondHistory: true })
    // A second compaction in the run starts after the rows the first one covered.
    expect(historyCoveredByCompaction(history, [user('summary'), reply('b1')], 1)).toEqual({
      rows: 1,
      beyondHistory: false
    })
  })
})
