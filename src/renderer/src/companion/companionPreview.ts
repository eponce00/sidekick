import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunPhase,
  AgentRunSnapshot
} from '../../../shared/agentRuntime'
import type {
  CompanionCallName,
  CompanionCalls,
  CompanionChat,
  CompanionEvent,
  CompanionMessage
} from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import type { StoredDevice } from './companionClient'

/**
 * A pretend computer for `?preview=1`, so the phone's screens can be checked without pairing:
 * one chat streams a reply, others wait on a permission, a question and a plan.
 */

export const PREVIEW_DEVICE: StoredDevice = {
  deviceId: 'preview',
  deviceSecret: '',
  name: 'Preview phone · Browser',
  pairedAt: Date.now()
}

interface PreviewRun {
  snapshot: AgentRunSnapshot
  events: AgentRunEvent[]
}

const MINUTE = 60_000
const STREAMED_REPLY =
  'The upload test fails about one run in ten. The fixture server closes the socket before the ' +
  'client reads the last chunk, so the retry path sees a partial body.\n\n' +
  "I'll make the fixture wait for the client to finish reading, then run the test **50 times** " +
  'to check it holds:\n\n```sh\nnpm test -- upload --repeat 50\n```\n'

type Output<Name extends CompanionCallName> = CompanionCalls[Name]['output']
type Input<Name extends CompanionCallName> = CompanionCalls[Name]['input']

export class CompanionPreview implements CompanionConnection {
  private chats: CompanionChat[]
  private messages = new Map<string, CompanionMessage[]>()
  private runs = new Map<string, PreviewRun>()
  private onEvent: ((event: CompanionEvent) => void) | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private nextId = 1
  private uploadPlaying = false

  constructor(now = Date.now()) {
    this.chats = [
      chat('weekly', 'Weekly report draft', now - 2 * 60 * MINUTE, 'notes', { pinned: true }),
      chat('upload', 'Fix the flaky upload test', now - 20_000, 'sidekick', {
        activePhase: 'executing_tool'
      }),
      chat('downloads', 'Clean up the Downloads folder', now - 5 * MINUTE, null, {
        activePhase: 'awaiting_permission',
        needsAnswer: true
      }),
      chat('trip', 'Plan the Lisbon trip', now - 25 * MINUTE, null, {
        activePhase: 'awaiting_user',
        needsAnswer: true
      }),
      chat('settings', 'Refactor the settings page', now - 70 * MINUTE, 'sidekick', {
        activePhase: 'awaiting_user',
        needsAnswer: true
      }),
      chat('release', 'Explain the release process', now - 3 * 24 * 60 * MINUTE, 'sidekick')
    ]
    this.seed(now)
  }

