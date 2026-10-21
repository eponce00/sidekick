import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderChatMessage, ProviderStreamChunk } from '../../shared/providerRuntime'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import type { AgentRunEventType } from '../../shared/agentRuntime'
import { calculateRequestBudget, estimateProviderRequestTokens } from '../../shared/contextBudget'
import { validateProviderTranscript } from '../../shared/providerTranscript'
import type { ProviderSettings } from '../../shared/settings'
import { openApplicationDatabase } from '../bootstrap/database'
import { streamProviderChat } from '../providers/providerRuntime'
import type { AgentToolRuntime } from './agentToolRuntime'
import { AgentRunStore } from './agentRunStore'
import { ConversationCompactionStore } from './conversationCompactionStore'
import { ConversationGoalStore } from './conversationGoalStore'
import {
  ConversationRunPreparer,
  historyCoveredByCompaction,
  initialEstimationBias,
  replyCoveredByCompaction,
  type MessageRow
} from './conversationRunPreparer'

vi.mock('../providers/providerRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/providerRuntime')>()),
  streamProviderChat: vi.fn()
}))

const SUMMARY = 'Summary: the early notes were read; nothing was decided.'
const databases: ReturnType<typeof openApplicationDatabase>[] = []
const folders: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  vi.mocked(streamProviderChat).mockReset()
})

function summarizes(): void {
  vi.mocked(streamProviderChat).mockImplementation(async (_request, emit) => {
    emit({ message: { content: SUMMARY } } as ProviderStreamChunk)
    emit({ done: true, done_reason: 'stop' })
    return { ok: true }
  })
}

/**
 * A chat of twelve long turns and the request a run is answering, in a project whose AGENTS.md
 * says `instructions` when given.
 */
