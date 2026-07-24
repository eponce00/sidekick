import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_WAIT_SECONDS, normalizeAgentWaitSeconds, waitForAgentDelay } from './agentWait'

describe('agent wait', () => {
  afterEach(() => vi.useRealTimers())

  it('normalizes model input to the supported bounded duration', () => {
    expect(normalizeAgentWaitSeconds(undefined)).toBe(1)
    expect(normalizeAgentWaitSeconds(12.6)).toBe(13)
    expect(normalizeAgentWaitSeconds(999)).toBe(MAX_AGENT_WAIT_SECONDS)
  })

  it('completes after the requested duration', async () => {
    vi.useFakeTimers()
    const result = waitForAgentDelay(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toEqual({
      completed: true,
      requestedSeconds: 2,
      waitedMs: 2_000
    })
  })

  it('returns immediately when the run is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForAgentDelay(200, { signal: controller.signal })).resolves.toMatchObject({
      completed: false,
      requestedSeconds: 200,
      reason: 'cancelled'
    })
  })
})
