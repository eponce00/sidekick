import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import { openAICompatibleHeaders } from '../providers/openAICompatibleClient'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { DEFAULT_TOOL_CALL_LIMIT } from '../../shared/agentLimits'
import {
  PromptComposer,
  capabilitiesFromTools,
  createPromptModelProfile
} from '../../shared/prompts'
import type { ModelProvider } from '../../shared/models'
import type { ProviderKind } from '../../shared/providerRegistry'
import {
  createAgentEvalReport,
  redactEvalError,
  safeEvalEndpoint,
  type AgentEvalMetric
} from './agentEval'
import { liveSampler } from './agentScenarioHarness'
import { gradeReplayTurn, loadReplayCases } from './replayCases'

/**
 * Replays conversations trimmed to the turn a real run got wrong and grades the model's next turn
 * by code. The system prompt and the tool schemas come from this checkout, so the same cases run
 * on two branches compare two versions of the text. Opt-in through `npm run test:agent-eval:replay`;
 * it calls a model and never runs in CI.
 */

const endpoint = process.env.SIDEKICK_AGENT_EVAL_URL?.trim() || 'http://127.0.0.1:1234/v1'
const model = process.env.SIDEKICK_AGENT_EVAL_MODEL?.trim() || 'local-loaded-model'
const apiKey = process.env.SIDEKICK_AGENT_EVAL_API_KEY?.trim()
const providerKind = (process.env.SIDEKICK_AGENT_EVAL_PROVIDER_KIND?.trim() ||
  'litellm') as ProviderKind
const enabled = process.env.SIDEKICK_AGENT_EVAL_RUN === '1' && Boolean(apiKey)
const trials = Math.max(1, Math.trunc(Number(process.env.SIDEKICK_REPLAY_TRIALS) || 3))
const only = (process.env.SIDEKICK_REPLAY_CASES ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const cases = loadReplayCases().filter(({ id }) => !only.length || only.includes(id))
const planned = cases.flatMap(({ id }) =>
  Array.from({ length: trials }, (_, trial) => ({
    name: `${id}#${trial + 1}`,
    category: 'replay' as const,
    weight: 1
  }))
)
const metrics: AgentEvalMetric[] = []
const startedAt = new Date().toISOString()

// A full conversation turn, as the context budget measures it.
const tools = getAgentToolDefinitions({
  surface: 'conversation',
  sessionRole: 'manager',
  workspaceRoot: '/project',
  webSearchEnabled: true,
  browserEnabled: true,
  codeIntelligenceAvailable: true,
  activeSkillIds: []
})
const system = new PromptComposer().compose({
  platform: 'windows',
  capabilities: capabilitiesFromTools(tools),
  permissionMode: 'sensitive-only',
  model: createPromptModelProfile({
    id: model,
    name: model,
    provider: providerKind as ModelProvider
  }),
  project: { workspaceRoot: '/project', instructions: '', instructionSources: [], memory: '' },
  currentDate: new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(new Date()),
  toolRoundLimit: DEFAULT_TOOL_CALL_LIMIT,
  activeSkillIds: [],
  skillAssetsPath: '/skills'
}).content
const sample = liveSampler({
  endpoint,
  model,
  headers: openAICompatibleHeaders(apiKey),
  providerKind,
  maxOutputTokens: 8_192,
  requestTimeoutMs: 300_000,
  temperature: null
})

afterAll(async () => {
  if (!enabled) return
  const report = createAgentEvalReport({
    endpoint: safeEvalEndpoint(endpoint),
    model,
    providerKind,
    suite: 'replay',
    scenarioVersion: `replay-${cases.length}-cases`,
    startedAt,
    completedAt: new Date().toISOString(),
    metrics,
    plannedMetrics: planned,
    revision: process.env.SIDEKICK_AGENT_EVAL_REVISION || process.env.GITHUB_SHA
  })
  const reportPath = process.env.SIDEKICK_AGENT_EVAL_REPORT?.trim()
  if (reportPath) {
    await fs.mkdir(dirname(resolve(reportPath)), { recursive: true })
    await fs.writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  console.info(`[agent-eval] ${JSON.stringify(report.summary)}`)
})
;(enabled ? describe.sequential : describe.skip)('replayed bad turns from real runs', () => {
  for (const replay of cases) {
    it(
      `${replay.id}: ${replay.pattern}`,
      async () => {
        const failed: string[] = []
        for (let trial = 1; trial <= trials; trial++) {
          const started = performance.now()
          const metric: AgentEvalMetric = {
            name: `${replay.id}#${trial}`,
            category: 'replay',
            weight: 1,
            passed: false,
            latencyMs: 0
          }
          try {
            const { result, turn } = await sample(
              {
                target: { providerKind, model },
                purpose: 'conversation',
                maxOutputTokens: 8_192,
                messages: [{ role: 'system', content: system }, ...replay.messages],
                tools
              },
              AbortSignal.timeout(300_000),
              () => undefined
            )
            if (!result.ok) throw new Error(result.error || 'The model request failed')
            const failures = gradeReplayTurn(replay.expect, turn)
            Object.assign(metric, {
              passed: failures.length === 0,
              promptTokens: turn.usage.promptTokens,
              completionTokens: turn.usage.completionTokens,
              details: {
                pattern: replay.pattern,
                toolCalls: turn.toolCalls.map((call) => call.function.name),
                reply: turn.content.slice(0, 400),
                failures
              }
            })
            if (failures.length) failed.push(`trial ${trial}: ${failures.join('; ')}`)
          } catch (error) {
            metric.error = redactEvalError(error)
            failed.push(`trial ${trial}: ${metric.error}`)
          } finally {
            metric.latencyMs = Math.round(performance.now() - started)
            metrics.push(metric)
          }
        }
        expect(failed, failed.join('\n')).toEqual([])
      },
      330_000 * trials
    )
  }
})
