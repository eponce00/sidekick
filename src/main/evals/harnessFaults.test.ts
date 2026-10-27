import { existsSync, promises as fs } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentContextManager } from '../services/agentContextManager'
import type { AgentCapability } from '../../shared/agentRuntime'
import type { ProviderChatMessage } from '../../shared/providerRuntime'
import {
  AgentScenarioHarness,
  withIsolatedEvalRoot,
  type AgentKernelScenarioResult
} from './agentScenarioHarness'

/**
 * Harness faults found in real runs, replayed against a scripted model on loopback
 * (scripts/scripted-model.cjs) and a faulted environment. Each scenario checks what SideKick
 * told the model and the user, and fails on the commit before its fix. See
 * docs/development/TESTING.md.
 */

interface WireMessage {
  role: string
  content?: unknown
  tool_call_id?: string
}
interface ScriptedAnswer {
  content?: string
  toolCall?: { name: string; arguments: Record<string, unknown> }
}
interface ScriptedModel {
  url: string
  requests: Array<{ messages: WireMessage[] }>
  close(): Promise<void>
}
const { startScriptedModel, text } = createRequire(import.meta.url)(
  '../../../scripts/scripted-model.cjs'
) as {
  startScriptedModel(options: {
    models: Array<{ id: string }>
    reply(messages: WireMessage[]): ScriptedAnswer | Promise<ScriptedAnswer>
  }): Promise<ScriptedModel>
  text(content: unknown): string
}

const MODEL = 'scripted-model'
const windows = process.platform === 'win32'

/** The latest tool result a request carried, as the model read it. */
function lastToolResult(messages: readonly WireMessage[]): string {
  return text([...messages].reverse().find((message) => message.role === 'tool')?.content)
}

