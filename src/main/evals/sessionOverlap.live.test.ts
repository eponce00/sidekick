import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentScenarioHarness } from './agentScenarioHarness'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { summarizeReliabilityRun } from './sessionReliabilityEvidence'

it.skipIf(process.env.SIDEKICK_SESSION_OVERLAP_RUN !== '1')(
  'cancels an overlapping waiting request without cancelling its sibling, then serves a healthy request',
  async () => {
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY || ''
    expect(Boolean(key)).toBe(true)
    const startedAt = new Date().toISOString()
    const root = await mkdtemp(join(tmpdir(), 'sidekick-session-overlap-'))
    const workspace = join(root, 'project')
    await mkdir(workspace)
    const harness = new AgentScenarioHarness(join(root, 'runtime'), {
      endpoint: process.env.SIDEKICK_AGENT_EVAL_URL || 'https://llm.midecasa.com/v1',
      model: process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model',
      headers: openAICompatibleHeaders(key),
      maxOutputTokens: 2048,
      requestTimeoutMs: 60_000
    })
    const firstId = randomUUID()
    const secondId = randomUUID()
    let firstSettled = false
    let secondObservedOutput = false
    let secondStopAccepted = false
    let resolveOutput!: () => void
    const firstOutput = new Promise<void>((resolve) => {
      resolveOutput = resolve
    })
    let secondTimer: ReturnType<typeof setTimeout> | undefined
    const ceiling = setTimeout(() => {
      harness.stop(firstId)
      harness.stop(secondId)
    }, 60_000)
    let first: ReturnType<typeof harness.run> | undefined
    try {
      await harness.initialize()
      first = harness
        .run({
          runId: firstId,
          workspaceRoot: workspace,
          capabilities: [],
          maxToolRounds: 2,
          messages: [
            {
              role: 'user',
              content:
                'Write a detailed numbered list of 1000 different synthetic review considerations for a text note format. Do not use tools.'
            }
          ],
          onEvent: (event) => {
            if (event.type === 'assistant.delta') resolveOutput()
          }
        })
        .finally(() => {
          firstSettled = true
        })
      await Promise.race([
        firstOutput,
        first.then(() => {
          throw new Error('First request ended before overlap was established')
        })
      ])
      expect(firstSettled).toBe(false)
      const second = await harness.run({
        runId: secondId,
        workspaceRoot: workspace,
        capabilities: [],
        maxToolRounds: 2,
        messages: [{ role: 'user', content: 'Reply with exactly WAITING_REQUEST_731. No tools.' }],
        beforeModelStep: async () => {
          secondTimer = setTimeout(() => {
            secondStopAccepted = harness.stop(secondId)
          }, 500)
          return []
        },
        onEvent: (event) => {
          if (event.type === 'assistant.delta') secondObservedOutput = true
        }
      })
      expect(secondStopAccepted).toBe(true)
      expect(second.phase).toBe('cancelled')
      expect(secondObservedOutput).toBe(false)
      // The sibling must still be active: cancelling the queued client did not
      // implicitly cancel another session's generation.
      expect(firstSettled).toBe(false)
      expect(harness.stop(firstId)).toBe(true)
      const stoppedFirst = await first
      expect(stoppedFirst.phase).toBe('cancelled')
      const healthy = await harness.run({
        workspaceRoot: workspace,
        capabilities: [],
        maxToolRounds: 2,
        messages: [{ role: 'user', content: 'Reply with exactly HEALTHY_REQUEST_731. No tools.' }]
      })
      expect(healthy.phase).toBe('completed')
      expect((healthy.finalResponse || healthy.content).trim()).toBe('HEALTHY_REQUEST_731')
      for (const result of [second, stoppedFirst, healthy]) {
        expect(result.toolNames).toEqual([])
        expect(summarizeReliabilityRun(result).terminalEvents).toBe(1)
      }
      console.info(
        '[session-overlap]',
        JSON.stringify({
          startedAt,
          finishedAt: new Date().toISOString(),
          scope:
            'two overlapping client requests; one cancelled before first output while sibling remained active; backend queue position not directly observed',
          secondObservedOutput,
          second: summarizeReliabilityRun(second),
          first: summarizeReliabilityRun(stoppedFirst),
          healthy: summarizeReliabilityRun(healthy)
        })
      )
    } finally {
      clearTimeout(ceiling)
      if (secondTimer) clearTimeout(secondTimer)
      harness.stop(firstId)
      harness.stop(secondId)
      await first?.catch(() => undefined)
      await harness.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  100_000
)
