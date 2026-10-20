import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { recentRunDiagnostics } from './runDiagnostics'
import { emptyCutOffSummary, emptyRunawaySummary } from './toolBatchCutOff'

it('exports only bounded, allowlisted aggregates, never raw run or tool data', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE agent_runs(id TEXT, phase TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events(
        run_id TEXT, sequence INTEGER PRIMARY KEY, type TEXT, payload_json TEXT);`)
    const insertRun = db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)')
    for (let i = 0; i < 105; i++)
      insertRun.run(`secret-id-${i}`, i === 104 ? 'secret-phase' : 'completed', i)
    const insert = db.prepare(
      'INSERT INTO agent_run_events (run_id, type, payload_json) VALUES (?, ?, ?)'
    )
    insert.run(
      'secret-id-104',
      'tool.completed',
      JSON.stringify({
        result: { error: { code: 'timeout', message: 'private chat' } },
        arguments: 'sk-private'
      })
    )
    insert.run(
      'secret-id-104',
      'tool.completed',
      JSON.stringify({ result: { error: { code: 'private-code' } } })
    )
    insert.run(
      'secret-id-0',
      'tool.completed',
      JSON.stringify({ result: { error: { code: 'timeout' } } })
    )
    const result = recentRunDiagnostics(db)
    expect(result).toEqual({
      runLimit: 100,
      toolEventLimitPerRun: 10000,
      runs: 100,
      outcomes: { completed: 99, other: 1 },
      toolErrors: { timeout: 1, unknown: 1 },
      cutOffTurns: emptyCutOffSummary(),
      runawayTurns: emptyRunawaySummary()
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|sk-/)
  } finally {
    db.close()
  }
})

it('counts cut-off and runaway replies by reply, with numbers only', () => {
  // A diagnostics export counted 767 calls refused as `output_truncated` in 100 runs. All of them
  // came from one reply that wrote 784 calls, 781 of them the same click; counted by call, that
  // one runaway read as a problem in every run.
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE agent_runs(id TEXT, phase TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events(
        run_id TEXT, sequence INTEGER PRIMARY KEY, type TEXT, payload_json TEXT);`)
    db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)').run('older', 'failed', 1)
    db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)').run('newer', 'completed', 2)
    const insert = db.prepare(
      'INSERT INTO agent_run_events (run_id, type, payload_json) VALUES (?, ?, ?)'
    )
    const add = (run: string, type: string, payload: object) =>
      insert.run(run, type, JSON.stringify(payload))
    // The 0.16.2 journal: the reply's calls as previews, then the cut with its batch size.
    const clicks = Array.from({ length: 784 }, (_, index) => ({
      id: `call-${index}`,
      name: 'browser_click',
      arguments: index < 781 ? {} : { text: `private ${index}` }
    }))
    add('older', 'assistant.completed', { content: 'private reply', toolCalls: clicks })
    add('older', 'run.retrying', {
      reason: 'truncated_tool_batch',
      doneReason: 'private-stop-reason',
      toolCallCount: 784
    })
    // A newer journal: a reply SideKick stopped, and two cuts in a row at a shrunken limit.
    add('newer', 'assistant.completed', {
      content: 'private',
      toolCalls: [],
      runaway: { kind: 'repeated_call', toolCallCount: 5, identicalCalls: 4, toolName: 'wait' }
    })
    const cutOff = {
      trigger: 'stop_reason',
      doneReason: 'length',
      completionTokens: 1_024,
      replyLimit: 1_024,
      maxOutputTokens: 8_192,
      toolCallCount: 2
    }
    for (let index = 0; index < 2; index++) {
      add('newer', 'assistant.completed', {
        toolCalls: [
          { name: 'write_file', arguments: { file_path: 'a.ts' } },
          { name: 'write_file', arguments: { file_path: 'b.ts' } }
        ],
        outputLimit: cutOff
      })
      add('newer', 'run.retrying', { reason: 'truncated_tool_batch', ...cutOff })
    }

    const result = recentRunDiagnostics(db)
    expect(result.cutOffTurns).toEqual({
      turns: 3,
      refusedCalls: 788,
      multiCallTurns: 3,
      repeatedTurns: 1,
      byTrigger: { stop_reason: 2, used_allowance: 1 },
      byLimit: { shrunk: 2, full: 0, unrecorded: 1 },
      byUsage: { at_limit: 2, over_limit: 0, under_limit: 0, unrecorded: 1 }
    })
    expect(result.runawayTurns).toEqual({
      turns: 2,
      stopped: 1,
      largestCallCount: 784,
      largestIdenticalCount: 781
    })
    expect(JSON.stringify(result)).not.toMatch(/private|length|older|newer|click|wait/)
  } finally {
    db.close()
  }
})
