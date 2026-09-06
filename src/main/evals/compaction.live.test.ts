import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentScenarioHarness } from './agentScenarioHarness'
import { AgentContextManager, type AgentCompactionRecord } from '../services/agentContextManager'
import { completeOpenAIChat } from '../providers/openAIStreamingClient'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { toOpenAICompatibleMessages } from '../providers/providerRuntime'
import type { ProviderChatMessage } from '../../shared/providerRuntime'

it.skipIf(process.env.SIDEKICK_COMPACTION_EVAL_RUN !== '1').each([5, 11, 14])(
  'retains early constraints and correction at batch %i across real model compaction and kernel continuation',
  async (correctionBatch) => {
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
    expect(Boolean(key)).toBe(true)
    const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL || 'https://llm.midecasa.com/v1'
    const model = process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model'
    const headers = openAICompatibleHeaders(key)
    const root = await mkdtemp(join(tmpdir(), 'sidekick-compaction-live-'))
    const workspaceRoot = join(root, 'project')
    await mkdir(workspaceRoot)
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint,
      model,
      headers,
      maxOutputTokens: 4096
    })
    const records: AgentCompactionRecord[] = []
    const manager = new AgentContextManager({
      target: { providerKind: 'openai-compatible', model },
      contextLength: 16384,
      maxOutputTokens: 4096,
      threshold: 0.65,
      enabled: true,
      complete: (request, signal) =>
        completeOpenAIChat(
          endpoint,
          {
            model,
            messages: toOpenAICompatibleMessages(request.messages),
            max_tokens: request.maxOutputTokens,
            temperature: request.temperature
          },
          headers,
          fetch,
          signal
        ),
      onCompacted: (record) => records.push(record)
    })
    const messages: ProviderChatMessage[] = [
      {
        role: 'system',
        content:
          'Use conversation evidence. Preserve corrections and unresolved failures. Return only requested JSON. No tools.'
      },
      {
        role: 'user',
        content:
          'Project codename is Cedar-731. Never submit the form. Use fake data only. Initial revision is R17.'
      },
      { role: 'assistant', content: 'I will prepare a local draft, never submit it.' }
    ]
    for (let i = 0; i < 16; i++)
      messages.push(
        {
          role: 'user',
          content: `Reference batch ${i}. ${'Synthetic archived reference, no new decisions. '.repeat(170)}`
        },
        {
          role: 'assistant',
          content:
            i === correctionBatch
              ? 'Correction: latest revision is R23, replacing R17. Validation failed because ZIP is missing; it remains unresolved.'
              : 'Reference noted. No changes or validation performed.'
        }
      )
    messages.push({
      role: 'user',
      content:
        'Return a JSON object with codename, revision, maySubmit (boolean), validationPassed (boolean), and missingField. Use the latest decisions from our conversation.'
    })
    try {
      await harness.initialize()
      expect(manager.shouldCompact(messages, [])).toBe(true)
      const result = await harness.run({
        workspaceRoot,
        capabilities: [],
        messages,
        contextManager: manager,
        maxToolRounds: 2
      })
      expect(result.phase, 'Kernel must complete without provider errors').toBe('completed')
      expect(records.length).toBeGreaterThan(0)
      expect(records.every((record) => record.strategy === 'model')).toBe(true)
      expect(result.events.some((event) => event.type === 'compaction.completed')).toBe(true)
      // This evaluates retained facts, not JSON-mode compliance. Accept one whole
      // Markdown JSON fence, but no commentary or extraction from arbitrary text.
      const answer = (result.finalResponse || result.content).trim()
      const json = /^```json\s*\n([\s\S]*?)\n```$/.exec(answer)?.[1] ?? answer
      expect(JSON.parse(json)).toEqual({
        codename: 'Cedar-731',
        revision: 'R23',
        maySubmit: false,
        validationPassed: false,
        missingField: 'ZIP'
      })
      console.info(
        '[compaction-kernel] exact retained constraints and correction; model summaries=' +
          records.length
      )
    } finally {
      await harness.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  240000
)
