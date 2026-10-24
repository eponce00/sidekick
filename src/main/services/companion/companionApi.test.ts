import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunSnapshot, PendingAgentInteraction } from '../../../shared/agentRuntime'
import type { PinnedModel } from '../../../shared/models'
import { applyDatabaseSchema } from '../../bootstrap/database'
import { createConversation } from '../conversationCreation'
import { PromptAdmissionStore } from '../promptAdmissionStore'
import {
  CompanionApi,
  pcm16Base64,
  trimForPhone,
  type CompanionApiDependencies,
  type CompanionVoice
} from './companionApi'

const MODEL = { id: 'local:model', name: 'model', provider: 'lmstudio' } as PinnedModel
const BLIND = {
  id: 'local:blind',
  name: 'blind',
  provider: 'lmstudio',
  supportsVision: false
} as PinnedModel
const DEVICE = 'device-1'
// The smallest PNG: a valid signature and header, so it passes the window's image checks.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function run(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    id: 'run-1',
    threadId: 'chat',
    surface: 'conversation',
    phase: 'streaming',
    ...overrides
  } as AgentRunSnapshot
}

function setup(overrides: Partial<CompanionApiDependencies> = {}) {
  const db = new Database(':memory:')
  applyDatabaseSchema(db)
  const chat = createConversation(db, {
    title: 'Fix the build',
    projectId: null,
    titleSource: 'fallback',
    modelId: null
  })
  const runs = new Map<string, AgentRunSnapshot>()
  const interactions = new Map<string, PendingAgentInteraction>()
  const queued: Array<() => void> = []
  const deps: CompanionApiDependencies = {
    db,
    startRun: vi.fn(async () => undefined),
    stopRun: vi.fn(async () => true),
    runEvents: vi.fn(
      async (runId: string) => ({ run: runs.get(runId) ?? null, events: [] }) as never
    ),
    latestRun: vi.fn(
      (conversationId: string) =>
        [...runs.values()].reverse().find((item) => item.threadId === conversationId) ?? null
    ),
    run: vi.fn((runId: string) => runs.get(runId) ?? null),
    interaction: vi.fn((id: string) => interactions.get(id) ?? null),
    resolveInteraction: vi.fn(async () => undefined),
    steerAdmission: vi.fn(() => true),
    models: vi.fn(() => [MODEL, BLIND]),
    resolveModel: vi.fn((_conversationId: string, requested?: string) =>
      requested === undefined ? MODEL : ([MODEL, BLIND].find(({ id }) => id === requested) ?? null)
    ),
    setChatModel: vi.fn(),
    messagesChanged: vi.fn(),
    queueChanged: vi.fn(),
    shrinkImage: vi.fn(async (image) => ({ ...image, dataUrl: 'data:image/jpeg;base64,small' })),
    readArtifact: vi.fn(async () => null),
    sendToDevice: vi.fn(),
    later: (work) => queued.push(work),
    ...overrides
  }
  const api = new CompanionApi(deps)
  const call = (name: Parameters<CompanionApi['handle']>[0], input: unknown, device = DEVICE) =>
    api.handle(name, input, device)
  const upload = async (
    kind: 'image' | 'text',
    data: Buffer,
    mimeType = 'image/png',
    device = DEVICE
  ): Promise<string> =>
    (
      (await call(
        'upload.put',
        { kind, name: `file.${kind}`, mimeType, data: data.toString('base64'), last: true },
        device
      )) as { uploadId: string }
    ).uploadId
  const flush = (): void => queued.splice(0).forEach((work) => work())
  return { api, call, upload, flush, deps, db, chat, runs, interactions }
}

function interaction(overrides: Partial<PendingAgentInteraction>): PendingAgentInteraction {
  return {
    id: 'card',
    runId: 'run-1',
    kind: 'permission',
    status: 'pending',
    request: {},
    createdAt: 1,
    ...overrides
  }
}

