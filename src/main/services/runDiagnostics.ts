import type Database from 'better-sqlite3'
import { TOOL_ERROR_CODES } from '../../shared/agentRuntime'
import { COMPACTION_FALLBACK_REASONS } from '../../shared/conversationCompactions'

/** Aggregate only allowlisted classifications. Never export payloads or run identities. */
export function recentRunDiagnostics(db: Database.Database): {
  runLimit: number
  toolEventLimitPerRun: number
  runs: number
  outcomes: Record<string, number>
  toolErrors: Record<string, number>
  compactions: { model: number; deterministic: number; fallbackReasons: Record<string, number> }
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
  const compactionEvents = db.prepare(`SELECT
    json_extract(payload_json, '$.strategy') AS strategy,
    json_extract(payload_json, '$.fallbackReason') AS reason
    FROM agent_run_events WHERE run_id = ? AND type = 'compaction.completed'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.compacted') = 1 ELSE 0 END`)
  const compactions = { model: 0, deterministic: 0, fallbackReasons: {} as Record<string, number> }
  const reasons = new Set<string>(COMPACTION_FALLBACK_REASONS)
  for (const row of rows) {
    const phase = phases.has(row.phase) ? row.phase : 'other'
    outcomes[phase] = (outcomes[phase] || 0) + 1
    for (const event of errors.all(row.id, toolEventLimitPerRun) as { code: unknown }[]) {
      if (event.code === null) continue
      const code = typeof event.code === 'string' && codes.has(event.code) ? event.code : 'unknown'
      toolErrors[code] = (toolErrors[code] || 0) + 1
    }
    for (const event of compactionEvents.all(row.id) as { strategy: unknown; reason: unknown }[]) {
      if (event.strategy !== 'deterministic') {
        compactions.model += 1
        continue
      }
      compactions.deterministic += 1
      const reason =
        typeof event.reason === 'string' && reasons.has(event.reason)
          ? event.reason
          : event.reason == null
            ? 'unrecorded'
            : 'unknown'
      compactions.fallbackReasons[reason] = (compactions.fallbackReasons[reason] || 0) + 1
    }
  }
  return { runLimit, toolEventLimitPerRun, runs: rows.length, outcomes, toolErrors, compactions }
}
