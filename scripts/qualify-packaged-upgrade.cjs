#!/usr/bin/env node
// Extracts an authentic old NSIS payload; never runs an installer or changes an
// installed profile. All app writes are confined to an owned temporary profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { extractFile } = require('@electron/asar')

const ROOT = path.resolve(__dirname, '..')
function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function assertOwnedTemporary(root) {
  const absolute = path.resolve(root)
  const relative = path.relative(path.resolve(tmpdir()), absolute)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  assert.ok(path.basename(absolute).startsWith('sidekick-upgrade-'))
  return absolute
}
function packageIdentity(executable) {
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar')
  const metadata = JSON.parse(extractFile(archive, 'package.json').toString())
  const entry = extractFile(archive, path.join('out', 'main', 'index.js')).toString()
  assert.ok(
    entry.includes('SIDEKICK_E2E_USER_DATA_DIR') && entry.includes('sidekick-e2e-'),
    'Package lacks verified disposable-profile isolation'
  )
  return {
    version: metadata.version,
    executableSha256: hash(executable),
    archiveSha256: hash(archive)
  }
}
function extractRelease(installer, checksumFile, destination) {
  const expectedLine = fs
    .readFileSync(checksumFile, 'utf8')
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${path.basename(installer)}`))
  assert.ok(expectedLine, 'Installer missing from release checksum manifest')
  const digest = hash(installer)
  assert.equal(
    digest,
    expectedLine.split(/\s+/)[0].toLowerCase(),
    'Release installer checksum mismatch'
  )
  const sevenZip = path.join(ROOT, 'node_modules/electron-winstaller/vendor/7z-x64.exe')
  const container = path.join(destination, 'installer-payload')
  const unpacked = path.join(destination, 'old-unpacked')
  // The EXE is treated solely as a data archive, never launched.
  execFileSync(sevenZip, ['x', '-y', `-o${container}`, installer, '$PLUGINSDIR/app-64.7z'], {
    windowsHide: true,
    stdio: 'pipe'
  })
  execFileSync(
    sevenZip,
    ['x', '-y', `-o${unpacked}`, path.join(container, '$PLUGINSDIR/app-64.7z')],
    { windowsHide: true, stdio: 'pipe' }
  )
  return { executable: path.join(unpacked, 'SideKick.exe'), installerSha256: digest }
}
async function launch(executable, profile) {
  const application = await electron.launch({
    executablePath: executable,
    args: ['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SIDEKICK_E2E_USER_DATA_DIR: profile,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 30_000
  })
  try {
    assert.equal(
      path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))),
      path.resolve(profile)
    )
    const page = await application.firstWindow()
    await page.waitForFunction(
      () => Boolean(window.api?.conversations && window.api?.workspace),
      null,
      { timeout: 20_000 }
    )
    return { application, page }
  } catch (error) {
    await application.close()
    throw error
  }
}

async function qualifyHistoricalSchema(root, currentExecutable, workspaceRoot) {
  const revision = 'e6294f358932055cf2ff9f62351e2f098ed47ece' // authentic v0.5.0
  const source = execFileSync('git', ['show', `${revision}:src/main/bootstrap/database.ts`], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  })
  const historicalModule = path.join(root, 'historical-database.cjs')
  fs.writeFileSync(
    historicalModule,
    require('esbuild').transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code
  )
  const runDatabase = (mode, file) => {
    const output = execFileSync(
      require('electron'),
      [
        path.join(ROOT, 'scripts/fixtures/upgrade-database.cjs'),
        mode,
        file,
        historicalModule,
        workspaceRoot
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_PATH: path.join(ROOT, 'node_modules')
        }
      }
    )
    return JSON.parse(output.trim().split(/\r?\n/).at(-1))
  }
  const profile = path.join(root, 'sidekick-e2e-historical-schema')
  fs.mkdirSync(profile)
  const file = path.join(profile, 'conversations.db')
  const original = runDatabase('seed', file)
  assert.deepEqual(original.migrations, [])
  assert.equal(original.messageColumns.includes('attachments'), false)
  let application
  try {
    let page
    ;({ application, page } = await launch(currentExecutable, profile))
    const messages = await page.evaluate(() =>
      window.api.conversations.getMessages('historical-thread')
    )
    assert.equal(messages.length, 1)
    assert.equal(messages[0].content, original.messages[0].content)
    assert.deepEqual(messages[0].tokenUsage, { promptTokens: 111, completionTokens: 22 })
    await application.close()
    application = undefined
    const upgraded = runDatabase('inspect', file)
    assert.equal(upgraded.migrations.length, 7)
    assert.ok(upgraded.messageColumns.includes('attachments'))
    assert.deepEqual(upgraded.messages, original.messages)
    assert.equal(upgraded.integrity, 'ok')
    assert.deepEqual(upgraded.foreignKeyErrors, [])
    const backups = fs.readdirSync(profile).filter((name) => name.endsWith('.bak'))
    assert.equal(backups.length, 1)
    const backup = path.join(profile, backups[0])
    assert.deepEqual(
      runDatabase('inspect', backup),
      original,
      'Pre-upgrade backup must preserve exact historical schema and data'
    )
    // Roll back by restoring the consistent backup into a SECOND disposable
    // profile, not by sending an incompatible old app to the migrated database.
    const rollbackProfile = path.join(root, 'sidekick-e2e-restored-backup')
    fs.mkdirSync(rollbackProfile)
    const restoredFile = path.join(rollbackProfile, 'conversations.db')
    fs.copyFileSync(backup, restoredFile)
    assert.deepEqual(runDatabase('open', restoredFile), original)
    ;({ application, page } = await launch(currentExecutable, rollbackProfile))
    assert.equal(
      (await page.evaluate(() => window.api.conversations.getMessages('historical-thread'))).length,
      1
    )
    await application.close()
    application = undefined
    assert.deepEqual(runDatabase('inspect', restoredFile).messages, original.messages)
    return {
      sourceVersion: '0.5.0',
      sourceRevision: revision,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      migrationsApplied: upgraded.migrations.length,
      backupVerified: true,
      restoredBackupOpenedByHistoricalSchema: true,
      restoredBackupReUpgraded: true
    }
  } finally {
    if (application) await application.close()
  }
}
async function snapshot(page, fixture) {
  return page.evaluate(async ({ conversationId, workspaceRoot }) => {
    const conversations = await window.api.conversations.list()
    const conversation = conversations.find((item) => item.id === conversationId)
    const settings = await window.api.settings.load()
    const checkpoints = await window.api.workspace.listCheckpoints(workspaceRoot)
    return {
      conversation,
      messages: await window.api.conversations.getMessages(conversationId),
      skills: await window.api.conversations.loadSkills(conversationId),
      compaction: await window.api.conversations.getLatestCompaction(conversationId),
      memory: await window.api.memory.get(workspaceRoot),
      settings: {
        toolCallLimit: settings.toolCallLimit,
        autoCompactEnabled: settings.autoCompactEnabled,
        commandPermissionMode: settings.commandPermissionMode
      },
      checkpoints: {
        ok: checkpoints.ok,
        entries: checkpoints.checkpoints.map(({ hash, message }) => ({ hash, message }))
      }
    }
  }, fixture)
}
async function qualifyPackagedUpgrade(options = {}) {
  assert.equal(process.platform, 'win32', 'This qualification currently uses Windows NSIS payloads')
  const installer = path.resolve(
    options.oldInstaller ||
      path.join(ROOT, 'dist/release-0.6.3/SideKick-0.6.3-windows-x64-setup.exe')
  )
  const currentExecutable = path.resolve(
    options.currentExecutable ||
      path.join(ROOT, 'dist/hardening-20260905/win-unpacked/SideKick.exe')
  )
  const current = packageIdentity(currentExecutable)
  const root = fs.mkdtempSync(path.join(tmpdir(), 'sidekick-upgrade-'))
  const profile = path.join(root, 'sidekick-e2e-version-transition')
  const workspaceRoot = path.join(root, 'synthetic-workspace')
  fs.mkdirSync(profile)
  fs.mkdirSync(workspaceRoot)
  const document = path.join(workspaceRoot, 'fixture.txt')
  fs.writeFileSync(document, 'Synthetic baseline\n', 'utf8')
  let application
  const stages = []
  try {
    const extracted = extractRelease(
      installer,
      path.join(path.dirname(installer), 'SHA256SUMS.txt'),
      root
    )
    const previous = packageIdentity(extracted.executable)
    assert.notEqual(
      previous.version,
      current.version,
      'Transition requires different actual package versions'
    )
    let page
    ;({ application, page } = await launch(extracted.executable, profile))
    const fixture = await page.evaluate(async (workspaceRoot) => {
      const project = await window.api.projects.create(workspaceRoot, 'Synthetic upgrade project')
      const conversation = await window.api.conversations.create(
        'Synthetic durable history',
        project.id,
        'user'
      )
      const settings = await window.api.settings.load()
      const saved = await window.api.settings.save({
        ...settings,
        providerInstances: [],
        toolCallLimit: 37,
        autoCompactEnabled: false,
        commandPermissionMode: 'default'
      })
      if (!saved.success) throw new Error('Synthetic settings could not be saved')
      await window.api.conversations.setPinned(conversation.id, true)
      await window.api.conversations.saveSkills(conversation.id, ['pdf'])
      await window.api.memory.save(
        workspaceRoot,
        'Synthetic memory: preserve exact Unicode café 雪.'
      )
      const timestamp = Date.now()
      await window.api.conversations.saveMessage({
        id: 'synthetic-user',
        conversation_id: conversation.id,
        role: 'user',
        content: 'Preserve this synthetic history: café 雪.',
        timestamp
      })
      await window.api.conversations.saveCompaction({
        conversationId: conversation.id,
        summary: 'Synthetic retained handoff: preserve fixture.txt.',
        compactedThroughMessageId: 'synthetic-user',
        compactedThroughTimestamp: timestamp,
        originalTokens: 1000,
        summaryTokens: 50,
        messagesCompacted: 1,
        strategy: 'deterministic',
        promptVersion: 'upgrade-fixture-v1',
        provider: 'fixture',
        model: 'fixture'
      })
      const capture = await window.api.workspace.beginHistoryCapture(
        workspaceRoot,
        conversation.id,
        'synthetic-agent'
      )
      if (!capture.ok || !capture.captureId)
        throw new Error(`Synthetic capture failed: ${capture.error}`)
      return {
        conversationId: conversation.id,
        workspaceRoot,
        captureId: capture.captureId,
        timestamp
      }
    }, workspaceRoot)
    fs.writeFileSync(document, 'Synthetic updated state — café 雪\n', 'utf8')
    const checkpoint = await page.evaluate(async (fixture) => {
      const checkpoint = await window.api.workspace.createCheckpoint(
        fixture.workspaceRoot,
        'Synthetic checkpoint',
        fixture.captureId
      )
      if (!checkpoint.ok || !checkpoint.hash)
        throw new Error(`Synthetic checkpoint failed: ${checkpoint.error}`)
      await window.api.conversations.saveMessage({
        id: 'synthetic-agent',
        conversation_id: fixture.conversationId,
        role: 'agent',
        content: 'Synthetic saved result.',
        thinking: 'Synthetic reasoning fixture.',
        segments: [{ type: 'text', content: 'Synthetic saved result.' }],
        tokenUsage: { promptTokens: 100, completionTokens: 20 },
        checkpointHash: checkpoint.hash,
        checkpointWorkspaceRoot: fixture.workspaceRoot,
        timestamp: fixture.timestamp + 1
      })
      return checkpoint.hash
    }, fixture)
    const expected = await snapshot(page, fixture)
    assert.equal(expected.messages.length, 2)
    assert.equal(expected.checkpoints.ok, true)
    assert.ok(expected.checkpoints.entries.some((entry) => entry.hash === checkpoint))
    await application.close()
    application = undefined
    stages.push({ stage: 'old-seed', version: previous.version, preserved: true })
    for (const [stage, executable, version] of [
      ['upgrade', currentExecutable, current.version],
      ['compatible-rollback', extracted.executable, previous.version],
      ['re-upgrade', currentExecutable, current.version]
    ]) {
      ;({ application, page } = await launch(executable, profile))
      assert.deepEqual(
        await snapshot(page, fixture),
        expected,
        `${stage} must preserve exact synthetic application state`
      )
      const diff = await page.evaluate(
        ({ workspaceRoot, checkpoint }) =>
          window.api.workspace.getCheckpointDiff(workspaceRoot, checkpoint),
        { workspaceRoot, checkpoint }
      )
      assert.ok(
        JSON.stringify(diff).includes('Synthetic updated state'),
        `${stage} must retain checkpoint content`
      )
      assert.equal(fs.readFileSync(document, 'utf8'), 'Synthetic updated state — café 雪\n')
      await application.close()
      application = undefined
      stages.push({ stage, version, preserved: true })
    }
    const historicalSchema = await qualifyHistoricalSchema(root, currentExecutable, workspaceRoot)
    assert.deepEqual(
      packageIdentity(currentExecutable),
      current,
      'Current package changed during qualification'
    )
    return {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      status: 'passed',
      platform: process.platform,
      previous: { ...previous, installerSha256: extracted.installerSha256 },
      current,
      historicalSchema,
      stages,
      assertions: [
        'isolated-profile-path',
        'conversation-pin-and-project-affinity',
        'exact-messages-reasoning-segments-token-usage',
        'settings',
        'skills',
        'compaction',
        'workspace-memory',
        'checkpoint-identity-and-diff',
        'workspace-content',
        'compatible-rollback-and-re-upgrade'
      ],
      limitations: [
        'Extracted release application, not an installer execution; registry, shortcuts, updater replacement and installed profiles were not exercised.',
        'No schema migrations differ between these package versions; compatible rollback is not permission to downgrade across future schema changes.',
        'The schema-changing lane uses exact v0.5.0 database source under the available Electron ABI, not a full v0.5.0 binary; backup restoration is tested in a second disposable profile.',
        'Synthetic data, no credentials supplied and no model inference requested; Windows only.'
      ]
    }
  } finally {
    if (application) await application.close()
    fs.rmSync(assertOwnedTemporary(root), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300
    })
  }
}
module.exports = { assertOwnedTemporary, packageIdentity, qualifyPackagedUpgrade }
if (require.main === module) {
  qualifyPackagedUpgrade({
    currentExecutable: process.env.SIDEKICK_UPGRADE_EXECUTABLE,
    oldInstaller: process.env.SIDEKICK_UPGRADE_OLD_INSTALLER
  })
    .then((report) => {
      if (process.env.SIDEKICK_UPGRADE_REPORT)
        fs.writeFileSync(
          path.resolve(process.env.SIDEKICK_UPGRADE_REPORT),
          JSON.stringify(report, null, 2) + '\n'
        )
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
