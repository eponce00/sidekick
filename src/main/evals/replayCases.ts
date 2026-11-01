import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { searchFailure } from '../services/agentWebToolHandlers'
import { formatCompactionContext } from '../../shared/compactionPrompt'
import type { ProviderChatMessage, ProviderToolCall } from '../../shared/providerRuntime'
import type { SearchSourceId } from '../services/sidekickSearch/types'

/**
 * Replay cases: a conversation trimmed to the turn a real run got wrong, written by hand from the
 * pattern, and what the model's next turn must or must not do. One NDJSON file per case: the first
 * line holds `id`, `pattern` and `expect`, every later line one message. A message with a
 * `fixture` is built by SideKick's own code, so a change to that text is replayed too.
 */
export interface ReplayExpectation {
  /** Tools the next turn must not call. */
  forbidTools?: string[]
  /** Case-insensitive patterns the reply text must not match. */
  forbidContent?: string[]
  /** Case-insensitive patterns no call's arguments may match. */
  forbidArguments?: string[]
  /** At least one must hold: a call to one of `tools`, or reply text matching `content`. */
  oneOf?: Array<{ tools?: string[]; content?: string }>
}

export interface ReplayCase {
  id: string
  pattern: string
  expect: ReplayExpectation
  messages: ProviderChatMessage[]
}

export const REPLAY_CASE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'replay')

const ENGINES: SearchSourceId[] = ['duckduckgo', 'brave', 'bing']

type CaseLine = Record<string, unknown> & { role?: string; fixture?: string }

function message(line: CaseLine, source: string): ProviderChatMessage {
  if (line.fixture === 'compaction_summary') {
    return { role: 'user', content: formatCompactionContext(String(line.summary ?? '')) }
  }
  if (line.fixture === 'web_search_refused') {
    // Every engine answered 429, as the run that searched 55 times saw.
    const now = Date.now()
    const failed = searchFailure(
      'Web search',
      {
        query: String(line.query ?? ''),
        results: [],
        cached: false,
        diagnostics: ENGINES.map((source) => ({
          source,
          status: 'rate_limited',
          resultCount: 0,
          durationMs: 400,
          error: 'HTTP 429 (too many requests)',
          retryAt: now + 5 * 60_000
        }))
      },
      now
    )
    return { role: 'tool', tool_call_id: String(line.tool_call_id), content: failed!.modelContent }
  }
  if (line.fixture) throw new Error(`${source}: unknown fixture ${line.fixture}`)
  if (line.role === 'assistant') {
    const calls = (line.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
    return {
      role: 'assistant',
      content: String(line.content ?? ''),
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: String(call.id),
              function: {
                name: String(call.name),
                arguments: call.arguments as Record<string, unknown>
              }
            }))
          }
        : {})
    }
  }
  if (line.role === 'tool') {
    return { role: 'tool', tool_call_id: String(line.tool_call_id), content: String(line.content) }
  }
  if (line.role === 'user') return { role: 'user', content: String(line.content) }
  throw new Error(`${source}: a message needs role user, assistant or tool`)
}

export function loadReplayCases(root = REPLAY_CASE_ROOT): ReplayCase[] {
  return readdirSync(root)
    .filter((name) => name.endsWith('.ndjson'))
    .sort()
    .map((name) => {
      const lines = readFileSync(join(root, name), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as CaseLine)
      const [head, ...rest] = lines
      if (!head?.id || !head.expect) throw new Error(`${name}: the first line needs id and expect`)
      return {
        id: String(head.id),
        pattern: String(head.pattern ?? ''),
        expect: head.expect as ReplayExpectation,
        messages: rest.map((line) => message(line, name))
      }
    })
}

function argumentsText(call: ProviderToolCall): string {
  const value = call.function.arguments
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

/** What the turn did wrong against the case; empty when it passed. */
export function gradeReplayTurn(
  expect: ReplayExpectation,
  turn: { content: string; toolCalls: readonly ProviderToolCall[] }
): string[] {
  const failures: string[] = []
  const names = turn.toolCalls.map((call) => call.function.name)
  const matches = (pattern: string, value: string) => new RegExp(pattern, 'i').test(value)
  for (const name of names) {
    if (expect.forbidTools?.includes(name)) failures.push(`called ${name}`)
  }
  for (const pattern of expect.forbidContent ?? []) {
    if (matches(pattern, turn.content)) failures.push(`reply matched /${pattern}/`)
  }
  for (const pattern of expect.forbidArguments ?? []) {
    const call = turn.toolCalls.find((candidate) => matches(pattern, argumentsText(candidate)))
    if (call) failures.push(`${call.function.name} arguments matched /${pattern}/`)
  }
  if (
    expect.oneOf?.length &&
    !expect.oneOf.some(
      (option) =>
        (option.tools ?? []).some((tool) => names.includes(tool)) ||
        (option.content !== undefined && matches(option.content, turn.content))
    )
  ) {
    failures.push(
      `did none of: ${expect.oneOf
        .map((option) =>
          option.tools ? `call ${option.tools.join('/')}` : `say /${option.content}/`
        )
        .join('; ')}`
    )
  }
  return failures
}
