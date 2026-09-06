import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { recentRunDiagnostics } from './runDiagnostics'

it('exports only bounded, allowlisted aggregates, never raw run or tool data', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE agent_runs(id TEXT, phase TEXT, started_at INTEGER);
      CREATE TABLE agent_run_events(run_id TEXT, type TEXT, payload_json TEXT);`)
    const insertRun = db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)')
    for (let i = 0; i < 105; i++)
      insertRun.run(`secret-id-${i}`, i === 104 ? 'secret-phase' : 'completed', i)
    const insert = db.prepare('INSERT INTO agent_run_events VALUES (?, ?, ?)')
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
      toolErrors: { timeout: 1, unknown: 1 }
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|sk-/)
  } finally {
    db.close()
  }
})
