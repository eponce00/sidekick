import type Database from 'better-sqlite3'
import { projectAgentRunEvents } from '../../shared/agentEventProjection'
import { agentRunUsesPlan, type AgentRunPhase } from '../../shared/agentRuntime'
import { AgentRunStore } from './agentRunStore'

export interface AgentMessageMaterialization {
  runId: string
  conversationId: string
  messageId: string
  content: string
  checkpointHash: string | null
}

export interface MaterializeAgentRunOptions {
  checkpointHash?: string | null
  checkpointWorkspaceRoot?: string | null
  /** Used only when a terminal failure produced no assistant content. */
  fallbackContent?: string
}

function terminalContent(
  phase: AgentRunPhase,
  projected: string,
  fallback: string | undefined,
  errorMessage: string | undefined
): string {
  if (phase === 'interrupted') {
    return projected.trim()
      ? `${projected}\n\n_Run interrupted before completion._`
      : 'Run interrupted before completion. You can retry the last message.'
  }
  if (projected) return projected
  if (fallback) return fallback
  return phase === 'failed' ? `Error: ${errorMessage || 'Agent run failed'}` : ''
}

/**
 * Maintains the `messages` row as a searchable/UI-friendly materialized view.
 * The linked agent run journal remains authoritative and can rebuild this row.
 */
export class AgentMessageMaterializer {
  private readonly runs: AgentRunStore

  constructor(
    private readonly db: Database.Database,
    runs?: AgentRunStore
  ) {
    this.runs = runs ?? new AgentRunStore(db)
  }

  materialize(
    runId: string,
    options: MaterializeAgentRunOptions = {}
  ): AgentMessageMaterialization {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`Agent run not found: ${runId}`)
    const events = this.runs.listAllEvents(runId)
    const started = events.find((event) => event.type === 'run.started')
    const messageId = String(started?.payload.outputMessageId || '')
    if (!messageId) throw new Error(`Agent run has no output message: ${runId}`)
    const projection = projectAgentRunEvents(events)
    const content = terminalContent(
      run.phase,
      projection.content,
      options.fallbackContent,
      run.error?.message
    )
    const checkpointHash = options.checkpointHash ?? null
    const checkpointWorkspaceRoot = checkpointHash
      ? (options.checkpointWorkspaceRoot ?? null)
      : null
    const runMode =
      run.surface === 'research' ? 'research' : agentRunUsesPlan(events) ? 'plan' : 'conversation'
    this.db
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, role, content, thinking, segments, token_usage, run_id,
          checkpoint_hash, checkpoint_workspace_root, run_mode, timestamp)
         VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           thinking = excluded.thinking,
           segments = excluded.segments,
           token_usage = excluded.token_usage,
           run_id = excluded.run_id,
           checkpoint_hash = excluded.checkpoint_hash,
           checkpoint_workspace_root = excluded.checkpoint_workspace_root,
           run_mode = excluded.run_mode`
      )
      .run(
        messageId,
        run.threadId,
        content,
        projection.thinking || null,
        projection.segments.length ? JSON.stringify(projection.segments) : null,
        JSON.stringify(projection.tokenUsage),
        runId,
        checkpointHash,
        checkpointWorkspaceRoot,
        runMode,
        run.completedAt ?? run.updatedAt
      )
    return {
      runId,
      conversationId: run.threadId,
      messageId,
      content,
      checkpointHash
    }
  }
}
