import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDatabaseSchema } from '../bootstrap/database'
import { auditRuns, formatRunAudit, type RunAuditFinding } from './runAudit'

let db: Database.Database
let sequence = 0

beforeEach(() => {
  db = new Database(':memory:')
  applyDatabaseSchema(db)
  db.exec(`
    INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('manager', 'Manager', 1, 1), ('worker', 'Worker', 1, 1);
  `)
  sequence = 0
})

afterEach(() => db.close())

function run(id: string, startedAt = 1_000): void {
  db.prepare(
    `INSERT INTO agent_runs (id, thread_id, surface, phase, provider, model, profile_json, started_at, updated_at)
     VALUES (?, 'manager', 'conversation', 'completed', 'openai-compatible', 'local', '{}', ?, ?)`
  ).run(id, startedAt, startedAt)
}

function event(runId: string, type: string, payload: object, at: number): void {
  sequence += 1
  db.prepare(
    `INSERT INTO agent_run_events (id, run_id, sequence, type, payload_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`e${sequence}`, runId, sequence, type, JSON.stringify(payload), at)
}

/** A compaction on a 260k window, after the model last reported `prompt` tokens. */
function compaction(runId: string, prompt: number, at: number, extra: object = {}): void {
  event(runId, 'usage.updated', { promptTokens: prompt }, at)
  event(runId, 'compaction.started', { reason: 'preflight_budget' }, at + 1_000)
  event(
    runId,
    'compaction.completed',
    {
      compacted: true,
      reason: 'preflight_budget',
      contextLength: 260_000,
      contextReliable: true,
      strategy: 'model',
      ...extra
    },
    at + 31_000
  )
  event(runId, 'usage.updated', { promptTokens: 22_000 }, at + 40_000)
}

function finding(check: string): RunAuditFinding {
  const found = auditRuns(db).findings.find((item) => item.check === check)
  if (!found) throw new Error(`No ${check} finding`)
  return found
}

describe('auditRuns', () => {
  it('flags a chat summarized long before its window filled', () => {
    // The shape seen before the fix: a 100k reply limit held back made compaction fire at 37%.
    run('early-run')
    event('early-run', 'run.phase', { phase: 'streaming' }, 1_000)
    compaction('early-run', 95_000, 2_000)
    run('late-run')
    event('late-run', 'run.phase', { phase: 'streaming' }, 1_000)
    compaction('late-run', 210_000, 2_000)

    const point = finding('compaction-point')
    expect(point.severity).toBe('flag')
    expect(point.count).toBe(1)
    expect(point.examples[0]).toContain('at 37% of 260,000')
    expect(finding('compaction-kept').summary).toContain('median of 8%')
    expect(finding('compaction-time').summary).toContain('median of 30 s')
  })

  it('does not flag compactions near the end of the window', () => {
    run('late-run')
    compaction('late-run', 210_000, 2_000)
    expect(finding('compaction-point').severity).toBe('info')
  })

  it('flags a high share of fallback summaries and runs that compact again and again', () => {
    run('busy')
    for (let index = 0; index < 4; index++) {
      compaction('busy', 210_000, 2_000 + index * 60_000, { strategy: 'deterministic' })
    }
    expect(finding('compaction-fallback')).toMatchObject({ severity: 'flag', count: 4 })
    expect(finding('compaction-repeat')).toMatchObject({ severity: 'flag', count: 1 })
  })

  it('says why each fallback summary was used', () => {
    run('why')
    compaction('why', 210_000, 2_000, { strategy: 'deterministic', fallbackReason: 'timeout' })
    compaction('why', 210_000, 70_000, { strategy: 'deterministic', fallbackReason: 'timeout' })
    // Journals before the reason was recorded.
    compaction('why', 210_000, 140_000, { strategy: 'deterministic' })
    expect(finding('compaction-fallback').examples).toEqual(['timeout × 2', 'unrecorded × 1'])
  })

  it("reports how SideKick's estimate compared with the provider's count", () => {
    run('estimates')
    event(
      'estimates',
      'usage.updated',
      { promptTokens: 100_000, estimatedPromptTokens: 130_000 },
      2_000
    )
    event(
      'estimates',
      'usage.updated',
      { promptTokens: 100_000, estimatedPromptTokens: 120_000 },
      3_000
    )
    event('estimates', 'usage.updated', { promptTokens: 100_000 }, 4_000)
    expect(finding('estimate-accuracy')).toMatchObject({
      severity: 'info',
      count: 2,
      summary:
        "SideKick's estimate of a request was a median of 125% of the provider's own count (120%–130%)."
    })
  })

  it('flags requests that did not fit the window, and retry storms', () => {
    run('overflow')
    event('overflow', 'run.retrying', { reason: 'context_window_exceeded' }, 2_000)
    for (let index = 0; index < 5; index++) {
      event('overflow', 'run.retrying', { reason: 'transient_provider_error' }, 3_000 + index)
    }
    expect(finding('context-overflow')).toMatchObject({ severity: 'flag', count: 1 })
    const storm = finding('retry-storm')
    expect(storm).toMatchObject({ severity: 'flag', count: 1 })
    expect(storm.examples[0]).toContain('transient_provider_error × 5')
  })

  it('does not count the retries the harness makes on purpose', () => {
    run('verified')
    for (let index = 0; index < 8; index++) {
      event(
        'verified',
        'run.retrying',
        { reason: 'workspace_verification_required' },
        2_000 + index
      )
    }
    expect(finding('retry-storm').severity).toBe('info')
  })

  it('flags a working run that went quiet, but not one waiting for the user', () => {
    run('quiet')
    event('quiet', 'run.phase', { phase: 'compacting' }, 1_000)
    event('quiet', 'run.phase', { phase: 'streaming' }, 1_000 + 12 * 60_000)
    run('waiting')
    event('waiting', 'run.phase', { phase: 'awaiting_user' }, 1_000)
    event('waiting', 'run.phase', { phase: 'streaming' }, 1_000 + 60 * 60_000)

    const quiet = finding('quiet-run')
    expect(quiet).toMatchObject({ severity: 'flag', count: 1 })
    expect(quiet.examples[0]).toContain('12 min while compacting')
  })

  it('does not count the time SideKick was closed as a run going quiet', () => {
    // The interruption is written when SideKick starts again, hours after it closed.
    run('closed')
    event('closed', 'run.phase', { phase: 'streaming' }, 1_000)
    event('closed', 'run.completed', { phase: 'interrupted' }, 1_000 + 300 * 60_000)
    run('cancelled')
    event('cancelled', 'run.completed', { phase: 'cancelled' }, 1_000)
    event('cancelled', 'run.finalized', { recovered: true }, 1_000 + 600 * 60_000)

    const quiet = finding('quiet-run')
    expect(quiet).toMatchObject({ severity: 'info', count: 0 })
    expect(quiet.summary).toContain('1 runs ended because SideKick closed')
  })

  it('flags a worker report that did not carry the whole reply', () => {
    // The shape seen before the fix: reports cut at 2,000 characters.
    const reply = 'finding '.repeat(800).trim()
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, timestamp)
       VALUES ('reply', 'worker', 'assistant', ?, 10)`
    ).run(reply)
    const insertReport = db.prepare(
      `INSERT INTO session_messages (id, from_conversation_id, to_conversation_id, intent, body, created_at)
       VALUES (?, 'worker', 'manager', 'report', ?, 20)`
    )
    insertReport.run('cut-report', `Done.\n\n${reply.slice(0, 1_999)}…`)
    insertReport.run('whole-report', `Done.\n\n${reply}`)

    const reports = finding('report-cut')
    expect(reports).toMatchObject({ severity: 'flag', count: 1 })
    expect(reports.summary).toContain('1 of 2 worker reports')
  })

  it('reads only runs started after the given time', () => {
    run('old', 1_000)
    compaction('old', 95_000, 2_000)
    run('new', 50_000)
    compaction('new', 210_000, 60_000)
    const audit = auditRuns(db, { since: 10_000 })
    expect(audit.runs).toBe(1)
    expect(audit.findings.find((item) => item.check === 'compaction-point')?.count).toBe(0)
  })

  it('formats a readable summary that never includes message content', () => {
    run('early-run')
    compaction('early-run', 95_000, 2_000, { summary: 'SECRET handoff text' })
    const text = formatRunAudit(auditRuns(db))
    expect(text).toContain('✗ compaction-point')
    expect(text).toContain('checks flagged.')
    expect(text).not.toContain('SECRET')
  })
})
