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

  it('keeps the latest request a run recorded both counts for, even when its last sample lacks one', () => {
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
        payload_json: JSON.stringify({
          promptTokens: 40_000,
          completionTokens: 200,
          estimatedPromptTokens: 52_000
        }),
        sequence: 2
      },
      {
        // A reply SideKick stopped while it streamed records its usage without an estimate.
        run_id: 'run-1',
        type: 'usage.updated',
        payload_json: JSON.stringify({ promptTokens: 41_000, completionTokens: 900 }),
        sequence: 3
      }
    ])

    expect(usage.get('message-1')).toEqual({
      promptTokens: 41_000,
      completionTokens: 900,
      calibration: { promptTokens: 40_000, estimatedPromptTokens: 52_000 }
    })
  })
})
