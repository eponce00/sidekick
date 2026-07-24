import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { dirname, resolve } from 'path'
import {
  completeOpenAICompatibleChat,
  openAICompatibleHeaders
} from '../providers/openAICompatibleClient'
import { redactEvalError, safeEvalEndpoint } from './agentEval'
import { OPENROUTER_FREE_EVAL_MODELS } from './openRouterEvalModels'

const ENDPOINT = 'https://openrouter.ai/api/v1'
const apiKey = process.env.SIDEKICK_OPENROUTER_EVAL_API_KEY?.trim()
const enabled = process.env.SIDEKICK_OPENROUTER_EVAL_RUN === '1' && Boolean(apiKey)
const liveDescribe = enabled ? describe.sequential : describe.skip
const reportPath = process.env.SIDEKICK_OPENROUTER_EVAL_REPORT?.trim()
const headers = {
  ...openAICompatibleHeaders(apiKey),
  'HTTP-Referer': 'https://github.com/eponce00/sidekick',
  'X-Title': 'SideKick development evaluation'
}

interface CatalogModel {
  id: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
  top_provider?: { max_completion_tokens?: number }
}

interface MatrixResult {
  model: string
  passed: boolean
  status: 'compatible' | 'unavailable' | 'incompatible'
  latencyMs: number
  contextLength?: number
  maxOutputTokens?: number
  error?: string
}

const results: MatrixResult[] = []
let catalog = new Map<string, CatalogModel>()

function probeTool() {
  return {
    type: 'function',
    function: {
      name: 'sidekick_eval_probe',
      description: 'Return the requested marker to verify development tool-call compatibility.',
      parameters: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false
      }
    }
  }
}

async function runToolProbe(model: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await completeOpenAICompatibleChat(
      ENDPOINT,
      {
        model,
        messages: [
          {
            role: 'user',
            content:
              'Call sidekick_eval_probe exactly once with marker SIDEKICK_OPENROUTER_TOOL_OK. Do not answer with prose.'
          }
        ],
        tools: [probeTool()],
        tool_choice: { type: 'function', function: { name: 'sidekick_eval_probe' } },
        max_tokens: 256,
        temperature: 0
      },
      headers,
      fetch,
      AbortSignal.timeout(180_000)
    )
    if (completion.ok || attempt === 1) return completion
    const transient =
      completion.status === 408 ||
      completion.status === 409 ||
      completion.status === 429 ||
      (completion.status !== undefined && completion.status >= 500) ||
      /provider returned error|temporar(?:y|ily)|unavailable|no endpoints/i.test(
        completion.error || ''
      )
    if (!transient) return completion
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  }
  throw new Error('Unreachable OpenRouter probe state')
}

beforeAll(async () => {
  if (!enabled) return
  const response = await fetch(`${ENDPOINT}/models`, {
    headers,
    signal: AbortSignal.timeout(30_000)
  })
  expect(response.ok, `OpenRouter catalog returned HTTP ${response.status}`).toBe(true)
  const body = (await response.json()) as { data?: CatalogModel[] }
  catalog = new Map((body.data ?? []).map((entry) => [entry.id, entry]))
})

afterAll(async () => {
  if (!enabled || !reportPath) return
  const absolutePath = resolve(reportPath)
  await fs.mkdir(dirname(absolutePath), { recursive: true })
  const passedModels = results.filter((result) => result.status === 'compatible').length
  const unavailableModels = results.filter((result) => result.status === 'unavailable').length
  const incompatibleModels = results.filter((result) => result.status === 'incompatible').length
  await fs.writeFile(
    absolutePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        endpoint: safeEvalEndpoint(ENDPOINT),
        createdAt: new Date().toISOString(),
        summary: {
          passed:
            results.length === OPENROUTER_FREE_EVAL_MODELS.length &&
            passedModels > 0 &&
            incompatibleModels === 0,
          passedModels,
          totalModels: results.length,
          unavailableModels,
          incompatibleModels
        },
        results
      },
      null,
      2
    )}\n`,
    'utf8'
  )
})

liveDescribe('OpenRouter free development model matrix', () => {
  it.each(OPENROUTER_FREE_EVAL_MODELS)(
    '%s is free, discoverable, and follows a forced tool contract',
    async (model) => {
      const startedAt = performance.now()
      try {
        const metadata = catalog.get(model)
        expect(metadata, `${model} was not returned by OpenRouter /models`).toBeDefined()
        expect(Number(metadata?.pricing?.prompt)).toBe(0)
        expect(Number(metadata?.pricing?.completion)).toBe(0)
        expect(metadata?.supported_parameters).toContain('tools')
        expect(metadata?.supported_parameters).toContain('tool_choice')

        const completion = await runToolProbe(model)
        if (!completion.ok) {
          results.push({
            model,
            passed: false,
            status: 'unavailable',
            latencyMs: Math.round(performance.now() - startedAt),
            contextLength: metadata?.context_length,
            maxOutputTokens: metadata?.top_provider?.max_completion_tokens,
            error: redactEvalError(completion.error || 'OpenRouter endpoint unavailable')
          })
          return
        }
        const call = completion.data?.message.tool_calls?.find(
          (candidate) => candidate.function.name === 'sidekick_eval_probe'
        )
        expect(call, `${model} returned no sidekick_eval_probe call`).toBeDefined()
        const args = JSON.parse(call!.function.arguments) as { marker?: string }
        expect(args.marker).toBe('SIDEKICK_OPENROUTER_TOOL_OK')
        results.push({
          model,
          passed: true,
          status: 'compatible',
          latencyMs: Math.round(performance.now() - startedAt),
          contextLength: metadata?.context_length,
          maxOutputTokens: metadata?.top_provider?.max_completion_tokens
        })
      } catch (error) {
        results.push({
          model,
          passed: false,
          status: 'incompatible',
          latencyMs: Math.round(performance.now() - startedAt),
          error: redactEvalError(error)
        })
        throw error
      }
    },
    190_000
  )

  it('retains at least one compatible fallback without incompatible successful responses', () => {
    expect(results.some((result) => result.status === 'compatible')).toBe(true)
    expect(results.filter((result) => result.status === 'incompatible')).toEqual([])
  })
})
