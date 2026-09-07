import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'
import { PromptComposer, capabilitiesFromTools } from '../../shared/prompts'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { openAIRequest } from '../providers/providerRuntime'
import { durableProviderHistory, type MessageRow } from './conversationRunPreparer'

/** Exact production source chain from the read-only audit:
 * shared/prompts/PromptComposer.ts -> shared/agentToolCatalog.ts ->
 * services/conversationRunPreparer.ts durableProviderHistory ->
 * providers/providerRuntime.ts openAIRequest.
 * This checks deterministic component bytes, not the full coordinator, live MCP
 * discovery ordering, provider template/cache behavior, or model latency.
 */
it('preserves same-state request bytes within a day while allowing a fresh daily date', () => {
  const db = new Database(':memory:')
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    db.exec(`
      CREATE TABLE agent_runs (id TEXT, thread_id TEXT, provider TEXT, model TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events (run_id TEXT, sequence INTEGER, type TEXT, payload_json TEXT);
      INSERT INTO agent_runs VALUES ('stored-run', 'conversation', 'litellm', 'synthetic-model', 1);
    `)
    const events = [
      ['run.started', { outputMessageId: 'assistant-1' }],
      [
        'assistant.completed',
        {
          toolCalls: [
            { id: 'stored-call', name: 'browser_observe', arguments: { include_screenshot: false } }
          ]
        }
      ],
      [
        'tool.completed',
        {
          name: 'browser_observe',
          toolCallId: 'stored-call',
          result: {
            modelContent: '{"semanticSnapshot":"synthetic fixed observation","observedAt":100}'
          }
        }
      ]
    ] as const
    const insert = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?, ?)')
    events.forEach(([type, payload], index) =>
      insert.run('stored-run', index, type, JSON.stringify(payload))
    )
    const rows: MessageRow[] = [
      {
        id: 'assistant-1',
        role: 'agent',
        content: 'Synthetic history',
        thinking: null,
        segments: null,
        images: null,
        attachments: null,
        token_usage: null,
        timestamp: 1
      }
    ]
    const build = (instant: Date) => {
      vi.setSystemTime(instant)
      const target = { providerKind: 'litellm' as const, model: 'synthetic-model' }
      const tools = getAgentToolDefinitions({
        surface: 'conversation',
        workspaceRoot: '/synthetic-project',
        browserEnabled: true,
        activeSkillIds: ['xlsx']
      })
      const prompt = new PromptComposer().compose({
        platform: 'windows',
        capabilities: capabilitiesFromTools(tools),
        permissionMode: 'sensitive-only',
        model: {
          family: 'qwen',
          provider: 'litellm',
          providerKind: 'litellm',
          modelId: 'synthetic-model',
          displayName: 'Synthetic',
          instructionStyle: 'compact-structured'
        },
        project: {
          workspaceRoot: '/synthetic-project',
          instructions: 'Use synthetic fixtures only.',
          instructionSources: ['AGENTS.md'],
          memory: 'Synthetic stable memory.'
        },
        // Same formatter and local-date semantics as ConversationRunPreparer.
        currentDate: new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }).format(instant),
        toolRoundLimit: 24,
        activeSkillIds: ['xlsx'],
        skillAssetsPath: '/synthetic-skills'
      })
      const history = durableProviderHistory(db, 'conversation', rows, target)
      const messages = [
        { role: 'system' as const, content: prompt.content },
        { role: 'user' as const, content: prompt.projectInstructionsMessage },
        ...history
      ]
      return {
        system: prompt.content,
        tools: JSON.stringify(tools),
        history: JSON.stringify(history),
        request: JSON.stringify(
          openAIRequest({
            purpose: 'conversation',
            target,
            messages,
            tools,
            maxOutputTokens: 2048,
            temperature: 0
          })
        )
      }
    }
    const first = build(new Date(2026, 8, 6, 9))
    const second = build(new Date(2026, 8, 6, 10))
    const nextDay = build(new Date(2026, 8, 7, 9))
    expect(Buffer.from(second.request)).toEqual(Buffer.from(first.request))
    expect(second).toEqual(first)
    expect(nextDay.tools).toBe(first.tools)
    expect(nextDay.history).toBe(first.history)
    expect(nextDay.system).not.toBe(first.system)
    expect(nextDay.system.replace(/Current date: [^\n]+/, 'Current date: REDACTED')).toBe(
      first.system.replace(/Current date: [^\n]+/, 'Current date: REDACTED')
    )
  } finally {
    db.close()
    vi.useRealTimers()
  }
})
