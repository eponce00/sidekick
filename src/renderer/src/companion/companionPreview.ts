import { projectAgentRunEvents } from '../../../shared/agentEventProjection'
import type {
  ConversationRunMode,
  PromptAdmissionItem,
  PromptAdmissionsResult
} from '../../../shared/agentRunApi'
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
  CompanionImage,
  CompanionMessage,
  CompanionModel
} from '../../../shared/companion'
import { base64ToBytes, bytesToBase64 } from './audio'
import { isActivePhase, type CompanionConnection } from './chatState'
import type { StoredDevice } from './companionClient'

/**
 * A pretend computer for `?preview=1`, so every phone screen can be seen and tried without
 * pairing: a tour chat with the desktop's rich replies, a reply that streams, a run that keeps
 * working with a queue and a sub-agent, and chats waiting on a permission, a question and a plan.
 * Uploads, images, models, dictation and read aloud answer with canned data.
 *
 * `&state=` shows another screen: `home` (the new-chat home, also the default), `start`, `pairing`
 * and `denied` before pairing, `empty` for a computer with no chats, and `reconnecting` for a
 * stream that drops after it opens. `&drawer=1` opens the chat drawer.
 */

export type PreviewState = 'home' | 'start' | 'pairing' | 'denied' | 'empty' | 'reconnecting'

const PREVIEW_STATES: readonly PreviewState[] = [
  'home',
  'start',
  'pairing',
  'denied',
  'empty',
  'reconnecting'
]

export function previewState(value: string | null): PreviewState | null {
  return PREVIEW_STATES.find((state) => state === value) ?? null
}

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

interface PreviewUpload {
  kind: CompanionCalls['upload.put']['input']['kind']
  name: string
  mimeType: string
  pieces: Uint8Array[]
  complete: boolean
}

const MINUTE = 60_000
const STREAMED_REPLY =
  'The upload test fails about one run in ten. The fixture server closes the socket before the ' +
  'client reads the last chunk, so the retry path sees a partial body.\n\n' +
  "I'll make the fixture wait for the client to finish reading, then run the test **50 times** " +
  'to check it holds:\n\n```sh\nnpm test -- upload --repeat 50\n```\n'

const MODELS: CompanionModel[] = [
  { id: 'sonnet', name: 'Claude Sonnet', supportsVision: true },
  { id: 'qwen-local', name: 'Qwen3 Coder 30B · local', supportsVision: false },
  { id: 'gpt-mini', name: 'GPT-5 mini', supportsVision: true }
]

/** A made-up screenshot, drawn as SVG so the preview needs no image files. */
function sketch(label: string, hue: number, width = 640, height = 400): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="hsl(${hue} 30% 92%)"/>
<rect x="24" y="24" width="${width - 48}" height="44" rx="10" fill="hsl(${hue} 45% 55%)"/>
<rect x="24" y="92" width="${width * 0.55}" height="18" rx="6" fill="hsl(${hue} 15% 70%)"/>
<rect x="24" y="124" width="${width * 0.4}" height="18" rx="6" fill="hsl(${hue} 15% 75%)"/>
<rect x="${width - 214}" y="${height - 84}" width="190" height="52" rx="12" fill="hsl(${hue} 70% 45%)"/>
<text x="${width - 119}" y="${height - 51}" font-family="sans-serif" font-size="20" fill="white" text-anchor="middle">Upl…</text>
<text x="24" y="${height - 48}" font-family="sans-serif" font-size="22" fill="hsl(${hue} 30% 30%)">${label}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const TOUR_REPLY = `The button is cut off because its row is a flex container whose label cannot shrink: \`min-width\` defaults to \`auto\`, so the text pushes the button past the edge.

### The fix

\`\`\`tsx
export function UploadButton({ label }: { label: string }) {
  return (
    <button className="upload-button">
      <UploadIcon aria-hidden="true" />
      <span className="upload-button-label">{label}</span>
    </button>
  )
}
\`\`\`

\`\`\`css
.upload-button-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
\`\`\`

| Width | Before | After |
| --- | --- | --- |
| 320 px | Cut off | Ellipsis |
| 375 px | Cut off | Fits |
| 768 px | Fits | Fits |

The label needs about $w = 16 + 8 + n \\cdot 7.5$ pixels for $n$ characters, so at the smallest width

$$
w_{\\max} = 320 - 2 \\cdot 16 = 288 \\Rightarrow n \\le 35
$$

It works now 🎉 — see the [flexbox notes](https://developer.mozilla.org/en-US/docs/Web/CSS/min-width) for why.`

