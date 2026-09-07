// Runs under the existing development Electron's Node ABI, only on a disposable
// synthetic database passed by qualify-packaged-upgrade.cjs.
const assert = require('node:assert/strict')
const path = require('node:path')
const { tmpdir } = require('node:os')
const Database = require('better-sqlite3')
const [mode, file, historicalModule, workspace] = process.argv.slice(2)
const relative = path.relative(path.resolve(tmpdir()), path.resolve(file))
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
assert.ok(relative.split(path.sep)[0].startsWith('sidekick-upgrade-'))
let db
try {
  db =
    mode === 'inspect'
      ? new Database(file, { readonly: true })
      : require(historicalModule).openApplicationDatabase(file)
  if (mode === 'seed') {
    db.prepare(
      'INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
    ).run('historical-project', 'Historical fixture', workspace)
    db.prepare(
      "INSERT INTO conversations (id, title, title_source, created_at, updated_at, project_id) VALUES ('historical-thread', 'Historical synthetic history', 'user', 1, 1, 'historical-project')"
    ).run()
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, thinking, token_usage, timestamp) VALUES ('historical-message', 'historical-thread', 'agent', 'Historical synthetic content café 雪.', 'Synthetic reasoning.', ?, 2)"
    ).run(JSON.stringify({ promptTokens: 111, completionTokens: 22 }))
  }
  const hasLedger = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()
  )
  const summary = {
    migrations: hasLedger
      ? db
          .prepare('SELECT id FROM schema_migrations ORDER BY id')
          .all()
          .map((row) => row.id)
      : [],
    messageColumns: db
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((row) => row.name),
    messages: db
      .prepare(
        'SELECT id, conversation_id, role, content, thinking, token_usage, timestamp FROM messages ORDER BY id'
      )
      .all(),
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyErrors: db.pragma('foreign_key_check')
  }
  process.stdout.write(JSON.stringify(summary) + '\n')
} finally {
  db?.close()
}
