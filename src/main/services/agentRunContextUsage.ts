import type Database from 'better-sqlite3'

export interface AgentRunContextUsage {
  promptTokens: number
  completionTokens: number
}

export interface AgentRunUsageEventRow {
  run_id: string
  type: string
  payload_json: string
  sequence: number
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

function tokenCount(value: unknown): number | null {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null
}

/**
 * Projects the last provider sample for each durable assistant message.
 * Prompt usage from multiple tool-loop turns is not additive context usage.
 */
export function contextUsageByOutputMessage(
  rows: readonly AgentRunUsageEventRow[]
): Map<string, AgentRunContextUsage> {
  const byRun = new Map<
    string,
    { outputMessageId: string | null; usage: AgentRunContextUsage | null }
  >()
  for (const row of rows) {
    const state = byRun.get(row.run_id) ?? { outputMessageId: null, usage: null }
    const payload = parsePayload(row.payload_json)
    if (row.type === 'run.started' && typeof payload.outputMessageId === 'string') {
      state.outputMessageId = payload.outputMessageId
    }
    if (row.type === 'usage.updated') {
      const promptTokens = tokenCount(payload.promptTokens)
      const completionTokens = tokenCount(payload.completionTokens)
      if (promptTokens !== null || completionTokens !== null) {
        state.usage = {
          promptTokens: promptTokens ?? 0,
          completionTokens: completionTokens ?? 0
        }
      }
    }
    byRun.set(row.run_id, state)
  }

  const result = new Map<string, AgentRunContextUsage>()
  for (const { outputMessageId, usage } of byRun.values()) {
    if (outputMessageId && usage) result.set(outputMessageId, usage)
  }
  return result
}

export function loadContextUsageByOutputMessage(
  db: Database.Database,
  threadId: string
): Map<string, AgentRunContextUsage> {
  const rows = db
    .prepare(
      `SELECT e.run_id, e.type, e.payload_json, e.sequence
       FROM agent_run_events e
       JOIN agent_runs r ON r.id = e.run_id
       WHERE r.thread_id = ? AND e.type IN ('run.started', 'usage.updated')
       ORDER BY r.started_at ASC, e.sequence ASC`
    )
    .all(threadId) as AgentRunUsageEventRow[]
  return contextUsageByOutputMessage(rows)
}