async function scenario(
  options: {
    capabilities: readonly AgentCapability[]
    reply(
      step: number,
      messages: WireMessage[],
      workspaceRoot: string
    ): ScriptedAnswer | Promise<ScriptedAnswer>
    request: string
    history?: ProviderChatMessage[]
    webSearchEnabled?: boolean
    contextManager?: AgentContextManager
    files?: Record<string, string>
  },
  check: (run: {
    result: AgentKernelScenarioResult
    requests: ScriptedModel['requests']
    workspaceRoot: string
  }) => Promise<void> | void
): Promise<void> {
  await withIsolatedEvalRoot('sidekick-harness-fault-', async (root) => {
    const workspaceRoot = join(root, 'project')
    await fs.mkdir(workspaceRoot, { recursive: true })
    for (const [name, content] of Object.entries(options.files ?? {}))
      await fs.writeFile(join(workspaceRoot, name), content, 'utf8')
    let step = 0
    const model = await startScriptedModel({
      models: [{ id: MODEL }],
      reply: (messages) => options.reply(step++, messages, workspaceRoot)
    })
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint: model.url,
      model: MODEL,
      headers: {},
      maxOutputTokens: 4_096,
      terminal: true
    })
    try {
      await harness.initialize()
      const result = await harness.run({
        workspaceRoot,
        capabilities: options.capabilities,
        webSearchEnabled: options.webSearchEnabled,
        contextManager: options.contextManager,
        maxToolRounds: 20,
        messages: [
          { role: 'system', content: 'You are SideKick.' },
          ...(options.history ?? []),
          { role: 'user', content: options.request }
        ]
      })
      await check({ result, requests: model.requests, workspaceRoot })
    } finally {
      await harness.close()
      await model.close()
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('harness faults from real runs', () => {
  it('keeps the latest request word for word after a mid-run compaction', async () => {
    // 0.22.0: a long reply compacted mid-run, a local model's summary named an earlier question
    // as the objective, and the agent answered that one.
    const request = 'So what is done and what is pending?'
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `notes-${index}.txt`,
        Array.from({ length: 200 }, (_, line) => `note ${index}.${line}: ${'status '.repeat(8)}`)
          .join('\n')
          .concat('\n')
      ])
    )
    await scenario(
      {
        capabilities: ['workspace.read'],
        files,
        history: [
          { role: 'user', content: 'Can you clone the private repository for me?' },
          { role: 'assistant', content: 'I cannot reach it; clone it and I will read the files.' }
        ],
        request,
        contextManager: new AgentContextManager({
          target: { providerKind: 'litellm', model: MODEL, contextLength: 32_768 },
          contextLength: 32_768,
          maxOutputTokens: 4_096,
          threshold: 0.8,
          enabled: true,
          // The summary the local model wrote: the earlier question as the objective.
          complete: async () => ({
            ok: true,
            data: {
              message: {
                role: 'assistant',
                content: '## Objective\n- Clone the private repository.'
              },
              promptTokens: 10_000,
              completionTokens: 20,
              reasoningTokens: 0,
              finishReason: 'stop'
            }
          })
        }),
        reply: (step, messages) =>
          messages.some((message) => text(message.content).includes('<historical_context')) ||
          step >= 10
            ? { content: 'Notes 0 to 9 are done; nothing is pending.' }
            : { toolCall: { name: 'read', arguments: { path: `notes-${step}.txt` } } }
      },
      ({ result, requests }) => {
        expect(result.phase).toBe('completed')
        expect(result.events.some((event) => event.type === 'compaction.completed')).toBe(true)
        const after = requests.find(({ messages }) =>
          messages.some((message) => text(message.content).includes('<historical_context'))
        )
        expect(after, 'the run never compacted').toBeDefined()
        const summary = after!.messages.findIndex((message) =>
          text(message.content).includes('<historical_context')
        )
        expect(after!.messages[summary + 1]).toMatchObject({ role: 'user' })
        expect(text(after!.messages[summary + 1].content)).toBe(request)
      }
    )
  }, 60_000)

  it('fails a search every engine refused, and leaves rate-limited engines alone', async () => {
    // 0.22.1: every engine answered 429, each search came back as an empty success, and the
    // agent searched 55 times thinking its own model server was saturated.
    const engineRequests: string[] = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname === '127.0.0.1') return realFetch(input, init)
      engineRequests.push(url.hostname)
      return new Response('Too Many Requests', { status: 429 })
    })
    await scenario(
      {
        capabilities: ['web.search'],
        webSearchEnabled: true,
        request: 'Find recent benchmarks for local 27B models.',
        reply: (step) =>
          step < 2
            ? {
                toolCall: {
                  name: 'web_search',
                  arguments: { query: step ? 'local 27B model benchmark' : 'local 27B benchmarks' }
                }
              }
            : { content: 'Web search is unavailable right now.' }
      },
      ({ result, requests }) => {
        const searches = result.events.filter(
          (event) => event.type === 'tool.completed' && event.payload.name === 'web_search'
        )
        expect(searches).toHaveLength(2)
        for (const search of searches) {
          expect(search.payload.result).toMatchObject({ status: 'error' })
        }
        const first = lastToolResult(requests[1].messages)
        expect(first).toContain('Web search failed')
        for (const engine of ['DuckDuckGo', 'Brave', 'Bing']) expect(first).toContain(engine)
        expect(first).toContain('not the model provider')
        // The second search, inside the cooldown, asks no engine.
        expect(engineRequests).toHaveLength(3)
        expect(lastToolResult(requests[2].messages)).toMatch(
          /Web search failed.*not asked again yet/
        )
      }
    )
  }, 60_000)

  const outliving = (program: string) =>
    windows
      ? `Start-Process -NoNewWindow powershell.exe -ArgumentList '-NoProfile','-Command','${program}'`
      : // Time for nohup to ignore the hangup the terminal sends when the shell exits.
        `nohup sh -c '${program}' >/dev/null 2>&1 & sleep 1`

  it('keeps a background command running until the program it started ends', async () => {
    // 0.22.1: a command that started its job with Start-Process was reported finished with exit
    // code 0 at once, and the agent took its running benchmark for a failed one.
    const program = windows
      ? 'Start-Sleep 4; Set-Content done.txt ok'
      : 'sleep 4; echo ok > done.txt'
    let taskId = ''
    await scenario(
      {
        capabilities: ['command.execute', 'command.background', 'wait'],
        request: 'Run the benchmark in the background and tell me when it is done.',
        reply: (step, messages) => {
          if (step === 0)
            return {
              toolCall: {
                name: 'shell',
                arguments: { command: outliving(program), background: true }
              }
            }
          if (step === 1) {
            taskId = /[0-9a-f]{8}-[\w-]+/.exec(lastToolResult(messages))?.[0] ?? ''
            return { toolCall: { name: 'wait', arguments: { taskIds: [taskId], seconds: 60 } } }
          }
          return { content: 'The benchmark finished.' }
        }
      },
      ({ result, requests, workspaceRoot }) => {
        expect(result.phase).toBe('completed')
        expect(taskId, lastToolResult(requests[1].messages)).not.toBe('')
        const waited = lastToolResult(requests[2].messages)
        expect(waited).toContain('[SideKick] The shell exited while programs it started')
        // The wait ended when the program did, not when its shell exited.
        expect(existsSync(join(workspaceRoot, 'done.txt'))).toBe(true)
      }
    )
  }, 60_000)

  it('stops the program a background command started when the command is stopped', async () => {
    const program = windows
      ? 'Set-Content pid.txt $PID; Start-Sleep 60'
      : 'echo $$ > pid.txt; exec sleep 60'
    let pid = 0
    try {
      await scenario(
        {
          capabilities: ['command.execute', 'command.background', 'wait'],
          request: 'Start the benchmark in the background, then stop it.',
          reply: async (step, messages, workspaceRoot) => {
            if (step === 0)
              return {
                toolCall: {
                  name: 'shell',
                  arguments: { command: outliving(program), background: true }
                }
              }
            if (step === 1) {
              const taskId = /[0-9a-f]{8}-[\w-]+/.exec(lastToolResult(messages))?.[0] ?? ''
              // Stopped once the program runs and its shell has exited, as a user stops a
              // benchmark that is under way.
              const pidFile = join(workspaceRoot, 'pid.txt')
              await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 20_000 })
              pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
              await new Promise((done) => setTimeout(done, 3_000))
              return { toolCall: { name: 'cancel_background_task', arguments: { taskId } } }
            }
            return { content: 'Stopped.' }
          }
        },
        async ({ result }) => {
          expect(result.phase).toBe('completed')
          expect(pid).toBeGreaterThan(0)
          await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
        }
      )
    } finally {
      if (pid && alive(pid)) process.kill(pid)
    }
  }, 60_000)

  it('stops a model that repeats the same failing call', async () => {
    await scenario(
      {
        capabilities: ['workspace.read'],
        request: 'What does missing.txt say?',
        reply: (step) =>
          step < 12
            ? { toolCall: { name: 'read', arguments: { path: 'missing.txt' } } }
            : { content: 'It does not exist.' }
      },
      ({ result, requests }) => {
        const reads = result.events.filter(
          (event) => event.type === 'tool.completed' && event.payload.name === 'read'
        )
        expect(lastToolResult(requests[2].messages)).toContain('<sidekick_tool_guard')
        expect(reads.length).toBeLessThanOrEqual(5)
        expect(reads.at(-1)?.payload.result).toMatchObject({ error: { code: 'loop_detected' } })
      }
    )
  }, 60_000)
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
