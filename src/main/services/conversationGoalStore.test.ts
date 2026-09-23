import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { ConversationGoalStore, executeGoalUpdate } from './conversationGoalStore'
import type { ConversationGoal } from '../../shared/conversationGoals'

describe('ConversationGoalStore', () => {
  let db: Database.Database
  let publish: ReturnType<typeof vi.fn<(goal: ConversationGoal) => void>>
  let store: ConversationGoalStore

  beforeEach(() => {
    db = new Database(':memory:')
    applyDatabaseSchema(db)
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES ('conversation-1', 'Goal test', 1, 1)`
    ).run()
    publish = vi.fn<(goal: ConversationGoal) => void>()
    store = new ConversationGoalStore(db, publish)
  })

  it('persists one durable unfinished goal per conversation', () => {
    const goal = store.create({
      conversationId: 'conversation-1',
      objective: 'Make the test suite pass and verify it.'
    })

    expect(store.current('conversation-1')).toEqual(goal)
    expect(() =>
      store.create({ conversationId: 'conversation-1', objective: 'Competing goal' })
    ).toThrow(/unfinished goal/i)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }))
  })

  it('requires the same blocker three consecutive times', () => {
    const goal = store.create({ conversationId: 'conversation-1', objective: 'Ship it' })

    expect(store.reportBlocked(goal.id, 'missing-token', 'Token is unavailable').status).toBe(
      'active'
    )
    expect(
      store.reportBlocked(goal.id, 'different-blocker', 'Network is unavailable')
    ).toMatchObject({ status: 'active', blockedStreak: 1 })
    expect(
      store.reportBlocked(goal.id, 'different-blocker', 'Network is unavailable')
    ).toMatchObject({ status: 'active', blockedStreak: 2 })
    expect(
      store.reportBlocked(goal.id, 'different-blocker', 'Network is unavailable')
    ).toMatchObject({ status: 'blocked', blockedStreak: 3 })
  })

  it('rejects premature completion and records verification after the plan is done', () => {
    const goal = store.create({ conversationId: 'conversation-1', objective: 'Fix and test' })
    store.updatePlan(goal.id, [
      { id: 1, title: 'Fix', description: 'Implement fix', status: 'in-progress' }
    ])

    expect(() => store.complete(goal.id, 'Done', 'npm test')).toThrow(/unfinished item/i)

    store.updatePlan(goal.id, [
      { id: 1, title: 'Fix', description: 'Implement fix', status: 'completed' }
    ])
    expect(store.complete(goal.id, 'Fixed the issue', 'npm test passed')).toMatchObject({
      status: 'completed',
      completionSummary: 'Fixed the issue',
      completionVerification: 'npm test passed'
    })
  })

  it('aggregates provider usage across goal turns', () => {
    const goal = store.create({ conversationId: 'conversation-1', objective: 'Measure work' })

    store.addUsage(goal.id, 120, 30)
    expect(store.addUsage(goal.id, 80, 20)).toMatchObject({
      promptTokens: 200,
      completionTokens: 50
    })
  })

  it('pauses active goals during restart recovery without clearing them', () => {
    const goal = store.create({ conversationId: 'conversation-1', objective: 'Long task' })

    expect(store.pauseActiveAfterRestart()[0]).toMatchObject({
      id: goal.id,
      status: 'paused'
    })
    expect(store.get(goal.id)?.currentRunId).toBeUndefined()
  })

  it('does not resurrect an older goal after the latest goal is cleared', () => {
    const first = store.create({ conversationId: 'conversation-1', objective: 'First' })
    store.complete(first.id, 'First done', 'Verified first')
    const second = store.create({ conversationId: 'conversation-1', objective: 'Second' })
    store.clear(second.id)

    expect(store.current('conversation-1')).toBeNull()
  })

  describe('update_goal', () => {
    const completion = {
      status: 'complete',
      summary: 'Built the card.',
      verification: 'The fetch returned 200 with current conditions.'
    }

    it('answers a second completion as already done rather than as a failure', () => {
      // A second call used to throw, which reached the model as an internal
      // error telling it to stop, without saying the goal was finished.
      const goal = store.create({ conversationId: 'conversation-1', objective: 'Build a card' })
      expect(executeGoalUpdate(store, goal.id, completion)).toMatchObject({ status: 'completed' })

      const again = executeGoalUpdate(store, goal.id, completion)

      expect(again).toMatchObject({ status: 'completed', alreadyComplete: true })
      expect(String(again.message)).toContain('Do not call update_goal again')
      expect(store.get(goal.id)?.completionVerification).toBe(completion.verification)
    })

    it('asks for verification before completing, then accepts the next request', () => {
      const goal = store.create({ conversationId: 'conversation-1', objective: 'Fix the bug' })
      const beforeCompletion = vi
        .fn()
        .mockReturnValueOnce({ continue: true, prompt: 'Verify the changed files first.' })
        .mockReturnValueOnce({ continue: false })

      const refused = executeGoalUpdate(store, goal.id, completion, beforeCompletion)
      expect(refused).toMatchObject({ status: 'active', completed: false })
      expect(store.get(goal.id)?.status).toBe('active')

      const accepted = executeGoalUpdate(store, goal.id, completion, beforeCompletion)
      expect(accepted).toMatchObject({ status: 'completed' })
      expect(String(accepted.next)).toContain('call no more tools')
    })
  })
})
