import { describe, expect, it } from 'vitest'
import { contextUsageByOutputMessage } from './agentRunContextUsage'

describe('contextUsageByOutputMessage', () => {
  it('uses the final provider sample instead of summing tool-loop prompts', () => {
    const usage = contextUsageByOutputMessage([
      {
        run_id: 'run-1',
        type: 'run.started',
        payload_json: JSON.stringify({ outputMessageId: 'message-1' }),
        sequence: 1
      },
      {
        run_id: 'run-1',
        type: 'usage.updated',
        payload_json: JSON.stringify({ promptTokens: 40_000, completionTokens: 200 }),
        sequence: 2
      },
      {
        run_id: 'run-1',
        type: 'usage.updated',
        payload_json: JSON.stringify({ promptTokens: 48_213, completionTokens: 776 }),
        sequence: 3
      }
    ])

    expect(usage.get('message-1')).toEqual({ promptTokens: 48_213, completionTokens: 776 })
  })
})
