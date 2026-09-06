import { describe, expect, it, vi } from 'vitest'
import { probeProvider } from './providerProbe'
import type { ProviderChatRequest, ProviderStreamChunk } from '../../shared/providerRuntime'

const target = { providerKind: 'litellm' as const, model: 'local-loaded-model' }
describe('synthetic provider capability probes', () => {
  it('accepts cumulative adapter previews without duplicating the tool name', async () => {
    const report = await probeProvider(
      target,
      async (_request, emit) => {
        emit({
          message: {
            tool_calls: [{ index: 0, function: { name: 'capability_probe', arguments: {} } }]
          }
        })
        emit({
          message: {
            tool_calls: [
              { index: 0, function: { name: 'capability_probe', arguments: { value: 7 } } }
            ]
          }
        })
        return { ok: true }
      },
      new AbortController().signal
    )
    expect(report.checks.find((check) => check.capability === 'tools')?.status).toBe('observed')
  })
  it('observes streaming, reasoning and cumulative tool JSON without executing tools', async () => {
    const stream = vi.fn(
      async (request: ProviderChatRequest, emit: (chunk: ProviderStreamChunk) => void) => {
        if (request.tools) {
          emit({
            message: {
              tool_calls: [{ function: { name: 'capability_probe', arguments: '{"value":' } }]
            }
          })
          emit({ message: { tool_calls: [{ function: { name: '', arguments: '{"value":7}' } }] } })
        } else {
          emit({
            message: { thinking: 'private reasoning', content: '221' },
            prompt_eval_count: 30,
            cached_prompt_tokens: 0
          })
        }
        return { ok: true }
      }
    )
    const report = await probeProvider(target, stream, new AbortController().signal)
    expect(report.checks.map((check) => check.status)).toEqual(['observed', 'observed', 'observed'])
    expect(report.checks[0].cachedTokens).toBe(0)
    expect(report.checks[2].cachedTokens).toBeUndefined()
    expect(JSON.stringify(report)).not.toContain('private reasoning')
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[0][0].thinkingEnabled).toBeUndefined()
  })
  it('does not treat provider errors or invalid JSON as capability success or expose errors', async () => {
    const report = await probeProvider(
      target,
      async (request, emit) => {
        if (!request.tools) throw new Error('Authorization: private-key')
        emit({
          message: { tool_calls: [{ function: { name: 'capability_probe', arguments: '{' } }] }
        })
        return { ok: true }
      },
      new AbortController().signal
    )
    expect(report.checks.map((check) => check.status)).toEqual(['failed', 'failed', 'not-observed'])
    expect(JSON.stringify(report)).not.toContain('private-key')
  })
  it('does not run follow-up probes after cancellation', async () => {
    const controller = new AbortController()
    const stream = vi.fn(async () => {
      controller.abort()
      return { ok: true }
    })
    const report = await probeProvider(target, stream, controller.signal)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(report.checks[0].status).toBe('failed')
  })
})
