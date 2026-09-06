import { expect, it } from 'vitest'
import { probeProvider } from './providerProbe'
import { streamOpenAICompatibleChat } from './openAIStreamingClient'
import { openAIRequest } from './providerRuntime'

it.skipIf(process.env.SIDEKICK_PROVIDER_PROBE_RUN !== '1')(
  'probes the real configured gateway without executing tools',
  async () => {
    const key = process.env.SIDEKICK_AGENT_EVAL_API_KEY
    if (!key) throw new Error('Missing test credential')
    const report = await probeProvider(
      { providerKind: 'litellm', model: 'local-loaded-model' },
      (request, emit, signal) =>
        streamOpenAICompatibleChat(
          process.env.SIDEKICK_AGENT_EVAL_URL || 'https://llm.midecasa.com/v1',
          openAIRequest(request),
          { Authorization: `Bearer ${key}` },
          emit,
          fetch,
          signal
        ),
      AbortSignal.timeout(120_000),
      true
    )
    console.log(JSON.stringify(report))
    expect(report.checks.find((check) => check.capability === 'streaming')?.status).toBe('observed')
    expect(report.checks.find((check) => check.capability === 'tools')?.status).toBe('observed')
    expect(report.checks.find((check) => check.capability === 'vision')?.status).toBe('observed')
  },
  130_000
)
