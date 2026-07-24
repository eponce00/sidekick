import { describe, expect, it } from 'vitest'
import { normalizeAgentPlanCompletion, normalizeAgentPlanContract } from './agentPlans'

function validPlan() {
  return {
    title: 'Ship the status change',
    objective: 'Update the status safely.',
    summary: 'Inspect, change, and verify the status export.',
    requirements: [
      {
        id: 'status-updated',
        outcome: 'The status export is updated.',
        acceptance: "src/status.ts exports 'after'."
      }
    ],
    steps: [
      {
        id: 'edit-status',
        title: 'Update status',
        description: 'Change the existing export.',
        requirement_ids: ['status-updated'],
        files: ['src/status.ts']
      }
    ],
    verification: [
      {
        id: 'test-status',
        description: 'Run the focused test.',
        expected: 'The status test passes.',
        requirement_ids: ['status-updated'],
        command: 'npm test -- status'
      }
    ]
  }
}

describe('agent plan contracts', () => {
  it('normalizes a verifiable contract and both requirement-id spellings', () => {
    const plan = normalizeAgentPlanContract(validPlan())

    expect(plan.requirements[0].id).toBe('status-updated')
    expect(plan.steps[0].requirementIds).toEqual(['status-updated'])
    expect(plan.verification[0].requirementIds).toEqual(['status-updated'])
  })

  it('rejects aspirational plans without acceptance criteria or valid traceability', () => {
    expect(() =>
      normalizeAgentPlanContract({
        ...validPlan(),
        requirements: [{ id: 'status-updated', outcome: 'Improve it' }]
      })
    ).toThrow('acceptance is required')

    expect(() =>
      normalizeAgentPlanContract({
        ...validPlan(),
        steps: [
          {
            id: 'edit-status',
            title: 'Update status',
            description: 'Change it.',
            requirement_ids: ['missing-requirement']
          }
        ]
      })
    ).toThrow('references unknown requirement')

    expect(() =>
      normalizeAgentPlanContract({
        ...validPlan(),
        requirements: [
          ...validPlan().requirements,
          { id: 'orphaned', outcome: 'Another result exists.', acceptance: 'It is observable.' }
        ]
      })
    ).toThrow('requirement orphaned is not covered')
  })

  it('requires evidence when completing a contract', () => {
    expect(() =>
      normalizeAgentPlanCompletion({
        revision: 'revision-1',
        summary: 'Done',
        requirements: [{ id: 'status-updated', status: 'passed', evidence: '' }]
      })
    ).toThrow('evidence is required')
  })
})