function chat(instructions?: string): {
  db: ReturnType<typeof openApplicationDatabase>
  request: MessageRow
} {
  const db = openApplicationDatabase(':memory:')
  databases.push(db)
  db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('chat', 'Chat', 1, 1)"
  ).run()
  if (instructions) {
    const folder = mkdtempSync(join(tmpdir(), 'sidekick-compaction-'))
    folders.push(folder)
    writeFileSync(join(folder, 'AGENTS.md'), instructions)
    db.prepare(
      `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
       VALUES ('project', 'Project', ?, 1, 1)`
    ).run(folder)
    db.prepare("UPDATE conversations SET project_id = 'project' WHERE id = 'chat'").run()
  }
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

  it('keeps the project instructions word for word, without moving its anchor', async () => {
    summarizes()
    const { db } = chat('PROJECT-RULE: run the tests before shipping.')
    const run = await prepare(db, 'with-rules')
    const messages = validateProviderTranscript(run.kernelInput.messages).messages
    expect(messages[1].content).toContain('PROJECT-RULE')

    const result = await run.kernelInput.contextManager!.compact(
      messages,
      [],
      new AbortController().signal
    )

    // Summarized with the history, the instructions were only a paraphrase for the rest of the run.
    expect(result.messages[1]).toEqual(messages[1])
    expect(result.messages[2].content).toContain(SUMMARY)
    const kept = result.messages.filter((message) => /^TURN-\d+/.test(message.content ?? ''))
    const firstKept = Number(/^TURN-(\d+)/.exec(kept[0].content!)![1])
    expect(new ConversationCompactionStore(db).latest('chat')?.compactedThroughMessageId).toBe(
      `turn-${firstKept - 1}`
    )
    const next = await prepare(db, 'after-rules')
    expect(
      next.kernelInput.messages.filter((message) => message.content?.includes('PROJECT-RULE'))
    ).toHaveLength(1)
  })

  it('is not sent again, in the next run, the part of a reply its summary replaced', async () => {
    // After a run compacted its own work, the next run was sent that whole reply again and
    // compacted at once: 6 of 13 run-start compactions in one journal, at 2-5x the real prompt.
    summarizes()
    const { db } = chat()
    const store = new AgentRunStore(db)
    store.start({
      id: 'long',
      threadId: 'chat',
      outputMessageId: 'long-reply',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'openai-compatible',
      model: 'model'
    })
    const run = await prepare(db, 'long')
    const own: ProviderChatMessage[] = []
    for (let index = 0; index < 6; index++) {
      const id = `call-${index}`
      const content = `OWN-${index} ${'working through the fixture notes '.repeat(100)}`
      const output = `RESULT-${index} ${'a line of the file that was read '.repeat(100)}`
      store.appendEvent({
        id: `long:turn-${index}`,
        runId: 'long',
        type: 'assistant.completed',
        payload: { content, toolCalls: [{ id, name: 'read', arguments: { path: `${index}.md` } }] }
      })
      store.appendEvent({
        id: `long:result-${index}`,
        runId: 'long',
        type: 'tool.completed',
        payload: { toolCallId: id, name: 'read', result: { modelContent: output } }
      })
      own.push(
        {
          role: 'assistant',
          content,
          tool_calls: [{ id, function: { name: 'read', arguments: { path: `${index}.md` } } }]
        },
        { role: 'tool', tool_call_id: id, content: output }
      )
    }
    const messages = validateProviderTranscript([...run.kernelInput.messages, ...own]).messages
    const result = await run.kernelInput.contextManager!.compact(
      messages,
      [],
      new AbortController().signal
    )
    const keptOwn = result.messages
      .map((message) => message.content ?? '')
      .filter((content) => /^(OWN|RESULT)-/.test(content))
    expect(keptOwn.length).toBeGreaterThan(0)
    expect(keptOwn.length).toBeLessThan(12)
    expect(new ConversationCompactionStore(db).latest('chat')).toMatchObject({
      compactedThroughMessageId: 'request',
      replyMessageId: 'long-reply',
      replyMessagesCovered: 12 - keptOwn.length
    })

    // The run finishes after the summary, and the user asks again.
    store.appendEvent({
      id: 'long:final',
      runId: 'long',
      type: 'assistant.completed',
      payload: { content: 'FINAL: the notes are read.', toolCalls: [] }
    })
    const add = db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    add.run('long-reply', 'chat', 'agent', 'FINAL: the notes are read.', 3_000)
    add.run('next-user', 'chat', 'user', 'NEXT: and then?', 4_000)
    const next = await prepare(db, 'next')
    const sent = next.kernelInput.messages.map((message) => message.content ?? '')
    expect(sent.join('\n')).toContain(SUMMARY)
    // What the summary kept word for word, then what came after it, and nothing it replaced.
    expect(sent.filter((content) => /^(OWN|RESULT)-/.test(content))).toEqual(keptOwn)
    expect(sent).toContain('FINAL: the notes are read.')
    expect(sent.at(-1)).toBe('NEXT: and then?')
    expect(next.kernelInput.contextManager!.shouldCompact(next.kernelInput.messages, [])).toBe(
      false
    )
  })

  it('is not needed after a run stopped mid-turn, when the model counts the chat under the threshold', async () => {
    const { db } = chat()
    const tools = getAgentToolDefinitions({ surface: 'conversation', capabilities: [] })
    // The request the stopped run made, and what the model said it held.
    const before = validateProviderTranscript((await prepare(db, 'probe')).kernelInput.messages)
    const estimated = estimateProviderRequestTokens(before.messages, tools)
    const store = new AgentRunStore(db)
    store.start({
      id: 'stopped',
      threadId: 'chat',
      outputMessageId: 'stopped-reply',
      profile: { surface: 'conversation', executionMode: 'act', capabilities: [] },
      provider: 'openai-compatible',
      model: 'model'
    })
    let sequence = 0
    const append = (type: AgentRunEventType, payload: Record<string, unknown>): void => {
      store.appendEvent({ id: `stopped:${++sequence}`, runId: 'stopped', type, payload })
    }
    append('assistant.completed', {
      content: 'Reading the notes.',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'notes.md' } }]
    })
    append('usage.updated', {
      promptTokens: Math.round(estimated * 0.7),
      completionTokens: 40,
      estimatedPromptTokens: estimated
    })
    append('tool.completed', {
      toolCallId: 'call-1',
      name: 'read',
      result: { modelContent: 'The notes say nothing new.' }
    })
    // Stopped while the next turn streamed: part of a reply, never completed.
    append('assistant.delta', { content: 'Half of an ans' })
    store.transition('stopped', 'cancelled', 'stopped:cancelled')
    const add = db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    )
    add.run('stopped-reply', 'chat', 'agent', 'Reading the notes.Half of an ans', 3_000)
    add.run('again', 'chat', 'user', 'AGAIN: carry on.', 4_000)

    const next = await prepare(db, 'again')
    const messages = validateProviderTranscript(next.kernelInput.messages).messages
    // SideKick's own estimate alone is past the threshold; the model's count is well under it.
    expect(
      calculateRequestBudget({
        messages,
        tools,
        contextLength: 32_768,
        reservedOutputTokens: 4_096,
        compactionThreshold: 0.8
      }).shouldCompact
    ).toBe(true)
    expect(next.kernelInput.contextManager!.shouldCompact(messages, tools)).toBe(false)
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

