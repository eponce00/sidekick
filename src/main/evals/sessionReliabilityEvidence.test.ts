import { expect, it } from 'vitest'
import { summarizeReliabilityRun, shouldStopReliabilityBatch } from './sessionReliabilityEvidence'
import type { AgentKernelScenarioResult } from './agentScenarioHarness'
import { createHash } from 'node:crypto'

it('keeps first patch, recovery, cancellation and finalization accounting distinct', () => {
  const result = {
    phase: 'completed',
    toolRounds: 3,
    events: [
      { type: 'tool.completed', payload: { name: 'read', result: { status: 'error' } } },
      { type: 'tool.completed', payload: { name: 'apply_patch', result: { status: 'error' } } },
      { type: 'tool.completed', payload: { name: 'apply_patch', result: { status: 'success' } } },
      { type: 'run.completed', payload: {} }
    ]
  } as unknown as AgentKernelScenarioResult
  expect(summarizeReliabilityRun(result)).toMatchObject({
    phase: 'completed',
    firstPatchAccepted: false,
    successfulPatches: 1,
    toolErrors: 2,
    injectedToolErrors: 0,
    unforcedToolErrors: 2,
    cleanOneShotEligible: true,
    toolRounds: 3,
    terminalEvents: 1
  })
  expect(
    summarizeReliabilityRun({ ...result, phase: 'cancelled', events: [] }).firstPatchAccepted
  ).toBeNull()
  expect(
    summarizeReliabilityRun({ ...result, phase: 'cancelled', events: [] }).cleanOneShotEligible
  ).toBe(false)
})

it('halts infrastructure failures without exposing errors or treating injected tool errors as outages', () => {
  const base = {
    phase: 'failed',
    error: 'Request timed out: private-key',
    events: [],
    toolRounds: 0
  } as unknown as AgentKernelScenarioResult
  const timeout = summarizeReliabilityRun(base)
  expect(timeout.terminalFailure).toBe('timeout')
  expect(shouldStopReliabilityBatch(timeout)).toBe(true)
  expect(JSON.stringify(timeout)).not.toContain('private-key')
  expect(
    shouldStopReliabilityBatch(
      summarizeReliabilityRun({ ...base, error: 'unknown provider failure' })
    )
  ).toBe(true)
  expect(
    shouldStopReliabilityBatch(summarizeReliabilityRun({ ...base, phase: 'cancelled' }), true)
  ).toBe(false)
  expect(shouldStopReliabilityBatch(summarizeReliabilityRun({ ...base, phase: 'cancelled' }))).toBe(
    true
  )
  expect(
    shouldStopReliabilityBatch(
      summarizeReliabilityRun({
        ...base,
        phase: 'completed',
        events: [
          { type: 'tool.completed', payload: { name: 'apply_patch', result: { status: 'error' } } }
        ]
      } as unknown as AgentKernelScenarioResult)
    )
  ).toBe(false)
})

it('separates known fixture failures and emits only allowlisted diagnostics', () => {
  const result = {
    phase: 'completed',
    toolRounds: 3,
    events: [
      {
        type: 'tool.completed',
        payload: {
          toolCallId: 'injected',
          name: 'apply_patch',
          result: { status: 'error', error: { code: 'internal', message: 'private fixture text' } }
        }
      },
      {
        type: 'tool.completed',
        payload: {
          toolCallId: 'natural',
          name: 'apply_patch',
          result: {
            status: 'error',
            error: { code: 'invalid_arguments', message: 'Invalid patch: private source text' }
          }
        }
      },
      {
        type: 'tool.completed',
        payload: {
          toolCallId: 'secret-id',
          name: 'private tool name',
          result: { status: 'error', error: { code: 'private code', message: 'private content' } }
        }
      },
      { type: 'tool.completed', payload: { name: 'apply_patch', result: { status: 'success' } } }
    ]
  } as unknown as AgentKernelScenarioResult
  const summary = summarizeReliabilityRun(result, new Set(['injected']))
  expect(summary).toMatchObject({
    firstPatchAccepted: false,
    injectedToolErrors: 1,
    unforcedToolErrors: 2,
    cleanOneShotEligible: false
  })
  expect(summary.toolOutcomes).toEqual([
    {
      tool: 'apply_patch',
      status: 'error',
      code: 'internal',
      injected: true,
      category: 'fixture_injected'
    },
    {
      tool: 'apply_patch',
      status: 'error',
      code: 'invalid_arguments',
      injected: false,
      category: 'patch_grammar'
    },
    { tool: 'other', status: 'error', code: null, injected: false, category: 'other' },
    { tool: 'apply_patch', status: 'success', code: null, injected: false, category: null }
  ])
  expect(JSON.stringify(summary)).not.toMatch(/private|secret-id|source text/)
})

it('distinguishes correction writes, unchanged updates and extra files without retaining content or hashes', () => {
  const hash = (content: string) => createHash('sha256').update(content).digest('hex')
  const before = 'private initial content\n'
  const after = 'private expected content\n'
  const changes = [
    {
      path: 'private-target.txt',
      kind: 'update',
      beforeHash: hash(before),
      afterHash: hash(after + '\n')
    },
    {
      path: 'private-target.txt',
      kind: 'update',
      beforeHash: hash(after + '\n'),
      afterHash: hash(after)
    },
    { path: 'private-extra.txt', kind: 'create', afterHash: hash('private extra content') },
    { path: 'private-target.txt', kind: 'update', beforeHash: hash(after), afterHash: hash(after) }
  ]
  const result = {
    phase: 'completed',
    toolRounds: 4,
    events: changes.map((change) => ({
      type: 'tool.completed',
      payload: { name: 'apply_patch', result: { status: 'success', changes: [change] } }
    }))
  } as unknown as AgentKernelScenarioResult
  const summary = summarizeReliabilityRun(result, new Set(), {
    path: 'private-target.txt',
    before,
    after
  })
  expect(summary.successfulPatches).toBe(4)
  expect(summary.mutationOutcomes).toMatchObject([
    {
      evidenceAvailable: true,
      fileCount: 1,
      nonTargetFileCount: 0,
      unchangedUpdateCount: 0,
      operations: [
        { kind: 'update', target: true, before: 'initial', after: 'expected_extra_final_newline' }
      ]
    },
    {
      fileCount: 1,
      unchangedUpdateCount: 0,
      operations: [{ before: 'expected_extra_final_newline', after: 'expected' }]
    },
    {
      nonTargetFileCount: 1,
      operations: [{ kind: 'create', target: false, before: 'unclassified', after: 'unclassified' }]
    },
    { unchangedUpdateCount: 1, operations: [{ before: 'expected', after: 'expected' }] }
  ])
  expect(JSON.stringify(summary)).not.toContain('private')
  expect(JSON.stringify(summary)).not.toContain(hash(after))
})
