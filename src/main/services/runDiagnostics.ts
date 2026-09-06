import type Database from 'better-sqlite3'
import { TOOL_ERROR_CODES } from '../../shared/agentRuntime'

/** Aggregate only allowlisted classifications. Never export payloads or run identities. */
export function recentRunDiagnostics(db: Database.Database): {
  runLimit: number
  toolEventLimitPerRun: number
  runs: number
  outcomes: Record<string, number>
  toolErrors: Record<string, number>
} {
  const runLimit = 100
  const toolEventLimitPerRun = 10000
  const rows = db
    .prepare(`SELECT id, phase FROM agent_runs ORDER BY started_at DESC LIMIT ?`)
    .all(runLimit) as { id: string; phase: string }[]
  const outcomes: Record<string, number> = {}
  const toolErrors: Record<string, number> = {}
  const phases = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
  const codes = new Set<string>(TOOL_ERROR_CODES)
  const errors = db.prepare(`SELECT CASE WHEN json_valid(payload_json)
    THEN json_extract(payload_json, '$.result.error.code') ELSE NULL END AS code
    FROM agent_run_events WHERE run_id = ? AND type = 'tool.completed' LIMIT ?`)
  for (const row of rows) {
    const phase = phases.has(row.phase) ? row.phase : 'other'
    outcomes[phase] = (outcomes[phase] || 0) + 1
    for (const event of errors.all(row.id, toolEventLimitPerRun) as { code: unknown }[]) {
      if (event.code === null) continue
      const code = typeof event.code === 'string' && codes.has(event.code) ? event.code : 'unknown'
      toolErrors[code] = (toolErrors[code] || 0) + 1
    }
  }
  return { runLimit, toolEventLimitPerRun, runs: rows.length, outcomes, toolErrors }
}