describe('initialEstimationBias', () => {
  const rows = [
    { id: 'old', role: 'agent' },
    { id: 'ask', role: 'user' },
    { id: 'latest', role: 'agent' }
  ] as MessageRow[]
  const usage = (entries: Record<string, object>) =>
    new Map(Object.entries(entries)) as Parameters<typeof initialEstimationBias>[1]
  const sample = (promptTokens: number, estimatedPromptTokens: number, model = 'm') => ({
    promptTokens,
    completionTokens: 1,
    calibration: { promptTokens, estimatedPromptTokens },
    model
  })

  it('counts what an earlier request held at the provider’s count, and the rest at the estimate', () => {
    const recorded = usage({ old: sample(50_000, 60_000), latest: sample(100_000, 130_000) })
    // The next request holds the latest one and 5,000 estimated tokens more.
    expect(initialEstimationBias(rows, recorded, 'm', 135_000)).toBe(-30_000)
    // Smaller than it, part of it summarized since: the same share of its estimate.
    expect(initialEstimationBias(rows, recorded, 'm', 65_000)).toBe(-15_000)
  })

  it('passes over a run stopped before any request finished, and one on another model', () => {
    // Stopped before its first request finished: no usage at all, or none it could pair.
    expect(initialEstimationBias(rows, usage({ old: sample(50_000, 60_000) }), 'm', 70_000)).toBe(
      -10_000
    )
    expect(
      initialEstimationBias(
        rows,
        usage({
          old: sample(50_000, 60_000),
          latest: { promptTokens: 100_000, completionTokens: 1, model: 'm' }
        }),
        'm',
        70_000
      )
    ).toBe(-10_000)
    expect(
      initialEstimationBias(
        rows,
        usage({ old: sample(50_000, 60_000), latest: sample(100_000, 130_000, 'other') }),
        'm',
        70_000
      )
    ).toBe(-10_000)
    expect(initialEstimationBias(rows, usage({}), 'm', 135_000)).toBe(0)
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
      beyondHistory: false,
      afterHistory: 4
    })
    expect(
      historyCoveredByCompaction(history, [...summarized, reply('b3'), user('c'), reply('own')])
    ).toEqual({ rows: 3, beyondHistory: true, afterHistory: 6 })
    // A second compaction in the run starts after the rows the first one covered.
    expect(historyCoveredByCompaction(history, [user('summary'), reply('b1')], 1)).toEqual({
      rows: 1,
      beyondHistory: false,
      afterHistory: 2
    })
  })
})

describe('replyCoveredByCompaction', () => {
  const said = (content: string): ProviderChatMessage => ({ role: 'assistant', content })
  const call = (id: string): ProviderChatMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, function: { name: 'read', arguments: {} } }]
  })
  const result = (id: string, content = `result ${id}`): ProviderChatMessage => ({
    role: 'tool',
    tool_call_id: id,
    content
  })
  const reply = [call('1'), result('1'), call('2'), result('2'), said('done')]

  it('counts the reply’s leading messages found in order among the summarized ones', () => {
    // A notice the run added in between is not in the reply, and is passed over.
    const summarized = [call('1'), result('1'), { role: 'user' as const, content: 'notice' }]
    expect(replyCoveredByCompaction(reply, summarized)).toBe(2)
    expect(replyCoveredByCompaction(reply, [...summarized, call('2'), result('2')])).toBe(4)
    // A second compaction continues from what the first covered.
    expect(
      replyCoveredByCompaction(
        reply,
        [{ role: 'user', content: 'summary' }, call('2'), result('2')],
        2
      )
    ).toBe(4)
  })

  it('stops at a message it cannot find, and never between a call and its result', () => {
    // The run added a reminder to this result after the ledger recorded it.
    expect(replyCoveredByCompaction(reply, [call('1'), result('1', 'result 1 + reminder')])).toBe(0)
    expect(replyCoveredByCompaction(reply, [call('1'), result('1'), call('2')])).toBe(2)
  })
})
