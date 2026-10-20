// Live run of chats that start other chats: a manager starts two workers in worktrees and reads
// their reports. A scripted OpenAI-compatible server on loopback plays the model, so the run is
// deterministic and needs no account. Runs with `npm run test:behavior` after `npm run build`;
// SIDEKICK_CHAT_FAMILY_SCREENSHOT=<path> also saves the manager chat as the user sees it.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve, sep } = require('node:path')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const { startScriptedModel, text } = require('./scripted-model.cjs')

const ROOT = resolve(__dirname, '..')
const MODEL_ID = 'family-fixture'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function until(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout
  do {
    const value = await predicate()
    if (value) return value
    await delay(200)
  } while (Date.now() < deadline)
  assert.fail(message)
}

/** What the scripted model says next, from the conversation it was sent. */
function reply(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => text(m.content))
    .join('\n')
  const last = messages.at(-1)
  if (system.includes('This chat was started by another chat')) {
    const brief = text(
      messages.find((m) => m.role === 'user' && /^Brief for /.test(text(m.content)))?.content
    )
    return { content: `Done: ${brief}. Nothing else changed.` }
  }
  const reports = messages.filter(
    (m) => m.role === 'user' && text(m.content).includes('intent="report"')
  )
  if (reports.length && last.role === 'user') {
    return { content: `Both chats reported back (${reports.length} reports). The work is done.` }
  }
  if (last.role === 'tool') return { content: 'Started two chats; I will read their reports.' }
  return {
    toolCall: {
      name: 'start_session',
      arguments: {
        sessions: [
          { title: 'Alpha task', handle: 'alpha', brief: 'Brief for alpha' },
          { title: 'Beta task', handle: 'beta', brief: 'Brief for beta' }
        ]
      }
    }
  }
}