const TERMINAL_OUTPUT =
  '\u001b[1m> sidekick@0.18.2 test\u001b[22m\n' +
  '\u001b[32m ✓\u001b[39m uploads a small file \u001b[2m(12 ms)\u001b[22m\n' +
  '\u001b[32m ✓\u001b[39m resumes after a dropped chunk \u001b[2m(48 ms)\u001b[22m\n' +
  '\u001b[31m ✗\u001b[39m shows the whole button at 320 px\n' +
  '   Expected label width ≤ 288, received 312\n\n' +
  ' Tests  \u001b[31m1 failed\u001b[39m | \u001b[32m2 passed\u001b[39m (3)\n'

const DIFF = `--- a/src/upload/UploadButton.css
+++ b/src/upload/UploadButton.css
@@ -4,7 +4,10 @@
 .upload-button {
   display: inline-flex;
   align-items: center;
   gap: 8px;
+  max-width: 100%;
 }
 .upload-button-label {
-  white-space: nowrap;
+  min-width: 0;
+  overflow: hidden;
+  text-overflow: ellipsis;
 }
`

/** What the pretend dictation writes. */
const DICTATED = 'Also check the retry logic in the upload client.'

type Output<Name extends CompanionCallName> = CompanionCalls[Name]['output']
type Input<Name extends CompanionCallName> = CompanionCalls[Name]['input']

export class CompanionPreview implements CompanionConnection {
  private chats: CompanionChat[]
  private messages = new Map<string, CompanionMessage[]>()
  /** The latest run of each chat. */
  private runs = new Map<string, PreviewRun>()
  /** Sub-agents' runs, by id. */
  private childRuns = new Map<string, PreviewRun>()
  private queues = new Map<string, PromptAdmissionsResult>()
  private chatModels = new Map<string, string>()
  private uploads = new Map<string, PreviewUpload>()
  private speeches = new Map<string, Set<ReturnType<typeof setTimeout>>>()
  /** Seconds of microphone each dictation has sent. */
  private dictations = new Map<string, number>()
  private onEvent: ((event: CompanionEvent) => void) | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private nextId = 1
  private uploadPlaying = false
  private readonly drops: boolean