describe('CompanionApi', () => {
  it('lists chats with whether each is working or waiting for an answer', async () => {
    const { call, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id, phase: 'awaiting_permission' }))
    expect(await call('chats.list', {})).toEqual([
      expect.objectContaining({
        id: chat.id,
        title: 'Fix the build',
        activePhase: 'awaiting_permission',
        needsAnswer: true
      })
    ])
  })

  it('saves a message and starts a run in the chosen mode, on the path the window uses', async () => {
    const { call, deps, db, chat } = setup()
    const result = await call('chat.send', {
      conversationId: chat.id,
      text: '  Find sources ',
      mode: 'research'
    })
    expect(result).toMatchObject({ conversationId: chat.id, steered: false, queued: false })
    expect(db.prepare('SELECT role, content, run_mode FROM messages').all()).toEqual([
      { role: 'user', content: 'Find sources', run_mode: 'research' }
    ])
    expect(deps.messagesChanged).toHaveBeenCalledWith(chat.id)
    expect(deps.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: chat.id, model: MODEL, mode: 'research' })
    )
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'x', mode: 'shell' })
    ).rejects.toThrow(/mode/)
  })

  it('keeps a model the phone chose for the chat, and refuses one that is gone', async () => {
    const { call, deps, chat } = setup()
    await call('chat.send', { conversationId: chat.id, text: 'hi', modelId: BLIND.id })
    expect(deps.setChatModel).toHaveBeenCalledWith(chat.id, BLIND.id)
    expect(deps.startRun).toHaveBeenCalledWith(expect.objectContaining({ model: BLIND }))
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'hi', modelId: 'gone' })
    ).rejects.toThrow(/no longer available/)
    expect(await call('models.list', { conversationId: chat.id })).toEqual({
      models: [
        { id: MODEL.id, name: 'model', supportsVision: true },
        { id: BLIND.id, name: 'blind', supportsVision: false }
      ],
      selectedModelId: MODEL.id
    })
  })

  it('queues a message while a run works, in the queue the window shows', async () => {
    const { call, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    expect(await call('chat.send', { conversationId: chat.id, text: 'also lint' })).toEqual({
      conversationId: chat.id,
      runId: 'run-1',
      steered: false,
      queued: true
    })
    expect(new PromptAdmissionStore(db).list(chat.id).queued).toEqual([
      expect.objectContaining({ content: 'also lint', behavior: 'queue', mode: 'conversation' })
    ])
    expect(deps.queueChanged).toHaveBeenCalledWith(chat.id)
    expect(deps.startRun).not.toHaveBeenCalled()
  })

  it('steers a message into the running run, or stops a run that cannot take it', async () => {
    const { call, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    const steered = await call('chat.send', {
      conversationId: chat.id,
      text: 'use the other API',
      behavior: 'steer'
    })
    expect(steered).toMatchObject({ steered: true, queued: false })
    const pivot = new PromptAdmissionStore(db).list(chat.id).pivot
    expect(pivot).toMatchObject({ content: 'use the other API', behavior: 'pivot' })
    expect(deps.steerAdmission).toHaveBeenCalledWith('run-1', pivot!.id)

    vi.mocked(deps.steerAdmission).mockReturnValue(false)
    const refused = await call('chat.send', {
      conversationId: chat.id,
      text: 'now this',
      behavior: 'steer'
    })
    expect(refused).toMatchObject({ steered: false, queued: true })
    expect(deps.stopRun).toHaveBeenCalledWith('run-1')
    // The earlier steer moved to the front of the queue; the new one waits as the steer.
    const after = new PromptAdmissionStore(db).list(chat.id)
    expect(after.pivot?.content).toBe('now this')
    expect(after.queued.map(({ content }) => content)).toEqual(['use the other API'])
  })

  it('edits, reorders, removes and steers queued messages', async () => {
    const { call, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    for (const text of ['one', 'two', 'three'])
      await call('chat.send', { conversationId: chat.id, text })
    const [one, two] = new PromptAdmissionStore(db).list(chat.id).queued
    const updated = (await call('queue.update', {
      conversationId: chat.id,
      queued: [
        { id: two.id, content: 'two, edited' },
        { id: one.id, content: 'one' },
        { id: 'unknown', content: 'injected' }
      ]
    })) as { queued: Array<{ content: string }> }
    expect(updated.queued.map(({ content }) => content)).toEqual(['two, edited', 'one'])
    expect(await call('queue.steer', { conversationId: chat.id, admissionId: one.id })).toEqual({
      steered: true
    })
    expect(deps.steerAdmission).toHaveBeenLastCalledWith('run-1', one.id)
    await expect(
      call('queue.steer', { conversationId: chat.id, admissionId: 'missing' })
    ).rejects.toThrow(/no longer queued/)
  })

  it('sends the next queued message when a run ends and no window took it', async () => {
    const { api, flush, call, deps, db, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    await call('chat.send', { conversationId: chat.id, text: 'next please' })
    runs.set('run-1', run({ threadId: chat.id, phase: 'completed' }))
    api.runEnded(chat.id)
    expect(deps.startRun).not.toHaveBeenCalled()
    flush()
    await vi.waitFor(() =>
      expect(deps.startRun).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: chat.id, mode: 'conversation' })
      )
    )
    expect(db.prepare("SELECT content FROM messages WHERE role = 'user'").all()).toEqual([
      { content: 'next please' }
    ])
    expect(new PromptAdmissionStore(db).list(chat.id).queued).toEqual([])
    // A run already going (a window sent it first) is left alone.
    vi.mocked(deps.startRun).mockClear()
    runs.set('run-2', run({ id: 'run-2', threadId: chat.id }))
    await call('chat.send', { conversationId: chat.id, text: 'later' })
    api.runEnded(chat.id)
    flush()
    expect(deps.startRun).not.toHaveBeenCalled()
  })

  it('attaches uploaded images and text files, checked as the window checks them', async () => {
    const { call, upload, db, chat } = setup()
    const image = await upload('image', PNG)
    const notes = await upload('text', Buffer.from('line one\nline two'), 'text/plain')
    await call('chat.send', {
      conversationId: chat.id,
      text: 'What is this?',
      images: [{ uploadId: image }],
      files: [{ uploadId: notes }]
    })
    const row = db.prepare('SELECT images, attachments FROM messages').get() as {
      images: string
      attachments: string
    }
    expect(JSON.parse(row.images)).toEqual([
      expect.objectContaining({
        mimeType: 'image/png',
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/)
      })
    ])
    expect(JSON.parse(row.attachments)).toEqual([
      expect.objectContaining({ kind: 'text', name: 'file.text', content: 'line one\nline two' })
    ])
    // Each upload is taken once.
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'again', images: [{ uploadId: image }] })
    ).rejects.toThrow(/no longer available/)
  })

  it("refuses images for a blind model, binary files, fake images and other phones' uploads", async () => {
    const { call, upload, chat } = setup()
    const image = await upload('image', PNG)
    await expect(
      call('chat.send', {
        conversationId: chat.id,
        text: 'look',
        modelId: BLIND.id,
        images: [{ uploadId: image }]
      })
    ).rejects.toThrow(/cannot see images/)
    const binary = await upload('text', Buffer.from([0, 1, 2, 0, 255, 0]), 'application/pdf')
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'read', files: [{ uploadId: binary }] })
    ).rejects.toThrow(/not a text file/)
    const fake = await upload('image', Buffer.from('not really a png'))
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'look', images: [{ uploadId: fake }] })
    ).rejects.toThrow(/Invalid message image/)
    const theirs = await upload('image', PNG, 'image/png', 'device-2')
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'look', images: [{ uploadId: theirs }] })
    ).rejects.toThrow(/no longer available/)
  })

  it('refuses oversized upload pieces and garbled data', async () => {
    const { call } = setup()
    await expect(
      call('upload.put', {
        kind: 'image',
        name: 'big',
        mimeType: 'image/png',
        data: Buffer.alloc(200 * 1024).toString('base64'),
        last: true
      })
    ).rejects.toThrow(/too large/)
    await expect(
      call('upload.put', {
        kind: 'image',
        name: 'x',
        mimeType: 'image/png',
        data: '%%%',
        last: true
      })
    ).rejects.toThrow(/Invalid upload/)
    await expect(
      call('upload.put', { kind: 'script', name: 'x', mimeType: 'text/x', data: '', last: true })
    ).rejects.toThrow(/Invalid upload/)
  })

  it('starts a new chat when none is named, and leaves none behind when sending fails', async () => {
    const { call, db } = setup()
    const result = (await call('chat.send', { text: 'Plan a trip to Lisbon' })) as {
      conversationId: string
    }
    expect(
      db
        .prepare('SELECT title, model_id FROM conversations WHERE id = ?')
        .get(result.conversationId)
    ).toEqual({ title: expect.stringContaining('Lisbon'), model_id: MODEL.id })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n
    await expect(call('chat.send', { text: 'x', images: [{ uploadId: 'nope' }] })).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: before })
  })

  it('refuses empty or oversized messages, unknown chats, and chats without a model', async () => {
    const { call, chat } = setup({ resolveModel: vi.fn(() => null) })
    await expect(call('chat.send', { conversationId: chat.id, text: '   ' })).rejects.toThrow()
    await expect(
      call('chat.send', { conversationId: chat.id, text: 'x'.repeat(100_001) })
    ).rejects.toThrow()
    await expect(call('chat.send', { conversationId: 'nope', text: 'hi' })).rejects.toThrow(
      /no longer exists/
    )
    await expect(call('chat.send', { conversationId: chat.id, text: 'hi' })).rejects.toThrow(
      /no model/
    )
    await expect(call('chat.open', { conversationId: { $ne: 1 } })).rejects.toThrow()
  })

  it('reaches the runs of a chat, its research and its sub-agents, and nothing else', async () => {
    const { call, deps, chat, runs } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    runs.set('research', run({ id: 'research', threadId: chat.id, surface: 'research' }))
    runs.set('sub', run({ id: 'sub', threadId: chat.id, surface: 'subagent' }))
    runs.set('elsewhere', run({ id: 'elsewhere', threadId: 'schedule-run-7', surface: 'subagent' }))
    expect(await call('run.stop', { runId: 'research' })).toEqual({ stopped: true })
    expect(await call('run.events', { runId: 'sub', afterSequence: 0 })).toBeTruthy()
    await expect(call('run.stop', { runId: 'elsewhere' })).rejects.toThrow()
    await expect(call('run.stop', { runId: 'missing' })).rejects.toThrow()
    expect(deps.stopRun).toHaveBeenCalledTimes(1)
  })

  it('answers permission and tool-limit cards with a known decision', async () => {
    const { call, deps, chat, runs, interactions } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    interactions.set('card', interaction({ kind: 'permission', request: {} }))
    await expect(
      call('interaction.resolve', { interactionId: 'card', response: { decision: 'allow_chat' } })
    ).rejects.toThrow(/only be allowed once/)
    await expect(
      call('interaction.resolve', { interactionId: 'card', response: { approved: true } })
    ).rejects.toThrow()
    await call('interaction.resolve', {
      interactionId: 'card',
      response: { decision: 'deny_stop', extra: 'ignored' }
    })
    expect(deps.resolveInteraction).toHaveBeenCalledWith({
      interactionId: 'card',
      response: { approved: false, decision: 'deny_stop' }
    })
    interactions.set('limit', interaction({ id: 'limit', kind: 'tool_limit' }))
    await call('interaction.resolve', { interactionId: 'limit', response: { approved: true } })
    expect(deps.resolveInteraction).toHaveBeenLastCalledWith({
      interactionId: 'limit',
      response: { approved: true }
    })
  })

  it('takes only the questions asked, and leaves cards that act on the computer to it', async () => {
    const { call, deps, chat, runs, interactions } = setup()
    runs.set('run-1', run({ threadId: chat.id }))
    interactions.set(
      'card',
      interaction({
        kind: 'question',
        request: { questions: [{ id: 'q1', question: 'Which?' }] }
      })
    )
    await call('interaction.resolve', {
      interactionId: 'card',
      response: { q1: ['A', 7, ''], q2: 'not asked' }
    })
    expect(deps.resolveInteraction).toHaveBeenLastCalledWith({
      interactionId: 'card',
      response: { q1: ['A'] }
    })
    interactions.set(
      'sessions',
      interaction({ id: 'sessions', kind: 'question', request: { intent: 'start_sessions' } })
    )
    await expect(
      call('interaction.resolve', { interactionId: 'sessions', response: {} })
    ).rejects.toThrow(/on the computer/)
    interactions.set('done', interaction({ id: 'done', status: 'resolved' }))
    await expect(
      call('interaction.resolve', { interactionId: 'done', response: { decision: 'deny' } })
    ).rejects.toThrow(/already answered/)
  })

  it('opens a chat with reduced images, attachment names and the active run', async () => {
    const { call, db, chat, runs } = setup()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, images, attachments, timestamp)
       VALUES ('m1', ?, 'user', 'look', ?, ?, 1)`
    ).run(
      chat.id,
      JSON.stringify([
        {
          id: 'i1',
          name: 'shot.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
        }
      ]),
      JSON.stringify([{ id: 'a1', kind: 'text', name: 'notes.txt', content: 'secret body' }])
    )
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('m2', ?, 'agent', 'Here it is', 2)`
    ).run(chat.id)
    runs.set('run-1', run({ threadId: chat.id }))
    const detail = (await call('chat.open', { conversationId: chat.id })) as {
      messages: unknown[]
      run: { run: AgentRunSnapshot } | null
    }
    expect(detail.messages).toEqual([
      {
        id: 'm1',
        role: 'user',
        content: 'look',
        timestamp: 1,
        runMode: 'conversation',
        images: [expect.objectContaining({ id: 'i1', dataUrl: 'data:image/jpeg;base64,small' })],
        attachments: [{ id: 'a1', kind: 'text', name: 'notes.txt' }]
      },
      { id: 'm2', role: 'assistant', content: 'Here it is', timestamp: 2, runMode: 'conversation' }
    ])
    expect(detail.run?.run.id).toBe('run-1')
  })

  it('serves only images the artifact folder holds', async () => {
    const readArtifact = vi.fn(async (url: string) =>
      url === 'sidekick-browser://artifact/viewed-images/a.jpg'
        ? { data: Buffer.from('jpg'), contentType: 'image/jpeg' }
        : null
    )
    const { call } = setup({ readArtifact })
    expect(
      await call('media.get', { url: 'sidekick-browser://artifact/viewed-images/a.jpg' })
    ).toEqual({ dataUrl: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}` })
    await expect(call('media.get', { url: 'file:///C:/secret.png' })).rejects.toThrow()
  })

  function fakeVoice(): CompanionVoice & {
    heard: Map<string, number[]>
    writers: Map<string, (text: string, final: boolean) => void>
  } {
    const heard = new Map<string, number[]>()
    const writers = new Map<string, (text: string, final: boolean) => void>()
    return {
      heard,
      writers,
      state: () => ({ dictation: true, speech: true, message: null }),
      startDictation: vi.fn(async (id: string, onText: (text: string, final: boolean) => void) => {
        heard.set(id, [])
        writers.set(id, onText)
        return { ok: true }
      }),
      pushDictation: vi.fn((id: string, samples: Float32Array) => heard.get(id)?.push(...samples)),
      stopDictation: vi.fn(async (id: string) => writers.get(id)?.('the last words', true)),
      cancelDictation: vi.fn(),
      speak: vi.fn(async (_id, _text, onAudio, onEnd) => {
        onAudio(new Float32Array([0, 1, -1]), 24_000)
        onEnd()
        return { ok: true }
      }),
      stop: vi.fn()
    }
  }

  const pcm = (...samples: number[]): string => {
    const bytes = Buffer.alloc(samples.length * 2)
    samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2))
    return bytes.toString('base64')
  }

  it('dictates live: audio in order, words back as they come, the last before the end', async () => {
    const voice = fakeVoice()
    const { call, deps } = setup({ voice: () => voice })
    expect(await call('voice.dictation.start', { dictationId: 'd1' })).toEqual({ ok: true })
    const serviceId = vi.mocked(voice.startDictation).mock.calls[0][0]
    // The voice service knows the dictation by an ID of its own, not one the phone chose.
    expect(serviceId).toMatch(/^phone-/)
    expect(
      await call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(16_384, -32_768) })
    ).toEqual({ accepted: true })
    expect(await call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(0) })).toEqual({
      accepted: true
    })
    expect(voice.heard.get(serviceId)).toEqual([0.5, -1, 0])
    voice.writers.get(serviceId)!('hello', false)
    expect(deps.sendToDevice).toHaveBeenLastCalledWith(DEVICE, {
      type: 'dictation.text',
      dictationId: 'd1',
      text: 'hello',
      final: false
    })
    expect(await call('voice.dictation.stop', { dictationId: 'd1' })).toEqual({ stopped: true })
    const sent = vi.mocked(deps.sendToDevice).mock.calls.map(([, event]) => event)
    expect(sent.slice(-2)).toEqual([
      { type: 'dictation.text', dictationId: 'd1', text: 'the last words', final: true },
      { type: 'dictation.end', dictationId: 'd1' }
    ])
    // Once stopped it takes no more audio.
    expect(await call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(1) })).toEqual({
      accepted: false
    })
  })

  it('keeps each phone to its own dictation and refuses audio it cannot read', async () => {
    const voice = fakeVoice()
    const { call } = setup({ voice: () => voice })
    await call('voice.dictation.start', { dictationId: 'd1' })
    const serviceId = vi.mocked(voice.startDictation).mock.calls[0][0]
    expect(
      await call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(1) }, 'device-2')
    ).toEqual({ accepted: false })
    await call('voice.dictation.cancel', { dictationId: 'd1' }, 'device-2')
    expect(voice.cancelDictation).not.toHaveBeenCalled()
    await expect(
      call('voice.dictation.audio', { dictationId: 'd1', pcm: Buffer.from([1]).toString('base64') })
    ).rejects.toThrow(/could not be read/)
    await expect(
      call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(...new Array(32_001).fill(1)) })
    ).rejects.toThrow(/could not be read/)
    await expect(call('voice.dictation.start', { dictationId: '../d' })).rejects.toThrow()
    await expect(call('voice.dictation.start', { dictationId: 'd1' })).rejects.toThrow(/already/)
    expect(voice.heard.get(serviceId)).toEqual([])
    await call('voice.dictation.cancel', { dictationId: 'd1' })
    expect(voice.cancelDictation).toHaveBeenCalledWith(serviceId)
  })

  it('ends a dictation the phone stopped sending audio to, keeping what was heard', async () => {
    vi.useFakeTimers()
    try {
      const voice = fakeVoice()
      const { call, deps } = setup({ voice: () => voice })
      await call('voice.dictation.start', { dictationId: 'd1' })
      await vi.advanceTimersByTimeAsync(10_000)
      await call('voice.dictation.audio', { dictationId: 'd1', pcm: pcm(1) })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(voice.stopDictation).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(6_000)
      expect(voice.stopDictation).toHaveBeenCalledTimes(1)
      expect(deps.sendToDevice).toHaveBeenLastCalledWith(DEVICE, {
        type: 'dictation.end',
        dictationId: 'd1'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('speaks to the phone that asked', async () => {
    const voice = fakeVoice()
    const { call, deps } = setup({ voice: () => voice })
    expect(await call('voice.speak', { speechId: 's1', text: 'Hello' })).toEqual({ ok: true })
    expect(deps.sendToDevice).toHaveBeenCalledWith(DEVICE, {
      type: 'speech.audio',
      speechId: 's1',
      sampleRate: 24_000,
      pcm: pcm16Base64(new Float32Array([0, 1, -1]))
    })
    expect(deps.sendToDevice).toHaveBeenCalledWith(DEVICE, { type: 'speech.end', speechId: 's1' })
    await call('voice.stop', { speechId: 's1' }, 'device-2')
    expect(voice.stop).not.toHaveBeenCalled()
  })

  it('says voice is unavailable when the computer has none', async () => {
    const { call } = setup()
    expect(await call('voice.state', {})).toEqual({
      dictation: false,
      speech: false,
      message: null
    })
    expect(await call('voice.speak', { speechId: 's1', text: 'hi' })).toMatchObject({ ok: false })
    expect(await call('voice.dictation.start', { dictationId: 'd1' })).toMatchObject({ ok: false })
  })

  it('encodes speech as 16-bit samples', () => {
    const bytes = Buffer.from(pcm16Base64(new Float32Array([0, 1, -1, 2])), 'base64')
    expect([0, 1, 2, 3].map((index) => bytes.readInt16LE(index * 2))).toEqual([
      0, 32767, -32768, 32767
    ])
  })

  it('cuts long text and drops inline images when trimming for the phone', () => {
    expect(
      trimForPhone({
        text: 'x'.repeat(5_000),
        screenshot: { url: 'a' },
        preview: 'data:image/png;base64,AAAA',
        previewUrl: 'sidekick-browser://artifact/viewed-images/a.jpg',
        nested: [{ images: [1] }]
      })
    ).toEqual({
      text: `${'x'.repeat(4_000)}… (shortened)`,
      previewUrl: 'sidekick-browser://artifact/viewed-images/a.jpg',
      nested: [{}]
    })
  })
})
