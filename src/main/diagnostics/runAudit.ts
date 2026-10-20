import type Database from 'better-sqlite3'
import { SESSION_LIMITS } from '../../shared/sessions'

/**
 * Reads the run journals SideKick already keeps and points out behavior that looks wrong: chats
 * summarized long before their window fills, reports cut short, replies that overflowed the
 * window, runs that went quiet. It reports counts, shares and run ids, never message content, so
 * it can run on any profile's database.
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
  // Why each fallback summary was used; journals before 0.16.3 did not say.
  const fallbackReasons = new Map<string, number>()
  // SideKick's estimate over the provider's count for the same request.
  const estimateRatios: number[] = []
  const overflows: string[] = []
  const busyRuns: string[] = []
  const retryStorms: string[] = []
  const quiet: string[] = []
  const failures = new Map<string, number>()

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
      gap >= settings.maxQuietMinutes * 60_000
    ) {
      quiet.push(`${shortId(current)} (${Math.round(gap / 60_000)} min while ${phase})`)
    }
    lastAt = event.timestamp

    switch (event.type) {
      case 'run.phase':
        phase = String(payload.phase ?? '')
        break
      case 'usage.updated': {
        const prompt = Number(payload.promptTokens)
        if (Number.isFinite(prompt) && prompt > 0) {
          const estimated = Number(payload.estimatedPromptTokens)
          if (Number.isFinite(estimated) && estimated > 0) estimateRatios.push(estimated / prompt)
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
        if (payload.strategy === 'deterministic') {
          fallbacks += 1
          const reason =
            typeof payload.fallbackReason === 'string' ? payload.fallbackReason : 'unrecorded'
          fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1)
        }
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
      examples: [...fallbackReasons.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([reason, count]) => `${reason} × ${count}`)
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
  if (estimateRatios.length) {
    add({
      check: 'estimate-accuracy',
      severity: 'info',
      summary: `SideKick's estimate of a request was a median of ${percent(median(estimateRatios))} of the provider's own count (${percent(Math.min(...estimateRatios))}–${percent(Math.max(...estimateRatios))}).`,
      count: estimateRatios.length,
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
