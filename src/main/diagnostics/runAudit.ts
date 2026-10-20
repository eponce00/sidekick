import type Database from 'better-sqlite3'
import { SESSION_LIMITS } from '../../shared/sessions'
import { MAX_AGENT_CONDITIONAL_WAIT_SECONDS, MAX_AGENT_WAIT_SECONDS } from '../../shared/agentWait'
import {
  MAX_IDENTICAL_TOOL_CALLS,
  MAX_TOOL_CALLS_PER_REPLY,
  ToolCallTurnCounter,
  type CutOffTurnSummary,
  type RunawayTurnSummary
} from '../services/toolBatchCutOff'

/**
 * Reads the run journals SideKick already keeps and points out behavior that looks wrong: chats
 * summarized long before their window fills, reports cut short, replies that overflowed the
 * window, replies cut off or run away while they wrote tool calls, runs that went quiet. It
 * reports counts, shares and run ids, never message content, so it can run on any profile's
 * database.
 */

export interface RunAuditOptions {
  /** Only runs started at or after this time, in epoch milliseconds. */
  since?: number
  /** A compaction before the prompt reaches this share of the window fired early. */
  minCompactionShare?: number
  /** More of the deterministic fallback summary than this share is flagged. */
  maxFallbackShare?: number
  /** A run compacting this many times or more is flagged. */
  maxCompactionsPerRun?: number
  /** A run retrying this many times or more is flagged. */
  maxRetriesPerRun?: number
  /** A run silent this long while working is flagged. */
  maxQuietMinutes?: number
}

export interface RunAuditFinding {
  check: string
  /** `flag` findings make the audit fail; `info` findings only describe. */
  severity: 'flag' | 'info'
  summary: string
  count: number
  examples: string[]
}

export interface RunAudit {
  runs: number
  findings: RunAuditFinding[]
}

const DEFAULTS: Required<Omit<RunAuditOptions, 'since'>> = {
  minCompactionShare: 0.6,
  maxFallbackShare: 0.3,
  maxCompactionsPerRun: 4,
  maxRetriesPerRun: 5,
  maxQuietMinutes: 10
}

/** Phases in which a run waits on someone else; silence there is expected. */
const WAITING_PHASES = new Set(['awaiting_user', 'awaiting_permission', 'queued'])
const FINISHED_PHASES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
/**
 * Retries the harness makes on purpose, such as asking the model to verify its edits. They are
 * part of a healthy run; the rest mean something kept failing.
 */
const ROUTINE_RETRIES = new Set(['workspace_verification_required', 'goal_continuation'])
const EXAMPLES = 5

