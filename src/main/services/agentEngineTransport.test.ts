import { describe, expect, it, vi } from 'vitest'
import { AGENT_ENGINE_PROTOCOL_VERSION } from '../../shared/agentEngineProtocol'
import type { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { AgentEngineClient, LocalAgentEngineTransport } from './agentEngineTransport'

describe('agent engine transport', () => {
  it('round trips commands through the versioned boundary', async () => {
    const runtime = {
      hasActiveRuns: vi.fn(() => true)
    } as unknown as AgentRuntimeCoordinator
    const client = new AgentEngineClient(new LocalAgentEngineTransport(runtime))

    await expect(client.request<boolean>({ type: 'engine.hasActiveRuns' })).resolves.toBe(true)
  })

  it('rejects incompatible protocol versions before dispatch', async () => {
    const runtime = { hasActiveRuns: vi.fn() } as unknown as AgentRuntimeCoordinator
    const transport = new LocalAgentEngineTransport(runtime)
    const response = await transport.request({
      version: (AGENT_ENGINE_PROTOCOL_VERSION + 1) as typeof AGENT_ENGINE_PROTOCOL_VERSION,
      requestId: 'request-1',
      command: { type: 'engine.hasActiveRuns' }
    })

    expect(response.ok).toBe(false)
    expect(runtime.hasActiveRuns).not.toHaveBeenCalled()
  })

  it('rejects unknown commands rather than silently returning undefined', async () => {
    const runtime = { hasActiveRuns: vi.fn() } as unknown as AgentRuntimeCoordinator
    const transport = new LocalAgentEngineTransport(runtime)
    const response = await transport.request({
      version: AGENT_ENGINE_PROTOCOL_VERSION,
      requestId: 'request-2',
      command: { type: 'engine.unknown' } as never
    })

    expect(response.ok).toBe(false)
  })
})
