import type Database from 'better-sqlite3'
import { TOOL_ERROR_CODES } from '../../shared/agentRuntime'
import { COMPACTION_FALLBACK_REASONS } from '../../shared/conversationCompactions'
import {
  ToolCallTurnCounter,
  type CutOffTurnSummary,
  type RunawayTurnSummary
} from './toolBatchCutOff'

/**
 * The events of one run that say whether its replies were cut off or ran away while they wrote
 * tool calls. Only the fields counted are read; a reply's text never leaves the database here.
 */
export function toolCallTurnQuery(db: Database.Database): Database.Statement {
  return db.prepare(`SELECT type,
      CASE WHEN type = 'assistant.completed' AND json_valid(payload_json)
        THEN json_extract(payload_json, '$.toolCalls') END AS toolCalls,
      CASE WHEN type = 'assistant.completed' AND json_valid(payload_json)
        THEN json_extract(payload_json, '$.runaway') END AS runaway,
      CASE WHEN type = 'run.retrying' AND json_valid(payload_json)
        AND json_extract(payload_json, '$.reason') = 'truncated_tool_batch'
        THEN json_object(
          'doneReason', json_extract(payload_json, '$.doneReason'),
          'trigger', json_extract(payload_json, '$.trigger'),
          'toolCallCount', json_extract(payload_json, '$.toolCallCount'),
          'completionTokens', json_extract(payload_json, '$.completionTokens'),
          'replyLimit', json_extract(payload_json, '$.replyLimit'),
          'maxOutputTokens', json_extract(payload_json, '$.maxOutputTokens')) END AS cutOff
    FROM agent_run_events
    WHERE run_id = ? AND type IN ('assistant.completed', 'run.retrying')
    ORDER BY sequence`)
}

export interface ToolCallTurnRow {
  type: string
  toolCalls: string | null
  runaway: string | null
  cutOff: string | null
}

function parsed(json: string | null): unknown {
  if (!json) return undefined
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** Feeds one run's events, in order, to a counter. */
export function countToolCallTurns(counter: ToolCallTurnCounter, rows: ToolCallTurnRow[]): void {
  counter.startRun()
  for (const row of rows) {
    if (row.type === 'assistant.completed') counter.turn(parsed(row.toolCalls), parsed(row.runaway))
    else if (row.cutOff) {
      // Absent fields come back as JSON null; an older run recorded only some of them.
      const payload = Object.fromEntries(
        Object.entries(parsed(row.cutOff) as Record<string, unknown>).filter(
          ([, value]) => value !== null
        )
      )
      counter.cutTurn(payload)
    }
  }
}

/** Aggregate only allowlisted classifications. Never export payloads or run identities. */
export function recentRunDiagnostics(db: Database.Database): {
  runLimit: number
  toolEventLimitPerRun: number
  runs: number
  outcomes: Record<string, number>
  toolErrors: Record<string, number>
  /** Replies cut off while they wrote tool calls, counted by reply, not by refused call. */
  cutOffTurns: CutOffTurnSummary
  runawayTurns: RunawayTurnSummary
  compactions: {
    model: number
    deterministic: number
    /** Tool results shortened to fit, with no summary written. */
    cutToolResults: number
    fallbackReasons: Record<string, number>
  }
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
  const compactions = {
    model: 0,
    deterministic: 0,
    cutToolResults: 0,
    fallbackReasons: {} as Record<string, number>
  }
  const reasons = new Set<string>(COMPACTION_FALLBACK_REASONS)
  const turns = toolCallTurnQuery(db)
  const counter = new ToolCallTurnCounter()
  for (const row of rows) {
    const phase = phases.has(row.phase) ? row.phase : 'other'
    outcomes[phase] = (outcomes[phase] || 0) + 1
    for (const event of errors.all(row.id, toolEventLimitPerRun) as { code: unknown }[]) {
      if (event.code === null) continue
      const code = typeof event.code === 'string' && codes.has(event.code) ? event.code : 'unknown'
      toolErrors[code] = (toolErrors[code] || 0) + 1
    }
    for (const event of compactionEvents.all(row.id) as { strategy: unknown; reason: unknown }[]) {
      if (event.strategy === 'cut_tool_results') {
        compactions.cutToolResults += 1
        continue
      }
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
    countToolCallTurns(counter, turns.all(row.id) as ToolCallTurnRow[])
  }
  return {
    runLimit,
    toolEventLimitPerRun,
    runs: rows.length,
    outcomes,
    toolErrors,
    cutOffTurns: counter.cutOff,
    runawayTurns: counter.runaway,
    compactions
  }
}