interface EventRow {
  run_id: string
  sequence: number
  type: string
  payload_json: string
  timestamp: number
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * How long a `wait` call may be silent: the seconds it asked for, or its default, within the
 * limits the tool enforces, and a minute for the command that woke it to report.
 */
function waitAllowanceMs(args: unknown): number {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const conditional = Boolean(record.taskIds ?? record.taskId ?? record.pattern)
  const asked = Number(record.seconds)
  const seconds = Math.min(
    Number.isFinite(asked) && asked > 0 ? asked : conditional ? 600 : 30,
    conditional ? MAX_AGENT_CONDITIONAL_WAIT_SECONDS : MAX_AGENT_WAIT_SECONDS
  )
  return seconds * 1_000 + 60_000
}

function parse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function auditRuns(db: Database.Database, options: RunAuditOptions = {}): RunAudit {
  const settings = { ...DEFAULTS, ...options }
  const since = options.since ?? 0
  const runs = db.prepare('SELECT id FROM agent_runs WHERE started_at >= ?').all(since) as Array<{
    id: string
  }>
  const findings: RunAuditFinding[] = []
  const add = (finding: RunAuditFinding): void => {
    findings.push({ ...finding, examples: finding.examples.slice(0, EXAMPLES) })
  }

  // One pass over every run's events, in order. Deltas carry no payload worth reading here but
  // still count as activity, so they are read without it.
  const events = db
    .prepare(
      `SELECT e.run_id, e.sequence, e.type,
              CASE WHEN e.type IN ('assistant.delta', 'tool.output.delta') THEN '{}'
                   ELSE e.payload_json END AS payload_json,
              e.timestamp
       FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
       WHERE r.started_at >= ?
       ORDER BY e.run_id, e.sequence`
    )
    .iterate(since) as IterableIterator<EventRow>

  const early: string[] = []
  const shares: number[] = []
  const after: number[] = []
  const durations: number[] = []
  let compactions = 0
  let fallbacks = 0
  const overflows: string[] = []
  const busyRuns: string[] = []
  const retryStorms: string[] = []
  const quiet: string[] = []
  const failures = new Map<string, number>()
  const toolTurns = new ToolCallTurnCounter()
  const cutRuns: string[] = []
  const runawayRuns: string[] = []
  let runCutStart: CutOffTurnSummary = structuredClone(toolTurns.cutOff)
  // A `wait` the model asked for is silent on purpose until its time is up.
  let waitingUntil = 0

  let current = ''
  let phase = ''
  let lastAt = 0
  let lastPrompt: number | undefined
  let awaitingAfter: { window: number } | null = null
  let startedAt = 0
  let runCompactions = 0
  let runRetries = new Map<string, number>()
  let interrupted = 0

  const finishRun = (): void => {
    if (!current) return
    const cut = toolTurns.cutOff
    const cutTurns = cut.turns - runCutStart.turns
    if (cutTurns) {
      const refused = cut.refusedCalls - runCutStart.refusedCalls
      const repeated = cut.repeatedTurns - runCutStart.repeatedTurns
      cutRuns.push(
        `${shortId(current)} (${cutTurns} cut-off ${cutTurns === 1 ? 'reply' : 'replies'}, ${refused} calls refused` +
          (repeated ? `, ${repeated} right after another cut` : '') +
          ')'
      )
    }
    const runaway = toolTurns.runRunaway
    if (runaway.turns) {
      runawayRuns.push(
        `${shortId(current)} (${runaway.turns} runaway, up to ${runaway.largestCallCount} calls, ${runaway.largestIdenticalCount} the same)`
      )
    }
    if (runCompactions >= settings.maxCompactionsPerRun)
      busyRuns.push(`${shortId(current)} (${runCompactions})`)
    const retries = [...runRetries.values()].reduce((sum, value) => sum + value, 0)
    if (retries >= settings.maxRetriesPerRun) {
      const reasons = [...runRetries.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([reason, count]) => `${reason} × ${count}`)
        .join(', ')
      retryStorms.push(`${shortId(current)} (${reasons})`)
    }
  }

  for (const event of events) {
    if (event.run_id !== current) {
      finishRun()
      current = event.run_id
      phase = ''
      lastAt = event.timestamp
      lastPrompt = undefined
      awaitingAfter = null
      runCompactions = 0
      runRetries = new Map()
      waitingUntil = 0
      toolTurns.startRun()
      runCutStart = structuredClone(toolTurns.cutOff)
    }
    const payload = event.type.endsWith('.delta') ? {} : parse(event.payload_json)
    // A run SideKick closed on is marked interrupted at the next start, so the silence before
    // that mark is the app being closed, not the run hanging.
    const closedOn = event.type === 'run.completed' && payload.phase === 'interrupted'
    if (closedOn) interrupted += 1
    const gap = event.timestamp - lastAt
    if (
      phase &&
      !closedOn &&
      !WAITING_PHASES.has(phase) &&
      !FINISHED_PHASES.has(phase) &&
      gap >= settings.maxQuietMinutes * 60_000 &&
      event.timestamp > waitingUntil
    ) {
      quiet.push(`${shortId(current)} (${Math.round(gap / 60_000)} min while ${phase})`)
    }
    lastAt = event.timestamp

    switch (event.type) {
      case 'assistant.completed':
        toolTurns.turn(payload.toolCalls, payload.runaway)
        break
      case 'tool.running':
        if (payload.name === 'wait')
          waitingUntil = event.timestamp + waitAllowanceMs(payload.arguments)
        break
      case 'tool.completed':
        if (payload.name === 'wait') waitingUntil = 0
        break
      case 'run.phase':
        phase = String(payload.phase ?? '')
        break
      case 'usage.updated': {
        const prompt = Number(payload.promptTokens)
        if (Number.isFinite(prompt) && prompt > 0) {
          if (awaitingAfter) {
            after.push(prompt / awaitingAfter.window)
            awaitingAfter = null
          }
          lastPrompt = prompt
        }
        break
      }
      case 'compaction.started':
        startedAt = event.timestamp
        break
      case 'compaction.completed': {
        if (payload.compacted !== true) break
        compactions += 1
        runCompactions += 1
        if (payload.strategy === 'deterministic') fallbacks += 1
        if (startedAt) durations.push((event.timestamp - startedAt) / 1000)
        startedAt = 0
        const window = Number(payload.contextLength)
        if (payload.reason === 'provider_context_window_exceeded') {
          overflows.push(`${shortId(current)} (provider refused the request)`)
        }
        if (
          payload.reason === 'preflight_budget' &&
          payload.contextReliable !== false &&
          Number.isFinite(window) &&
          window > 0 &&
          lastPrompt
        ) {
          const share = lastPrompt / window
          shares.push(share)
          if (share < settings.minCompactionShare)
            early.push(
              `${shortId(current)} (at ${percent(share)} of ${window.toLocaleString('en-US')})`
            )
          awaitingAfter = { window }
        }
        break
      }
      case 'run.retrying': {
        const reason = String(payload.reason ?? 'unknown')
        if (!ROUTINE_RETRIES.has(reason)) runRetries.set(reason, (runRetries.get(reason) ?? 0) + 1)
        if (reason === 'truncated_tool_batch') toolTurns.cutTurn(payload)
        if (reason === 'context_window_exceeded')
          overflows.push(`${shortId(current)} (prompt and reply did not fit)`)
        break
      }
      case 'run.completed':
        phase = String(payload.phase ?? phase)
        if (payload.phase === 'failed') {
          const error = payload.error as { code?: string } | undefined
          const code = error?.code ?? 'unknown'
          failures.set(code, (failures.get(code) ?? 0) + 1)
        }
        break
    }
  }
  finishRun()

  if (compactions) {
    add({
      check: 'compaction-point',
      severity: early.length ? 'flag' : 'info',
      summary: early.length
        ? `${early.length} of ${shares.length} compactions fired before the prompt reached ${percent(settings.minCompactionShare)} of the window (median ${percent(median(shares))}).`
        : `Compactions fired at a median of ${percent(median(shares))} of the window.`,
      count: early.length,
      examples: early
    })
    add({
      check: 'compaction-kept',
      severity: 'info',
      summary: after.length
        ? `After compacting, the next request used a median of ${percent(median(after))} of the window.`
        : 'No request followed a compaction.',
      count: after.length,
      examples: []
    })
    const fallbackShare = fallbacks / compactions
    add({
      check: 'compaction-fallback',
      severity: fallbackShare > settings.maxFallbackShare ? 'flag' : 'info',
      summary: `${fallbacks} of ${compactions} compactions used the deterministic fallback summary (${percent(fallbackShare)}).`,
      count: fallbacks,
      examples: []
    })
    add({
      check: 'compaction-time',
      severity: 'info',
      summary: durations.length
        ? `Compactions took a median of ${Math.round(median(durations))} s, at most ${Math.round(Math.max(...durations))} s.`
        : 'No compaction durations were recorded.',
      count: durations.length,
      examples: []
    })
  }
  add({
    check: 'compaction-repeat',
    severity: busyRuns.length ? 'flag' : 'info',
    summary: `${busyRuns.length} runs compacted ${settings.maxCompactionsPerRun} or more times.`,
    count: busyRuns.length,
    examples: busyRuns
  })
  add({
    check: 'context-overflow',
    severity: overflows.length ? 'flag' : 'info',
    summary: `${overflows.length} requests did not fit the model's window.`,
    count: overflows.length,
    examples: overflows
  })
  add({
    check: 'retry-storm',
    severity: retryStorms.length ? 'flag' : 'info',
    summary: `${retryStorms.length} runs retried ${settings.maxRetriesPerRun} or more times after failures.`,
    count: retryStorms.length,
    examples: retryStorms
  })
  add({
    check: 'quiet-run',
    severity: quiet.length ? 'flag' : 'info',
    summary: `${quiet.length} times a working run went ${settings.maxQuietMinutes} minutes or more without any event (${interrupted} runs ended because SideKick closed; those are not counted).`,
    count: quiet.length,
    examples: quiet
  })
  add(cutOffFinding(toolTurns.cutOff, cutRuns))
  add(runawayFinding(toolTurns.runaway, runawayRuns))
  const failed = [...failures.values()].reduce((sum, value) => sum + value, 0)
  add({
    check: 'failed-runs',
    severity: 'info',
    summary: `${failed} of ${runs.length} runs failed.`,
    count: failed,
    examples: [...failures.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([code, count]) => `${code} × ${count}`)
  })
  add(auditReports(db, since))
  return { runs: runs.length, findings }
}

/**
 * Replies the output limit cut off while they wrote tool calls, counted by reply: one reply that
 * ran away refused 767 calls, and counted by call it read as a problem in every run. A cut that
 * follows another means a retry was cut the same way.
 */
function cutOffFinding(cut: CutOffTurnSummary, examples: string[]): RunAuditFinding {
  const parts = [
    `${cut.turns} ${cut.turns === 1 ? 'reply was' : 'replies were'} cut off while writing tool calls, with ${cut.refusedCalls} calls refused.`
  ]
  if (cut.turns) {
    parts.push(
      `${cut.multiCallTurns} held several calls; ${cut.repeatedTurns} came right after another cut.`,
      `Seen by: the provider's stop reason ${cut.byTrigger.stop_reason}, the whole allowance used ${cut.byTrigger.used_allowance}.`,
      `Limit: shrunk to the room left ${cut.byLimit.shrunk}, the model's own ${cut.byLimit.full}, not recorded ${cut.byLimit.unrecorded}.`,
      `Tokens used: at the limit ${cut.byUsage.at_limit}, over it ${cut.byUsage.over_limit}, under it ${cut.byUsage.under_limit}, not recorded ${cut.byUsage.unrecorded}.`
    )
  }
  return {
    check: 'cut-off-turns',
    severity: cut.repeatedTurns ? 'flag' : 'info',
    summary: parts.join(' '),
    count: cut.turns,
    examples
  }
}

/** Replies that wrote far more tool calls than a plan needs, or one call over and over. */
function runawayFinding(runaway: RunawayTurnSummary, examples: string[]): RunAuditFinding {
  return {
    check: 'runaway-tool-calls',
    severity: runaway.turns ? 'flag' : 'info',
    summary: runaway.turns
      ? `${runaway.turns} ${runaway.turns === 1 ? 'reply' : 'replies'} wrote more than ${MAX_TOOL_CALLS_PER_REPLY} tool calls or one call more than ${MAX_IDENTICAL_TOOL_CALLS} times (at most ${runaway.largestCallCount} calls, ${runaway.largestIdenticalCount} of them the same); SideKick stopped ${runaway.stopped} of them as they streamed.`
      : `No reply wrote more than ${MAX_TOOL_CALLS_PER_REPLY} tool calls or one call more than ${MAX_IDENTICAL_TOOL_CALLS} times.`,
    count: runaway.turns,
    examples
  }
}

/**
 * A report should carry its worker's whole reply up to `reportMaxLength`; one that does not is
 * cut. The reply compared is the worker's last reply before the report was written.
 */
function auditReports(db: Database.Database, since: number): RunAuditFinding {
  const reports = db
    .prepare(
      `SELECT id, from_conversation_id, body, created_at FROM session_messages
       WHERE intent = 'report' AND created_at >= ? AND from_conversation_id IS NOT NULL`
    )
    .all(since) as Array<{
    id: string
    from_conversation_id: string
    body: string
    created_at: number
  }>
  const reply = db.prepare(
    `SELECT content FROM messages
     WHERE conversation_id = ? AND role = 'assistant' AND timestamp <= ?
     ORDER BY timestamp DESC LIMIT 1`
  )
  const cut: string[] = []
  for (const report of reports) {
    const last = (
      reply.get(report.from_conversation_id, report.created_at) as { content: string } | undefined
    )?.content?.trim()
    if (!last || last.length > SESSION_LIMITS.reportMaxLength) continue
    if (!report.body.includes(last))
      cut.push(`${shortId(report.id)} (${report.body.length} of ${last.length} characters)`)
  }
  return {
    check: 'report-cut',
    severity: cut.length ? 'flag' : 'info',
    summary: `${cut.length} of ${reports.length} worker reports did not carry the worker's whole reply.`,
    count: cut.length,
    examples: cut
  }
}

export function formatRunAudit(audit: RunAudit): string {
  const lines = [`Audited ${audit.runs} runs.`, '']
  for (const finding of audit.findings) {
    lines.push(`${finding.severity === 'flag' ? '✗' : '·'} ${finding.check}: ${finding.summary}`)
    for (const example of finding.examples) lines.push(`    ${example}`)
  }
  const flagged = audit.findings.filter((finding) => finding.severity === 'flag').length
  lines.push('', flagged ? `${flagged} checks flagged.` : 'Nothing flagged.')
  return lines.join('\n')
}