  private seed(now: number): void {
    this.messages.set('weekly', [
      message('w1', 'user', 'Draft this week’s report from my notes.', now - 2 * 60 * MINUTE, {
        imageCount: 1
      }),
      message('w2', 'assistant', '', now - 2 * 60 * MINUTE + 30_000, {
        segments: [
          { type: 'thinking', content: 'The notes file has three sections; summarize each.' },
          {
            type: 'tool',
            tool: {
              id: 't1',
              callId: 't1',
              title: 'Read notes/week-42.md',
              command: 'read_file',
              name: 'read_file',
              input: { path: 'notes/week-42.md' },
              status: 'success',
              output: '# Week 42\n- Shipped 0.18.2\n- Phone companion design review'
            }
          },
          {
            type: 'text',
            content:
              'Here is the draft:\n\n## Week 42\n\n| Area | Status |\n| --- | --- |\n| Release 0.18.2 | Shipped |\n| Phone companion | In review |\n\nSee the [release notes](https://github.com/eponce00/sidekick/releases) for details.'
          }
        ]
      }),
      message('w3', 'system', 'Model changed to a local model.', now - 2 * 60 * MINUTE + 60_000)
    ])
    this.messages.set('release', [
      message('r1', 'user', 'How do releases work?', now - 3 * 24 * 60 * MINUTE),
      message(
        'r2',
        'assistant',
        'A release is a squashed merge to `main` and an annotated tag. CI builds each installer and attests it.',
        now - 3 * 24 * 60 * MINUTE + 20_000
      )
    ])
    this.messages.set('upload', [
      message('u1', 'user', 'The upload test is flaky again. Can you fix it?', now - 60_000)
    ])
    this.messages.set('downloads', [
      message('d1', 'user', 'Delete the old installers in Downloads.', now - 6 * MINUTE)
    ])
    this.messages.set('trip', [
      message('p1', 'user', 'Help me plan three days in Lisbon.', now - 26 * MINUTE)
    ])
    this.messages.set('settings', [
      message('s1', 'user', 'Split the settings page into smaller components.', now - 71 * MINUTE)
    ])

    const upload = this.startRun('upload', now - 50_000)
    this.append(upload, 'run.phase', { phase: 'streaming' })
    this.append(upload, 'assistant.delta', { content: "I'll run the test a few times first." })
    this.append(upload, 'tool.pending', {
      toolCallId: 'call-test',
      name: 'run_command',
      arguments: { command: 'npm test -- upload --repeat 20' }
    })
    this.append(upload, 'assistant.completed', {
      content: "I'll run the test a few times first.",
      toolCalls: [{ id: 'call-test' }]
    })
    this.append(upload, 'tool.running', {
      toolCallId: 'call-test',
      title: 'Run npm test -- upload --repeat 20'
    })
    this.append(upload, 'run.phase', { phase: 'executing_tool' })

    const downloads = this.startRun('downloads', now - 5 * MINUTE)
    this.append(downloads, 'tool.pending', {
      toolCallId: 'call-delete',
      name: 'delete_files',
      arguments: { paths: ['~/Downloads/SideKick-0.16.0.exe', '~/Downloads/SideKick-0.17.1.exe'] }
    })
    this.append(downloads, 'assistant.completed', {
      content: 'I found two old installers.',
      toolCalls: [{ id: 'call-delete' }]
    })
    this.append(downloads, 'run.phase', { phase: 'awaiting_permission' })
    this.append(downloads, 'permission.requested', {
      interactionId: 'ask-delete',
      request: {
        toolCallId: 'call-delete',
        title: 'Delete 2 files in Downloads',
        chatScope: 'deleting files',
        arguments: {
          paths: ['~/Downloads/SideKick-0.16.0.exe', '~/Downloads/SideKick-0.17.1.exe']
        }
      }
    })

    const trip = this.startRun('trip', now - 25 * MINUTE)
    this.append(trip, 'assistant.completed', { content: 'A couple of questions first.' })
    this.append(trip, 'run.phase', { phase: 'awaiting_user' })
    this.append(trip, 'question.requested', {
      interactionId: 'ask-trip',
      kind: 'question',
      request: {
        questions: [
          {
            id: 'pace',
            header: 'Pace',
            question: 'How full should each day be?',
            options: [
              {
                label: 'Relaxed',
                description: 'Two sights a day, long lunches',
                recommended: true
              },
              { label: 'Packed', description: 'See as much as possible' }
            ]
          },
          {
            id: 'interests',
            header: 'Interests',
            question: 'What do you want to see?',
            multiSelect: true,
            options: [
              { label: 'Museums' },
              { label: 'Food markets' },
              { label: 'Viewpoints' },
              { label: 'Beaches' }
            ]
          }
        ]
      }
    })

    const settings = this.startRun('settings', now - 70 * MINUTE)
    this.append(settings, 'run.phase', { phase: 'awaiting_user' })
    this.append(settings, 'question.requested', {
      interactionId: 'ask-plan',
      kind: 'plan_approval',
      request: {
        stage: 'review',
        revision: 'r1',
        contract: {
          title: 'Split the settings page',
          summary: 'Move each settings section into its own component and keep one store.',
          steps: [
            { title: 'Extract the provider section' },
            { title: 'Extract the appearance section' },
            { title: 'Share one settings store' },
            { title: 'Update the settings tests' }
          ]
        }
      }
    })
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  private startRun(conversationId: string, timestamp = Date.now()): PreviewRun {
    const id = this.id('run')
    const run: PreviewRun = {
      snapshot: {
        id,
        threadId: conversationId,
        surface: 'conversation',
        executionMode: 'act',
        phase: 'queued',
        provider: 'preview',
        model: 'preview',
        lastSequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp
      },
      events: []
    }
    this.runs.set(conversationId, run)
    this.append(run, 'run.started', { threadId: conversationId }, timestamp)
    return run
  }

  private append(
    run: PreviewRun,
    type: AgentRunEventType,
    payload: Record<string, unknown>,
    timestamp = Date.now()
  ): AgentRunEvent {
    const event: AgentRunEvent = {
      id: `${run.snapshot.id}:${run.snapshot.lastSequence + 1}`,
      runId: run.snapshot.id,
      sequence: run.snapshot.lastSequence + 1,
      type,
      timestamp,
      payload
    }
    run.events.push(event)
    run.snapshot.lastSequence = event.sequence
    run.snapshot.updatedAt = timestamp
    if (type === 'run.phase' || type === 'run.completed')
      run.snapshot.phase = payload.phase as AgentRunPhase
    return event
  }

  /** Appends an event and pushes it to the phone, as the computer would. */
  private emit(run: PreviewRun, type: AgentRunEventType, payload: Record<string, unknown>): void {
    const event = this.append(run, type, payload)
    this.onEvent?.({ type: 'run.event', event })
  }

  private later(delay: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
    }, delay)
    this.timers.add(timer)
  }

  private updateChat(id: string, change: Partial<CompanionChat>): void {
    this.chats = this.chats.map((item) =>
      item.id === id ? { ...item, updatedAt: Date.now(), ...change } : item
    )
    this.onEvent?.({ type: 'chats.changed' })
  }

  /** Streams text in small pieces, then calls `done`. */
  private stream(run: PreviewRun, text: string, done: () => void): void {
    const pieces = text.match(/\S+\s*/g) ?? []
    const next = (index: number): void => {
      if (this.runs.get(run.snapshot.threadId) !== run) return
      if (index >= pieces.length) {
        done()
        return
      }
      this.emit(run, 'assistant.delta', { content: pieces.slice(index, index + 2).join('') })
      this.later(220, () => next(index + 2))
    }
    next(0)
  }

  private finish(conversationId: string, phase: AgentRunPhase = 'completed'): void {
    const run = this.runs.get(conversationId)
    if (!run) return
    this.emit(run, 'run.completed', { phase })
    const projected = projectAgentRunEvents(run.events)
    this.runs.delete(conversationId)
    const saved = this.messages.get(conversationId) ?? []
    saved.push(
      message(this.id('m'), 'assistant', projected.content, Date.now(), {
        segments: projected.segments,
        runId: run.snapshot.id
      })
    )
    this.messages.set(conversationId, saved)
    this.emit(run, 'run.finalized', {})
    this.updateChat(conversationId, { activePhase: null, needsAnswer: false })
  }

  /** A short answer after a card is answered or a message arrives. */
  private reply(conversationId: string, text: string): void {
    const run = this.runs.get(conversationId)
    if (!run) return
    this.emit(run, 'run.phase', { phase: 'streaming' })
    this.updateChat(conversationId, { activePhase: 'streaming', needsAnswer: false })
    this.stream(run, text, () => {
      this.emit(run, 'assistant.completed', {})
      this.finish(conversationId)
    })
  }

  // Plays the rest of the running chat once it is opened, so its streaming can be watched.
  private playUploadRun(): void {
    const run = this.runs.get('upload')
    if (!run || this.uploadPlaying) return
    this.uploadPlaying = true
    this.later(2_500, () => {
      if (this.runs.get('upload') !== run) return
      this.emit(run, 'tool.completed', {
        toolCallId: 'call-test',
        result: {
          status: 'success',
          title: 'Ran npm test -- upload --repeat 20',
          modelContent: '18 passed, 2 failed (socket closed early)',
          timing: { startedAt: Date.now() - 2_500, completedAt: Date.now() }
        }
      })
      this.emit(run, 'run.phase', { phase: 'streaming' })
      this.updateChat('upload', { activePhase: 'streaming' })
      this.stream(run, STREAMED_REPLY, () => {
        this.emit(run, 'assistant.completed', {})
        this.finish('upload')
      })
    })
  }

  async call<Name extends CompanionCallName>(
    name: Name,
    input: Input<Name>
  ): Promise<Output<Name>> {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return this.handle(name, input) as Output<Name>
  }

  private handle(name: CompanionCallName, input: unknown): unknown {
    switch (name) {
      case 'chats.list':
        return [...this.chats].sort(
          (left, right) =>
            Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt
        )
      case 'chat.open': {
        const { conversationId } = input as Input<'chat.open'>
        const found = this.chats.find((item) => item.id === conversationId)
        if (!found) throw new Error('This chat no longer exists.')
        const run = this.runs.get(conversationId)
        if (conversationId === 'upload') this.playUploadRun()
        return {
          chat: found,
          messages: [...(this.messages.get(conversationId) ?? [])],
          run: run ? { run: { ...run.snapshot }, events: [...run.events] } : null
        } satisfies Output<'chat.open'>
      }
      case 'chat.send':
        return this.send(input as Input<'chat.send'>)
      case 'run.stop': {
        const { runId } = input as Input<'run.stop'>
        const entry = [...this.runs.entries()].find(([, run]) => run.snapshot.id === runId)
        if (!entry) return { stopped: false }
        this.finish(entry[0], 'cancelled')
        return { stopped: true }
      }
      case 'run.events': {
        const { runId, afterSequence } = input as Input<'run.events'>
        const run = [...this.runs.values()].find((item) => item.snapshot.id === runId)
        if (!run) throw new Error('This run has finished.')
        return {
          run: { ...run.snapshot },
          events: run.events.filter((event) => event.sequence > afterSequence)
        }
      }
      case 'interaction.resolve':
        return this.resolve(input as Input<'interaction.resolve'>)
      case 'events.ticket':
        return { ticket: 'preview' }
    }
  }

  private send({ conversationId, text }: Input<'chat.send'>): Output<'chat.send'> {
    let id = conversationId
    if (!id) {
      id = this.id('chat')
      this.chats.push(chat(id, text.slice(0, 40), Date.now(), null))
    }
    const run = this.runs.get(id)
    if (run) {
      this.emit(run, 'run.steered', { content: text, messageId: this.id('steer') })
      return { conversationId: id, runId: run.snapshot.id, steered: true }
    }
    const saved = this.messages.get(id) ?? []
    saved.push(message(this.id('m'), 'user', text, Date.now()))
    this.messages.set(id, saved)
    const started = this.startRun(id)
    this.onEvent?.({ type: 'run.event', event: started.events[0] })
    this.updateChat(id, { activePhase: 'streaming' })
    this.later(400, () =>
      this.reply(id, `This is a preview, so nothing ran on a computer. You said: “${text}”`)
    )
    return { conversationId: id, runId: started.snapshot.id, steered: false }
  }

  private resolve({
    interactionId,
    response,
    cancelled
  }: Input<'interaction.resolve'>): Output<'interaction.resolve'> {
    const entry = [...this.runs.entries()].find(([, run]) =>
      run.events.some((event) => event.payload.interactionId === interactionId)
    )
    if (!entry) throw new Error('This card was already answered.')
    const [conversationId, run] = entry
    const asked = run.events.find((event) => event.payload.interactionId === interactionId)!
    const status = cancelled ? 'cancelled' : 'resolved'
    this.later(600, () => {
      if (asked.type === 'permission.requested') {
        this.emit(run, 'permission.resolved', { interactionId, status, response })
        if (response.decision === 'deny_stop') {
          this.finish(conversationId, 'cancelled')
          return
        }
        this.reply(
          conversationId,
          response.approved ? 'Done: both installers are gone.' : 'Left them alone.'
        )
        return
      }
      this.emit(run, 'question.resolved', {
        interactionId,
        kind: asked.payload.kind,
        status,
        response
      })
      this.reply(conversationId, 'Thanks, carrying on with that.')
    })
    return { success: true }
  }

  listen(onEvent: (event: CompanionEvent) => void, onConnection: (open: boolean) => void): void {
    this.onEvent = onEvent
    this.later(300, () => onConnection(true))
  }

  close(): void {
    this.onEvent = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}

function chat(
  id: string,
  title: string,
  updatedAt: number,
  projectName: string | null,
  extra: Partial<CompanionChat> = {}
): CompanionChat {
  return {
    id,
    title,
    updatedAt,
    pinned: false,
    projectName,
    activePhase: null,
    needsAnswer: false,
    ...extra
  }
}

function message(
  id: string,
  role: string,
  content: string,
  timestamp: number,
  extra: Partial<CompanionMessage> = {}
): CompanionMessage {
  return { id, role, content, timestamp, ...extra }
}
