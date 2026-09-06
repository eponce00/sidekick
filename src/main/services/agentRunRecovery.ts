import type Database from 'better-sqlite3'
import type { AgentRunEvent, AgentRunSnapshot } from '../../shared/agentRuntime'
import { AgentRunStore } from './agentRunStore'
import { AgentMessageMaterializer } from './agentMessageMaterializer'

/** Reconcile durable terminal journals, never re-execute their tools. */
export function recoverAgentRunMaterializations(
  db: Database.Database,
  store: AgentRunStore,
  restoreCompaction: (run: AgentRunSnapshot, events: AgentRunEvent[]) => void
): void {
  db.transaction(() => {
    const recovered = store.recoverInterrupted()
    // A process may stop after the terminal event but before message finalization.
    const unfinished = db
      .prepare(
        `
      SELECT id FROM agent_runs AS run
      WHERE phase IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND surface IN ('conversation', 'research')
        AND NOT EXISTS (
          SELECT 1 FROM agent_run_events AS event
          WHERE event.run_id = run.id AND event.type = 'run.finalized'
        )
      ORDER BY started_at, rowid
    `
      )
      .all() as Array<{ id: string }>
    const runs = new Map(recovered.map((run) => [run.id, run]))
    for (const { id } of unfinished) runs.set(id, store.get(id)!)
    const messages = new AgentMessageMaterializer(db, store)
    for (const run of runs.values()) {
      const events = store.listAllEvents(run.id)
      const started = events.find((event) => event.type === 'run.started')
      const outputMessageId = String(started?.payload.outputMessageId || '')
      const conversationExists = Boolean(
        db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(run.threadId)
      )
      const persist =
        conversationExists &&
        (run.surface === 'conversation' || run.surface === 'research') &&
        Boolean(outputMessageId)
      if (persist) {
        restoreCompaction(run, events)
        const prior = db
          .prepare(
            'SELECT checkpoint_hash, checkpoint_workspace_root FROM messages WHERE id = ? AND conversation_id = ?'
          )
          .get(outputMessageId, run.threadId) as
          | { checkpoint_hash: string | null; checkpoint_workspace_root: string | null }
          | undefined
        messages.materialize(run.id, {
          checkpointHash: prior?.checkpoint_hash,
          checkpointWorkspaceRoot: prior?.checkpoint_workspace_root
        })
      }
      store.appendEvent({
        id: `${run.id}:finalized`,
        runId: run.id,
        type: 'run.finalized',
        payload: { outputMessageId: outputMessageId || null, persisted: persist, recovered: true }
      })
    }
  }).immediate()
}
