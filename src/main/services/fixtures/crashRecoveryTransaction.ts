import Database from 'better-sqlite3'
import { applyDatabaseSchema } from '../../bootstrap/database'
import { AgentRunStore } from '../agentRunStore'
import { recoverAgentRunMaterializations } from '../agentRunRecovery'

const db = new Database(process.argv[2])
function holdTransaction(): never {
  if (!db.inTransaction) throw new Error('Fixture boundary must be inside the transaction')
  process.send?.({ boundary: process.argv[3], inTransaction: true })
  // Keep the synchronous transaction open until the parent forcibly kills us.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000)
  throw new Error('Parent did not kill the transaction fixture')
}

if (process.argv[3] === 'migration') {
  db.function('hold_migration', (legacyTables) => {
    if (legacyTables !== 0) {
      throw new Error('Earlier destructive migration must have executed before kill')
    }
    holdTransaction()
  })
  applyDatabaseSchema(db)
} else {
  const store = new AgentRunStore(db)
  let calls = 0
  recoverAgentRunMaterializations(db, store, () => {
    if (++calls !== 2) return
    const materialized = db.prepare('SELECT count(*) AS count FROM messages').get() as {
      count: number
    }
    const finalized = db
      .prepare("SELECT count(*) AS count FROM agent_run_events WHERE type = 'run.finalized'")
      .get() as { count: number }
    if (materialized.count !== 1 || finalized.count !== 1)
      throw new Error('First run must be materialized before kill')
    holdTransaction()
  })
}
throw new Error('Fixture did not reach its kill boundary')
