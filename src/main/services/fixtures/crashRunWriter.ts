import Database from 'better-sqlite3'
import { appendFileSync } from 'node:fs'
import { applyDatabaseSchema } from '../../bootstrap/database'
import { AgentRunStore } from '../agentRunStore'

const db = new Database(process.argv[2])
db.pragma('journal_mode = WAL')
applyDatabaseSchema(db)
const store = new AgentRunStore(db)
store.start({
  id: 'crash-run',
  threadId: 'crash-thread',
  profile: { surface: 'conversation', executionMode: 'act', capabilities: ['workspace.write'] },
  provider: 'fixture',
  model: 'fixture'
})
store.transition('crash-run', 'executing_tool', 'begin-execution')
store.appendEvent({
  id: 'started-tool',
  runId: 'crash-run',
  type: 'tool.running',
  payload: { toolCallId: 'write-once', name: 'shell', title: 'Synthetic side effect' }
})
appendFileSync(process.argv[3], 'effect\n')
process.send?.('side-effect-complete')
// Deliberately never record tool.completed: parent kills us at the uncertain boundary.
setInterval(() => undefined, 1000)