test(
  'a manager starts two worker chats in worktrees and reads both reports',
  { timeout: 180_000 },
  async () => {
    assert.ok(
      existsSync(join(ROOT, 'out', 'main', 'index.js')),
      'Run `npm run build` before this test.'
    )
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-chat-family-'))
    const workspace = join(profile, 'workspace')
    mkdirSync(workspace)
    const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(workspace, 'README.md'), '# Fixture\n')
    git('add', '.')
    git(
      '-c',
      'user.name=SideKick',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'init'
    )

    const model = await startScriptedModel({
      models: [{ id: MODEL_ID, context_length: 65536 }],
      reply
    })
    let application
    // The app's console and the manager's messages say why a step failed, where CI otherwise
    // shows only the timeout.
    const appLog = []
    let managerMessages = async () => null
    try {
      application = await electron.launch({
        args: [ROOT, '--disable-gpu', '--sidekick-e2e'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          SIDEKICK_E2E_USER_DATA_DIR: profile,
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
        },
        timeout: 30_000
      })
      for (const stream of [application.process().stdout, application.process().stderr])
        stream?.on('data', (chunk) => appLog.push(...String(chunk).split('\n').filter(Boolean)))
      const page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.sessions))
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1400, 900)
      )

      const managerId = await page.evaluate(
        async ({ baseUrl, workspace, modelId }) => {
          await window.api.settings.save({
            providerInstances: [
              {
                id: 'family-provider',
                name: 'Scripted loopback model',
                type: 'openai-compatible',
                preset: 'generic',
                enabled: true,
                baseUrl,
                modelSource: 'manual',
                models: [{ id: modelId, enabled: true, supportsTools: true, contextLength: 65536 }]
              }
            ],
            selectedModel: `lmstudio:family-provider/${modelId}`,
            commandPermissionMode: 'full-access',
            notificationsEnabled: false
          })
          const project = await window.api.projects.create(workspace, 'family-fixture')
          const conversation = await window.api.conversations.create('Split the work', project.id)
          await window.api.conversations.saveMessage({
            id: 'family-user',
            conversation_id: conversation.id,
            role: 'user',
            content: 'Split this into two parallel chats, alpha and beta.',
            timestamp: Date.now()
          })
          await window.api.conversations.saveMessage({
            id: 'family-assistant',
            conversation_id: conversation.id,
            role: 'agent',
            content: '',
            timestamp: Date.now() + 1
          })
          await window.api.agentRuns.startConversation({
            id: 'family-manager-run',
            conversationId: conversation.id,
            assistantMessageId: 'family-assistant',
            model: {
              id: `lmstudio:family-provider/${modelId}`,
              name: modelId,
              provider: 'lmstudio',
              providerKind: 'openai-compatible',
              providerInstanceId: 'family-provider',
              providerModelId: modelId,
              supportsTools: true,
              contextLength: 65536
            }
          })
          return conversation.id
        },
        { baseUrl: model.url, workspace, modelId: MODEL_ID }
      )
      managerMessages = () =>
        page.evaluate((id) => window.api.conversations.getMessages(id), managerId)

      const family = await until(
        () =>
          page.evaluate(async (id) => {
            const value = await window.api.sessions.family(id)
            return value && value.workers.length === 2 ? value : null
          }, managerId),
        'The manager should start two workers'
      )
      assert.deepEqual(family.workers.map(({ handle }) => handle).sort(), ['alpha', 'beta'])
      // Each worker moves into its own managed worktree before its first run: a folder named after
      // its handle, beside the project rather than deep in SideKick's data folder.
      const worktrees = await until(
        () =>
          page.evaluate(async (id) => {
            const [current, worktrees] = await Promise.all([
              window.api.sessions.family(id),
              window.api.worktrees.list()
            ])
            const ready = current.workers.every(
              (worker) =>
                worker.workIn === 'worktree' &&
                worktrees.some(({ owners }) =>
                  owners.some((owner) => owner.id === worker.conversationId)
                )
            )
            return ready ? worktrees : null
          }, managerId),
        'Each worker should work in its own managed worktree'
      )
      const beside = realpathSync.native(`${workspace}.worktrees`)
      for (const handle of ['alpha', 'beta']) {
        const worktree = worktrees.find(({ worktreeRoot }) =>
          new RegExp(`^${handle}-[0-9a-f]{6}$`).test(basename(worktreeRoot))
        )
        assert.ok(worktree, `The ${handle} worker's worktree should be named after its handle`)
        assert.equal(realpathSync.native(dirname(worktree.worktreeRoot)), beside)
      }

      // Both reports reach the manager in one woken run, which then answers.
      const reports = await until(
        () =>
          page.evaluate(async (id) => {
            const messages = await window.api.sessions.messages(id)
            const received = messages.filter(({ intent }) => intent === 'report')
            return received.length === 2 && received.every(({ deliveredRunId }) => deliveredRunId)
              ? received
              : null
          }, managerId),
        'Both workers should report to the manager',
        90_000
      )
      assert.equal(new Set(reports.map(({ deliveredRunId }) => deliveredRunId)).size, 1)
      assert.ok(reports.some(({ body }) => body.includes('Done: Brief for alpha')))
      assert.ok(reports.some(({ body }) => body.includes('Done: Brief for beta')))
      await until(
        () =>
          page.evaluate(async (id) => {
            const messages = await window.api.conversations.getMessages(id)
            return messages.some((message) => message.content?.includes('Both chats reported back'))
          }, managerId),
        'The woken manager should answer after reading the reports'
      )

      // The user sees the family without restarting: workers nested under the manager, reports as
      // received rows rather than raw messages typed by the user.
      await page.getByText('Split the work', { exact: true }).first().click()
      await page.getByText('Both chats reported back').first().waitFor({ timeout: 15_000 })
      for (const handle of ['alpha', 'beta'])
        await page.getByText(handle, { exact: true }).first().waitFor({ timeout: 15_000 })
      await page
        .getByText(/Received 2 messages/)
        .first()
        .waitFor({ timeout: 15_000 })
      assert.equal(
        await page.evaluate(() => document.body.innerText.includes('<sidekick_chat_message')),
        false,
        'Messages between chats must not show their model framing'
      )
      const screenshot = process.env.SIDEKICK_CHAT_FAMILY_SCREENSHOT
      if (screenshot) {
        await delay(1_000)
        await page.screenshot({ path: resolve(screenshot) })
      }
    } catch (error) {
      const messages = await managerMessages().catch(() => null)
      console.error(`App output (last 100 lines):\n${appLog.slice(-100).join('\n')}`)
      console.error(`Manager messages:\n${JSON.stringify(messages, null, 1)?.slice(0, 8000)}`)
      throw error
    } finally {
      if (application) await application.close()
      await model.close()
      const resolved = resolve(profile)
      assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}`))
      rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)

const LEGACY_GROUP_TABLES = `
  CREATE TABLE collaboration_groups (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, unread_completion_at INTEGER);
  CREATE TABLE collaboration_participants (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, project_id TEXT NOT NULL, label TEXT NOT NULL,
    provider_target_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    joined_at INTEGER NOT NULL, removed_at INTEGER, last_read_seq INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE collaboration_agent_sessions (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, participant_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL, title TEXT NOT NULL, last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_completion_at INTEGER);
  CREATE TABLE collaboration_agent_session_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mission_id TEXT, role TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls_json TEXT, tool_call_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
  CREATE TABLE collaboration_events (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, mission_id TEXT, seq INTEGER NOT NULL,
    actor_type TEXT NOT NULL, actor_participant_id TEXT, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL, reply_to_event_id TEXT, idempotency_key TEXT,
    created_at INTEGER NOT NULL);
`

test(
  'a group chat from an earlier version opens as a manager chat with its timeline',
  { timeout: 120_000 },
  async () => {
    const Database = require('better-sqlite3')
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-group-upgrade-'))
    const launch = () =>
      electron.launch({
        args: [ROOT, '--disable-gpu', '--sidekick-e2e'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          SIDEKICK_E2E_USER_DATA_DIR: profile,
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
        },
        timeout: 30_000
      })
    let application
    try {
      // First start creates the current database; then it is turned back into one from before
      // the upgrade, holding one group of two project agents.
      application = await launch()
      const first = await application.firstWindow()
      await first.waitForFunction(() => Boolean(window.api?.sessions))
      await application.close()
      application = undefined
      const now = Date.now()
      const db = new Database(join(profile, 'conversations.db'))
      for (const name of ['demo', 'api']) mkdirSync(join(profile, name))
      db.exec(LEGACY_GROUP_TABLES)
      db.prepare(
        "DELETE FROM schema_migrations WHERE id = '20261016_004_group_chats_to_chats'"
      ).run()
      const project = db.prepare(
        'INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      project.run('demo', 'sidekick-demo', join(profile, 'demo'), now, now)
      project.run('api', 'sidekick-api', join(profile, 'api'), now, now)
      db.prepare('INSERT INTO collaboration_groups VALUES (?, ?, NULL, ?, ?, ?, NULL)').run(
        'g1',
        'Desktop + API launch',
        'active',
        now - 5000,
        now
      )
      const participant = db.prepare(
        "INSERT INTO collaboration_participants VALUES (?, 'g1', ?, ?, '{}', 'active', ?, NULL, 0)"
      )
      participant.run('p1', 'demo', 'Desktop client', now - 4900)
      participant.run('p2', 'api', 'API endpoint', now - 4800)
      const event = db.prepare(
        "INSERT INTO collaboration_events VALUES (?, 'g1', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?)"
      )
      event.run(
        'e1',
        1,
        'user',
        null,
        'user_message',
        JSON.stringify({ text: 'Agree on the contract for /v1/projects.' }),
        now - 4000
      )
      event.run(
        'e2',
        2,
        'agent',
        'p1',
        'peer_message',
        JSON.stringify({
          text: 'What does /v1/projects return?',
          metadata: { messageType: 'request' }
        }),
        now - 3000
      )
      event.run(
        'e3',
        3,
        'agent',
        'p2',
        'peer_message',
        JSON.stringify({
          text: 'It returns projects and nextCursor.',
          metadata: { messageType: 'response' }
        }),
        now - 2000
      )
      db.close()

      application = await launch()
      const page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.sessions))
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1400, 900)
      )
      const family = await page.evaluate(() => window.api.sessions.family('g1'))
      assert.equal(family.manager.title, 'Desktop + API launch')
      assert.deepEqual(
        family.workers.map(({ handle, projectName }) => [handle, projectName]),
        [
          ['desktop-client', 'sidekick-demo'],
          ['api-endpoint', 'sidekick-api']
        ]
      )
      const messages = await page.evaluate(() => window.api.sessions.messages('g1'))
      assert.deepEqual(
        messages.map(({ intent }) => intent),
        ['request', 'response']
      )
      if (process.env.SIDEKICK_GROUP_UPGRADE_DEBUG)
        await page.screenshot({ path: resolve(process.env.SIDEKICK_GROUP_UPGRADE_DEBUG) })
      await page.getByText('Desktop + API launch', { exact: true }).first().click()
      await page
        .getByText('Agree on the contract for /v1/projects.')
        .first()
        .waitFor({ timeout: 15_000 })
      const screenshot = process.env.SIDEKICK_GROUP_UPGRADE_SCREENSHOT
      if (screenshot) {
        await delay(1_000)
        await page.screenshot({ path: resolve(screenshot) })
      }
    } finally {
      if (application) await application.close()
      const resolved = resolve(profile)
      assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}`))
      rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)