  constructor(now = Date.now(), options: { empty?: boolean; drops?: boolean } = {}) {
    this.drops = Boolean(options.drops)
    this.chats = [
      chat('tour', 'Tour of the phone view', now - 90_000, 'sidekick', { pinned: true }),
      chat('upload', 'Fix the flaky upload test', now - 20_000, 'sidekick', {
        activePhase: 'executing_tool'
      }),
      chat('build', 'Watch the release build', now - 4 * MINUTE, 'sidekick', {
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
      chat('pricing', 'Update the pricing page copy', now - 95 * MINUTE, 'website'),
      chat('weekly', 'Weekly report draft', now - 2 * 60 * MINUTE, 'notes'),
      chat('shoes', 'Compare trail running shoes under $150', now - 5 * 60 * MINUTE, null),
      chat('footer', 'Fix the broken footer links', now - 26 * 60 * MINUTE, 'website'),
      chat('release', 'Explain the release process', now - 3 * 24 * 60 * MINUTE, 'sidekick')
    ]
    if (options.empty) this.chats = []
    this.seed(now)
  }

  private seed(now: number): void {
    this.seedTour(now)
    this.messages.set('weekly', [
      message('w1', 'user', 'Draft this week’s report from my notes.', now - 2 * 60 * MINUTE),
      message('w2', 'assistant', '', now - 2 * 60 * MINUTE + 30_000, {
        segments: [
          { type: 'thinking', content: 'The notes file has three sections; summarize each.' },
          tool('t1', 'read_file', 'Read notes/week-42.md', {
            input: { path: 'notes/week-42.md' },
            presentation: { kind: 'read', title: 'Read week-42.md', subject: 'notes/week-42.md' },
            output: '# Week 42\n- Shipped 0.18.2\n- Phone companion design review',
            data: {
              content: '1: # Week 42\n2: - Shipped 0.18.2\n3: - Phone companion design review',
              startLine: 1,
              endLine: 3,
              totalLines: 3
            }
          }),
          {
            type: 'text',
            content:
              'Here is the draft:\n\n## Week 42\n\n| Area | Status |\n| --- | --- |\n| Release 0.18.2 | Shipped |\n| Phone companion | In review |'
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
    this.messages.set('build', [
      message(
        'b1',
        'user',
        'Watch the release build and tell me if anything fails.',
        now - 5 * MINUTE
      )
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
      arguments: { command: 'npm test -- upload --repeat 20' },
      presentation: { kind: 'terminal', title: 'Run npm test -- upload --repeat 20' }
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

    this.seedBuild(now)

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

  /** One chat with every kind of reply part the desktop draws. */
  private seedTour(now: number): void {
    const at = now - 30 * MINUTE
    this.messages.set('tour', [
      message('t-u1', 'user', 'Here’s the failing screen. Why is the upload button cut off?', at, {
        images: [image('shot', 'upload-screen.png', sketch('Narrow phone, 320 px', 210))],
        attachments: [{ id: 'log', kind: 'text', name: 'upload-test.log' }]
      }),
      message('t-a1', 'assistant', TOUR_REPLY, at + 40_000, {
        segments: [
          {
            type: 'thinking',
            content:
              'The screenshot shows the label overflowing. Check the component and its CSS, then run the narrow-screen test.'
          },
          tool('t-read', 'read_file', 'Read UploadButton.tsx', {
            input: { path: 'src/upload/UploadButton.tsx' },
            presentation: {
              kind: 'read',
              title: 'Read UploadButton.tsx',
              subject: 'src/upload/UploadButton.tsx'
            },
            output:
              '1: export function UploadButton({ label }: { label: string }) {\n2:   return <button className="upload-button">{label}</button>\n3: }',
            data: {
              content:
                '1: export function UploadButton({ label }: { label: string }) {\n2:   return <button className="upload-button">{label}</button>\n3: }',
              path: 'src/upload/UploadButton.tsx',
              startLine: 1,
              endLine: 3,
              totalLines: 3
            }
          }),
          tool('t-view', 'view_image', 'Viewed upload-screen.png', {
            input: { path: 'upload-screen.png' },
            presentation: {
              kind: 'generic',
              title: 'Viewed upload-screen.png',
              subject: 'upload-screen.png'
            },
            output: 'Image, 640 × 400',
            data: { previewUrl: 'sidekick-browser://artifact/preview-viewed-image' }
          }),
          tool('t-test', 'run_command', 'Ran npm test -- upload', {
            input: { command: 'npm test -- upload' },
            presentation: { kind: 'terminal', title: 'Ran npm test -- upload' },
            status: 'error',
            error: 'Exited with code 1',
            data: {
              success: false,
              exitCode: 1,
              stdout: TERMINAL_OUTPUT,
              stderr: '',
              terminal: true
            }
          }),
          tool('t-search', 'web_search', 'Searched the web for flex min-width', {
            input: { query: 'css flex item min-width auto overflow' },
            presentation: {
              kind: 'search',
              title: 'Searched the web',
              subject: 'css flex item min-width auto overflow'
            },
            output: '2 results',
            data: {
              results: [
                {
                  title: 'min-width - CSS | MDN',
                  url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/min-width',
                  description: 'The initial value for flex items is auto.'
                },
                {
                  title: 'Flexbox and truncated text',
                  url: 'https://css-tricks.com/flexbox-truncated-text/',
                  description: 'Why min-width: 0 lets a flex child shrink.'
                }
              ]
            }
          }),
          tool('t-edit', 'edit_file', 'Edited UploadButton.css', {
            input: { path: 'src/upload/UploadButton.css' },
            presentation: {
              kind: 'diff',
              title: 'Edited UploadButton.css',
              subject: 'src/upload/UploadButton.css'
            },
            output: DIFF,
            data: { diff: DIFF },
            changes: [{ path: 'src/upload/UploadButton.css', kind: 'update' }]
          }),
          { type: 'text', content: TOUR_REPLY }
        ]
      }),
      message(
        't-u2',
        'user',
        'Check the other buttons too, and research how others do it.',
        at + 5 * MINUTE,
        {
          runMode: 'research'
        }
      ),
      message('t-a2', 'assistant', '', at + 9 * MINUTE, {
        runMode: 'research',
        segments: [
          tool('t-sub', 'spawn_subagent', 'Checked every button', {
            input: { description: 'Check every button for the same overflow' },
            presentation: { kind: 'subagent', title: 'Check every button for the same overflow' },
            data: {
              status: 'completed',
              content: 'Found the same overflow in 3 buttons: Share, Export and Retry.',
              toolCalls: 7,
              durationMs: 48_000
            }
          }),
          {
            type: 'steer',
            steer: {
              id: 'steer-1',
              content: 'Skip the Retry button, it is being removed.',
              timestamp: at + 6 * MINUTE
            }
          },
          {
            type: 'run_status',
            status: { kind: 'retrying', reason: 'stream_dropped', timestamp: at + 7 * MINUTE }
          },
          {
            type: 'text',
            content:
              'I fixed **Share** and **Export** the same way and left Retry alone.\n\nMost design systems truncate labels with an ellipsis and show the full text on long press ([Material](https://m3.material.io/components/buttons/guidelines), [Apple](https://developer.apple.com/design/human-interface-guidelines/buttons)).'
          },
          {
            type: 'artifact',
            artifact: {
              type: 'html',
              title: 'Button widths at a glance',
              code: '<table><tr><td>Share</td><td>Fits</td></tr></table>',
              isStreaming: false
            }
          }
        ]
      }),
      message(
        't-s1',
        'system',
        'Earlier messages were summarized to save space.',
        at + 10 * MINUTE
      ),
      message('t-u3', 'user', 'Try it on the tablet layout as well.', at + 12 * MINUTE),
      message('t-a3', 'assistant', '', at + 13 * MINUTE, {
        segments: [
          { type: 'text', content: 'Checking the tablet layout now.' },
          {
            type: 'run_error',
            runError: {
              code: 'timeout',
              message: 'The model server did not answer within 60 seconds.',
              retryable: true
            }
          }
        ]
      })
    ])
  }

  /** A run that keeps working, with a sub-agent and messages queued behind it. */
  private seedBuild(now: number): void {
    const build = this.startRun('build', now - 4 * MINUTE)
    this.append(build, 'run.phase', { phase: 'streaming' })
    const intro =
      "I'll watch the CI build, and have a sub-agent look through recent failures meanwhile."
    this.append(build, 'assistant.delta', { content: intro })
    this.append(build, 'tool.pending', {
      toolCallId: 'call-watch',
      name: 'run_command',
      arguments: { command: 'gh run watch 4821' },
      presentation: { kind: 'terminal', title: 'Run gh run watch 4821' }
    })
    this.append(build, 'tool.pending', {
      toolCallId: 'call-history',
      name: 'spawn_subagent',
      arguments: {
        description: 'Look through the last 20 CI runs for failures',
        task: 'Look through the last 20 CI runs for failures.'
      },
      presentation: { kind: 'subagent', title: 'Look through the last 20 CI runs for failures' }
    })
    this.append(build, 'assistant.completed', {
      content: intro,
      toolCalls: [{ id: 'call-watch' }, { id: 'call-history' }]
    })
    this.append(build, 'tool.running', { toolCallId: 'call-watch', title: 'Run gh run watch 4821' })
    this.append(build, 'tool.running', {
      toolCallId: 'call-history',
      title: 'Look through the last 20 CI runs for failures'
    })
    const child = this.childRun('build', build.snapshot.id, now - 3 * MINUTE)
    this.append(build, 'subagent.started', {
      toolCallId: 'call-history',
      childRunId: child.snapshot.id
    })
    this.append(build, 'run.phase', { phase: 'executing_tool' })

    this.append(child, 'run.phase', { phase: 'streaming' })
    this.append(child, 'tool.pending', {
      toolCallId: 'child-list',
      name: 'run_command',
      arguments: { command: 'gh run list --limit 20' },
      presentation: { kind: 'terminal', title: 'Run gh run list --limit 20' }
    })
    this.append(child, 'assistant.completed', { content: '', toolCalls: [{ id: 'child-list' }] })
    this.append(child, 'tool.running', {
      toolCallId: 'child-list',
      title: 'Run gh run list --limit 20'
    })
    this.append(child, 'run.phase', { phase: 'executing_tool' })

    this.queues.set('build', {
      pivot: null,
      queued: [
        admission('q1', 'build', 'If it fails, open an issue with the log.', now - 2 * MINUTE),
        admission('q2', 'build', 'Then start the macOS notarization check.', now - MINUTE)
      ]
    })
  }

  private id(prefix: string): string {
    return `${prefix}-${this.nextId++}`
  }

  private newRun(threadId: string, timestamp: number, surface: AgentRunSnapshot['surface']) {
    const id = this.id('run')
    const run: PreviewRun = {
      snapshot: {
        id,
        threadId,
        surface,
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
    return run
  }

  private startRun(conversationId: string, timestamp = Date.now()): PreviewRun {
    const run = this.newRun(conversationId, timestamp, 'conversation')
    this.runs.set(conversationId, run)
    this.append(run, 'run.started', { threadId: conversationId }, timestamp)
    return run
  }

  private childRun(conversationId: string, parentRunId: string, timestamp: number): PreviewRun {
    const run = this.newRun(conversationId, timestamp, 'subagent')
    this.childRuns.set(run.snapshot.id, run)
    this.append(run, 'run.started', { threadId: conversationId, parentRunId }, timestamp)
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

  private later(delay: number, action: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
    }, delay)
    this.timers.add(timer)
    return timer
  }

  private updateChat(id: string, change: Partial<CompanionChat>): void {
    this.chats = this.chats.map((item) =>
      item.id === id ? { ...item, updatedAt: Date.now(), ...change } : item
    )
    this.onEvent?.({ type: 'chats.changed' })
  }

  private activeRun(conversationId: string): PreviewRun | null {
    const run = this.runs.get(conversationId)
    return run && isActivePhase(run.snapshot.phase) ? run : null
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
      this.later(180, () => next(index + 2))
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
    // A chat no window follows sends its next queued message itself.
    this.later(1_500, () => this.drain(conversationId))
  }

  private drain(conversationId: string): void {
    if (this.activeRun(conversationId)) return
    const queue = this.queue(conversationId)
    const [next, ...rest] = queue.queued
    if (!next) return
    this.queues.set(conversationId, { ...queue, queued: rest })
    this.onEvent?.({ type: 'queue.changed', conversationId })
    this.begin(conversationId, next.content, next.mode, next.images ?? [], [])
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
          data: {
            success: false,
            exitCode: 1,
            stdout: ' ✓ 18 passed\n ✗ 2 failed: socket closed before the last chunk\n',
            stderr: ''
          },
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
    await new Promise((resolve) => setTimeout(resolve, name === 'upload.put' ? 60 : 120))
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
        const run = this.activeRun(conversationId)
        if (conversationId === 'upload') this.playUploadRun()
        return {
          chat: found,
          messages: [...(this.messages.get(conversationId) ?? [])],
          run: run ? { run: { ...run.snapshot }, events: [...run.events] } : null
        } satisfies Output<'chat.open'>
      }
      case 'chat.send':
        return this.send(input as Input<'chat.send'>)
      case 'queue.list':
        return this.queue((input as Input<'queue.list'>).conversationId)
      case 'queue.update':
        return this.updateQueue(input as Input<'queue.update'>)
      case 'queue.steer':
        return this.steerQueued(input as Input<'queue.steer'>)
      case 'models.list': {
        const { conversationId } = input as Input<'models.list'>
        return {
          models: MODELS,
          selectedModelId: (conversationId && this.chatModels.get(conversationId)) || 'sonnet'
        } satisfies Output<'models.list'>
      }
      case 'run.stop': {
        const { runId } = input as Input<'run.stop'>
        const entry = [...this.runs.entries()].find(([, run]) => run.snapshot.id === runId)
        if (entry) {
          this.finish(entry[0], 'cancelled')
          return { stopped: true }
        }
        const child = this.childRuns.get(runId)
        if (!child || !isActivePhase(child.snapshot.phase)) return { stopped: false }
        this.emit(child, 'run.completed', { phase: 'cancelled' })
        return { stopped: true }
      }
      case 'run.events': {
        const { runId, afterSequence } = input as Input<'run.events'>
        const run =
          [...this.runs.values()].find((item) => item.snapshot.id === runId) ??
          this.childRuns.get(runId)
        if (!run) throw new Error('This run has finished.')
        return {
          run: { ...run.snapshot },
          events: run.events.filter((event) => event.sequence > afterSequence)
        }
      }
      case 'interaction.resolve':
        return this.resolve(input as Input<'interaction.resolve'>)
      case 'upload.put':
        return this.upload(input as Input<'upload.put'>)
      case 'media.get': {
        const { url } = input as Input<'media.get'>
        if (!url.startsWith('sidekick-browser://artifact/'))
          throw new Error('That image is no longer available')
        return { dataUrl: sketch('What the agent saw', 150, 640, 400) }
      }
      case 'voice.state':
        return { dictation: true, speech: true, message: null } satisfies Output<'voice.state'>
      case 'voice.dictation.start': {
        const { dictationId } = input as Input<'voice.dictation.start'>
        this.dictations.set(dictationId, 0)
        return { ok: true } satisfies Output<'voice.dictation.start'>
      }
      case 'voice.dictation.audio':
        return this.dictate(input as Input<'voice.dictation.audio'>)
      case 'voice.dictation.stop': {
        const { dictationId } = input as Input<'voice.dictation.stop'>
        const words = this.dictatedWords(dictationId)
        this.dictations.delete(dictationId)
        if (words) this.onEvent?.({ type: 'dictation.text', dictationId, text: words, final: true })
        this.onEvent?.({ type: 'dictation.end', dictationId })
        return { stopped: true } satisfies Output<'voice.dictation.stop'>
      }
      case 'voice.dictation.cancel': {
        const { dictationId } = input as Input<'voice.dictation.cancel'>
        this.dictations.delete(dictationId)
        return { cancelled: true } satisfies Output<'voice.dictation.cancel'>
      }
      case 'voice.speak':
        return this.speak(input as Input<'voice.speak'>)
      case 'voice.stop': {
        const { speechId } = input as Input<'voice.stop'>
        this.endSpeech(speechId)
        return { stopped: true }
      }
      case 'events.ticket':
        return { ticket: 'preview' }
      default:
        throw new Error('Unknown request')
    }
  }

  private queue(conversationId: string): PromptAdmissionsResult {
    const queue = this.queues.get(conversationId) ?? { queued: [], pivot: null }
    return { queued: [...queue.queued], pivot: queue.pivot }
  }

  private upload(input: Input<'upload.put'>): Output<'upload.put'> {
    const bytes = base64ToBytes(input.data)
    let id = input.uploadId
    if (!id) {
      id = this.id('upload')
      this.uploads.set(id, {
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        pieces: [],
        complete: false
      })
    }
    const upload = this.uploads.get(id)
    if (!upload || upload.complete)
      throw new Error('That upload is no longer available; send the file again')
    upload.pieces.push(bytes)
    upload.complete = input.last
    return { uploadId: id, complete: upload.complete }
  }

  private take(uploadId: string, kind: PreviewUpload['kind']): Uint8Array {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.kind !== kind || !upload.complete)
      throw new Error('That file is no longer available; attach it again')
    this.uploads.delete(uploadId)
    const length = upload.pieces.reduce((sum, piece) => sum + piece.length, 0)
    const out = new Uint8Array(length)
    let offset = 0
    for (const piece of upload.pieces) {
      out.set(piece, offset)
      offset += piece.length
    }
    return out
  }

  private send(input: Input<'chat.send'>): Output<'chat.send'> {
    let id = input.conversationId
    const mode = input.mode ?? 'conversation'
    const images = (input.images ?? []).map(({ uploadId }) => {
      const upload = this.uploads.get(uploadId)
      const bytes = this.take(uploadId, 'image')
      return image(
        uploadId,
        upload?.name ?? 'image',
        `data:${upload?.mimeType};base64,${bytesToBase64(bytes)}`
      )
    })
    const files = (input.files ?? []).map(({ uploadId }) => {
      const name = this.uploads.get(uploadId)?.name ?? 'file.txt'
      this.take(uploadId, 'text')
      return { id: uploadId, kind: 'text', name }
    })
    if (!input.text.trim() && !images.length && !files.length)
      throw new Error('Write a message first')
    const model = MODELS.find((candidate) => candidate.id === input.modelId)
    if (images.length && model && !model.supportsVision)
      throw new Error("This chat's model cannot see images. Choose one that can, or remove them.")
    if (!id) {
      id = this.id('chat')
      this.chats.push(chat(id, input.text.slice(0, 40) || 'New chat', Date.now(), null))
    }
    if (input.modelId) this.chatModels.set(id, input.modelId)
    const run = this.activeRun(id)
    if (run) {
      const item = admission(this.id('queued'), id, input.text, Date.now(), mode, images)
      if (input.behavior === 'steer') {
        this.steerInto(id, run, item)
        return { conversationId: id, runId: run.snapshot.id, steered: true, queued: false }
      }
      const queue = this.queue(id)
      this.queues.set(id, { ...queue, queued: [...queue.queued, item] })
      this.onEvent?.({ type: 'queue.changed', conversationId: id })
      return { conversationId: id, runId: run.snapshot.id, steered: false, queued: true }
    }
    const started = this.begin(id, input.text, mode, images, files)
    return { conversationId: id, runId: started.snapshot.id, steered: false, queued: false }
  }

  /** Saves the user's message and starts a run that answers it. */
  private begin(
    conversationId: string,
    text: string,
    mode: ConversationRunMode,
    images: CompanionImage[],
    files: Array<{ id: string; kind: string; name: string }>
  ): PreviewRun {
    const saved = this.messages.get(conversationId) ?? []
    saved.push(
      message(this.id('m'), 'user', text, Date.now(), {
        runMode: mode,
        ...(images.length ? { images } : {}),
        ...(files.length ? { attachments: files } : {})
      })
    )
    this.messages.set(conversationId, saved)
    this.onEvent?.({ type: 'messages.changed', conversationId })
    const started = this.startRun(conversationId)
    this.onEvent?.({ type: 'run.event', event: started.events[0] })
    this.updateChat(conversationId, { activePhase: 'streaming' })
    const parts = [
      images.length ? `${images.length === 1 ? 'an image' : `${images.length} images`}` : '',
      files.length ? files.map((file) => `\`${file.name}\``).join(', ') : ''
    ].filter(Boolean)
    const said = text.trim() ? `You said: “${text.trim()}”` : 'You sent no text.'
    const extra = parts.length ? ` You attached ${parts.join(' and ')}.` : ''
    const profile =
      mode === 'research' ? ' In Research mode the real one searches and cites sources.' : ''
    this.later(400, () =>
      this.reply(
        conversationId,
        `This is a preview, so nothing ran on a computer. ${said}${extra}${profile}`
      )
    )
    return started
  }

  /** Hands a message to the running run: it shows where the run took it in. */
  private steerInto(conversationId: string, run: PreviewRun, item: PromptAdmissionItem): void {
    const queue = this.queue(conversationId)
    this.queues.set(conversationId, {
      queued: queue.queued.filter((queued) => queued.id !== item.id),
      pivot: item
    })
    this.onEvent?.({ type: 'queue.changed', conversationId })
    this.later(900, () => {
      this.queues.set(conversationId, { ...this.queue(conversationId), pivot: null })
      this.onEvent?.({ type: 'queue.changed', conversationId })
      this.emit(run, 'run.steered', {
        content: item.content,
        messageId: item.id,
        ...(item.images?.length ? { images: item.images } : {})
      })
      const acknowledgement = 'Noted — I’ll do that as soon as the build finishes. '
      this.emit(run, 'run.phase', { phase: 'streaming' })
      const pieces = acknowledgement.match(/\S+\s*/g) ?? []
      pieces.forEach((piece, index) =>
        this.later(150 * (index + 1), () => {
          this.emit(run, 'assistant.delta', { content: piece })
          if (index === pieces.length - 1) {
            this.emit(run, 'assistant.completed', { content: acknowledgement })
            this.emit(run, 'run.phase', { phase: 'executing_tool' })
          }
        })
      )
    })
  }

  private updateQueue({ conversationId, queued }: Input<'queue.update'>): Output<'queue.update'> {
    const current = this.queue(conversationId)
    const byId = new Map(current.queued.map((item) => [item.id, item]))
    const next = queued.flatMap(({ id, content }) => {
      const item = byId.get(id)
      return item
        ? [{ ...item, content: content.trim() || item.content, updatedAt: Date.now() }]
        : []
    })
    this.queues.set(conversationId, { ...current, queued: next })
    this.onEvent?.({ type: 'queue.changed', conversationId })
    return this.queue(conversationId)
  }

  private steerQueued({
    conversationId,
    admissionId
  }: Input<'queue.steer'>): Output<'queue.steer'> {
    const item = this.queue(conversationId).queued.find((queued) => queued.id === admissionId)
    if (!item) throw new Error('That message is no longer queued')
    const run = this.activeRun(conversationId)
    if (!run) {
      this.drain(conversationId)
      return { steered: false }
    }
    this.steerInto(conversationId, run, item)
    return { steered: true }
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
    if (
      run.events.some((event) => event.payload.interactionId === interactionId && event !== asked)
    )
      throw new Error('This card was already answered.')
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

  /** Writes a pretend sentence a word at a time as the microphone streams, drafts first. */
  private dictate({
    dictationId,
    pcm
  }: Input<'voice.dictation.audio'>): Output<'voice.dictation.audio'> {
    const heard = this.dictations.get(dictationId)
    if (heard === undefined) return { accepted: false }
    this.dictations.set(dictationId, heard + base64ToBytes(pcm).length / 2 / 16_000)
    const words = this.dictatedWords(dictationId)
    if (words) this.onEvent?.({ type: 'dictation.text', dictationId, text: words, final: false })
    return { accepted: true }
  }

  private dictatedWords(dictationId: string): string {
    const words = DICTATED.split(' ')
    const count = Math.min(words.length, Math.floor((this.dictations.get(dictationId) ?? 0) * 2.5))
    return words.slice(0, count).join(' ')
  }

  /** Speaks in tones: a pretend voice, sent in pieces as the computer sends real speech. */
  private speak({ speechId, text }: Input<'voice.speak'>): Output<'voice.speak'> {
    if (!text.trim()) throw new Error('Nothing to read')
    const sampleRate = 24_000
    const seconds = Math.min(6, 1 + text.length / 60)
    const pieceSeconds = 0.5
    const timers = new Set<ReturnType<typeof setTimeout>>()
    this.speeches.set(speechId, timers)
    const count = Math.ceil(seconds / pieceSeconds)
    for (let index = 0; index < count; index++) {
      timers.add(
        this.later(250 + index * 300, () => {
          this.onEvent?.({
            type: 'speech.audio',
            speechId,
            sampleRate,
            pcm: bytesToBase64(toneSamples(sampleRate, pieceSeconds, index))
          })
        })
      )
    }
    timers.add(this.later(250 + count * 300, () => this.endSpeech(speechId)))
    return { ok: true }
  }

  private endSpeech(speechId: string): void {
    const timers = this.speeches.get(speechId)
    if (!timers) return
    for (const timer of timers) {
      clearTimeout(timer)
      this.timers.delete(timer)
    }
    this.speeches.delete(speechId)
    this.onEvent?.({ type: 'speech.end', speechId })
  }

  listen(onEvent: (event: CompanionEvent) => void, onConnection: (open: boolean) => void): void {
    this.onEvent = onEvent
    this.later(300, () => onConnection(true))
    if (this.drops) this.later(900, () => onConnection(false))
  }

  close(): void {
    this.onEvent = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.speeches.clear()
  }
}

/** Half a second of soft syllables as 16-bit samples, so read aloud can be heard working. */
function toneSamples(sampleRate: number, seconds: number, piece: number): Uint8Array {
  const length = Math.round(sampleRate * seconds)
  const bytes = new Uint8Array(length * 2)
  const view = new DataView(bytes.buffer)
  const pitch = 180 + (piece % 3) * 30
  for (let index = 0; index < length; index++) {
    const time = index / sampleRate
    const syllable = Math.sin(Math.PI * ((time * 4) % 1)) ** 2
    const value =
      0.18 *
      syllable *
      (Math.sin(2 * Math.PI * pitch * time) + 0.4 * Math.sin(2 * Math.PI * pitch * 2 * time))
    view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, value)) * 0x7fff), true)
  }
  return bytes
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

function image(id: string, name: string, dataUrl: string): CompanionImage {
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png'
  return { id, name, mimeType, dataUrl }
}

function tool(
  id: string,
  name: string,
  title: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'tool',
    tool: {
      id,
      callId: id,
      title,
      command: name,
      name,
      status: 'success',
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 58_000,
      ...extra
    }
  }
}

function admission(
  id: string,
  conversationId: string,
  content: string,
  createdAt: number,
  mode: ConversationRunMode = 'conversation',
  images: CompanionImage[] = []
): PromptAdmissionItem {
  return {
    id,
    conversationId,
    content,
    ...(images.length ? { images } : {}),
    mode,
    behavior: 'queue',
    position: 0,
    createdAt,
    updatedAt: createdAt
  }
}
