import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { AgentPlanService } from './agentPlanService'
import { AgentRunStore } from './agentRunStore'

const contract = {
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
      requirement_ids: ['status-updated']
    }
  ],
  verification: [
    {
      id: 'test-status',
      description: 'Run the focused test.',
      expected: 'The status test passes.',
      requirement_ids: ['status-updated']
    }
  ]
}

describe('AgentPlanService', () => {
  let db: Database.Database
  let service: AgentPlanService

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    new AgentRunStore(db).start({
      id: 'run-1',
      threadId: 'thread-1',
      profile: { surface: 'conversation', executionMode: 'plan', capabilities: ['plan'] },
      provider: 'litellm',
      model: 'planner',
      workspaceRoot: '/workspace'
    })
    service = new AgentPlanService(db, 'run-1', 'planner', 'executor', 'planning')
  })

  it('persists an immutable review revision and seeds execution todos on approval', () => {
    const review = service.prepareReview(contract)
    expect(review.revision).toHaveLength(24)
    expect(service.get()).toMatchObject({
      stage: 'planning',
      plannerModel: 'planner',
      executorModel: 'executor',
      revision: review.revision
    })

    service.approve(review.revision)

    expect(service.stage()).toBe('executing')
    const row = db
      .prepare('SELECT todo_json FROM agent_run_todos WHERE run_id = ?')
      .get('run-1') as { todo_json: string }
    expect(JSON.parse(row.todo_json)).toEqual([
      expect.objectContaining({ id: 1, title: 'Update status', status: 'in-progress' })
    ])
    expect(() => service.approve('stale-revision')).toThrow('latest revision')
  })

  it('rejects completion until the exact contract has evidence and every step is done', () => {
    const review = service.prepareReview(contract)
    service.approve(review.revision)

    expect(
      service.complete({
        revision: review.revision,
        summary: 'Done',
        requirements: [{ id: 'status-updated', status: 'passed', evidence: 'npm test passed' }]
      })
    ).toMatchObject({ accepted: false, errors: ['1 approved plan step(s) are still unfinished'] })

    db.prepare('UPDATE agent_run_todos SET todo_json = ? WHERE run_id = ?').run('[]', 'run-1')
    expect(
      service.complete({
        revision: review.revision,
        summary: 'Done',
        requirements: [{ id: 'status-updated', status: 'passed', evidence: 'npm test passed' }]
      })
    ).toMatchObject({
      accepted: false,
      errors: ['1 approved plan step(s) are missing from the durable todo list']
    })

    db.prepare('UPDATE agent_run_todos SET todo_json = ? WHERE run_id = ?').run(
      JSON.stringify([
        {
          id: 1,
          title: 'Update status',
          description: 'Change the existing export.',
          status: 'completed'
        }
      ]),
      'run-1'
    )

    expect(
      service.complete({
        revision: 'old-revision',
        summary: 'Done',
        requirements: [{ id: 'status-updated', status: 'passed', evidence: 'npm test passed' }]
      })
    ).toMatchObject({
      accepted: false,
      errors: expect.arrayContaining(['The plan revision is stale'])
    })

    expect(
      service.complete({
        revision: review.revision,
        summary: 'Implemented and verified.',
        requirements: [{ id: 'status-updated', status: 'passed', evidence: 'npm test passed' }]
      })
    ).toMatchObject({ accepted: true, errors: [] })
    expect(service.afterTerminalTurn()).toEqual({ continue: false })
  })

  it('fails closed when completion reports a failed, inapplicable, or unknown requirement status', () => {
    const review = service.prepareReview(contract)
    service.approve(review.revision)
    db.prepare('UPDATE agent_run_todos SET todo_json = ? WHERE run_id = ?').run(
      JSON.stringify([
        {
          id: 1,
          title: 'Update status',
          description: 'Change the existing export.',
          status: 'completed'
        }
      ]),
      'run-1'
    )

    for (const status of ['failed', 'not_applicable', 'definitely'] as const) {
      expect(
        service.complete({
          revision: review.revision,
          summary: 'The check did not pass.',
          requirements: [{ id: 'status-updated', status, evidence: 'status test failed' }]
        })
      ).toMatchObject({ accepted: false, errors: expect.any(Array) })
    }
    expect(service.get()?.completion).toBeUndefined()
  })

  it('keeps unfinished Plan and Act runs alive for two bounded reminders', () => {
    expect(service.afterTerminalTurn()).toMatchObject({ continue: true })
    expect(service.afterTerminalTurn()).toMatchObject({ continue: true })
    expect(service.afterTerminalTurn()).toMatchObject({
      continue: false,
      error: expect.any(String)
    })

    const review = service.prepareReview(contract)
    service.approve(review.revision)
    expect(service.afterTerminalTurn()).toMatchObject({ continue: true })
  })
})
