// Behavior the user would otherwise find in daily use, checked in the built app against a
// scripted model on loopback (scripts/scripted-model.cjs). The scenarios assert sizes and
// timing, not only that something finished: when compaction fires, that every request fits the
// window, that a worker's report reaches its manager whole, and that a long one stays readable.
// Each scenario also states the exact model requests it expects, so an extra compaction or retry
// fails it. Needs `npm run build` (or `npm run build:unpack`) first.
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const { startScriptedModel, text } = require('./scripted-model.cjs')

const ROOT = resolve(__dirname, '..')
const MODEL = 'behavior-model'
const PROVIDER = 'behavior-provider'
const MODEL_REF = `lmstudio:${PROVIDER}/${MODEL}`
// A large local model configured the way the user's is: a big window and a large reply limit,
// scaled down so the fixtures stay small. Before the fix, holding the whole reply limit back
// compacted this model at 38% of its window; now the trigger is 95,683 tokens, 73%.
const WINDOW = 131_072
const REPLY_LIMIT = 100_000
const TRIGGER_SHARE = 95_683 / WINDOW
// Real tokenizers read English at about four characters a token.
const CHARS_PER_TOKEN = 4
const FILLER = 'Notes on the fixture project. '

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

/** A worker's long reply, with markers at both ends and numbered lines in between. */
function workerReply(handle, length) {
  const head = `BEGIN-${handle}\n`
  const tail = `\nEND-${handle}`
  let body = ''
  for (let line = 0; body.length < length - head.length - tail.length; line++) {
    body += `${handle} finding ${String(line).padStart(5, '0')}: FB35 network checked.\n`
  }
  return head + body.slice(0, length - head.length - tail.length) + tail
}

const REPLIES = { whole: workerReply('whole', 30_000), long: workerReply('long', 70_000) }

const isCompaction = (messages) =>
  messages.some((message) => text(message.content).includes('<previous_summary'))
const isWorker = (messages) =>
  messages.some(
    (message) =>
      message.role === 'system' && text(message.content).includes('started by another chat')
  )

function reply(messages) {
  const all = messages.map((message) => text(message.content)).join('\n')
  if (isCompaction(messages)) return { content: 'Summary: fixture notes, nothing decided yet.' }
  if (isWorker(messages)) {
    const handle = /Reply as (\w+)/.exec(all)?.[1]
    // The short report streams in many small pieces, as a slow local model sends it.
    return {
      content: REPLIES[handle] ?? 'Unknown brief.',
      stream: handle === 'whole' ? { chunks: 150, delayMs: 2 } : undefined
    }
  }
  if (all.includes('COMPACTION-FIXTURE')) return { content: 'Noted.' }
  const last = messages.at(-1)
  if (last.role === 'tool') {
    return all.includes('long finding')
      ? { content: 'Read the whole of both reports.' }
      : { content: 'Started two chats; I will read their reports.' }
  }
  const stored = /Read the rest with tool_output, handle ([0-9a-f-]{36}), from offset (\d+)/.exec(
    all
  )
  if (stored) {
    return {
      toolCall: {
        name: 'tool_output',
        arguments: { handle: stored[1], offset: Number(stored[2]), max_bytes: 51_200 }
      }
    }
  }
  return {
    toolCall: {
      name: 'start_session',
      arguments: {
        sessions: [
          { title: 'Whole report', handle: 'whole', brief: 'Reply as whole', work_in: 'folder' },
          { title: 'Long report', handle: 'long', brief: 'Reply as long', work_in: 'folder' }
        ]
      }
    }
  }
}

/** Every request must leave the window room for the reply it asks for. */
function assertFits(record) {
  const prompt = record.promptCharacters / CHARS_PER_TOKEN
  assert.ok(
    prompt + (record.maxTokens ?? 0) <= WINDOW,
    `A request asked for ${record.maxTokens} reply tokens on top of about ${Math.round(prompt)} prompt tokens, more than the ${WINDOW}-token window`
  )
}

test(
  'compaction, request size, and worker reports behave as configured',
  { timeout: 240_000 },
  async () => {
    assert.ok(
      existsSync(join(ROOT, 'out', 'main', 'index.js')),
      'Run `npm run build` before this test.'
    )
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-behavior-'))
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
      models: [{ id: MODEL, context_length: WINDOW }],
      reply
    })
    let application
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
      const page = await application.firstWindow()
      await page.waitForFunction(() => Boolean(window.api?.sessions))
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(1400, 900)
      )

      const { projectId, pinned } = await page.evaluate(
        async ({ baseUrl, workspace, model, provider, ref, window: contextLength, replyLimit }) => {
          const limits = { contextLength, maxOutputTokens: replyLimit }
          await window.api.settings.save({
            providerInstances: [
              {
                id: provider,
                name: 'Scripted loopback model',
                type: 'openai-compatible',
                preset: 'generic',
                enabled: true,
                baseUrl,
                modelSource: 'manual',
                models: [
                  {
                    id: model,
                    enabled: true,
                    supportsTools: true,
                    ...limits,
                    metadataOverrides: limits
                  }
                ]
              }
            ],
            selectedModel: ref,
            commandPermissionMode: 'full-access',
            autoCompactEnabled: true,
            autoCompactThreshold: 0.8,
            notificationsEnabled: false
          })
          const project = await window.api.projects.create(workspace, 'behavior-fixture')
          return {
            projectId: project.id,
            pinned: {
              id: ref,
              name: model,
              provider: 'lmstudio',
              providerKind: 'openai-compatible',
              providerInstanceId: provider,
              providerModelId: model,
              supportsTools: true,
              ...limits
            }
          }
        },
        {
          baseUrl: model.url,
          workspace,
          model: MODEL,
          provider: PROVIDER,
          ref: MODEL_REF,
          window: WINDOW,
          replyLimit: REPLY_LIMIT
        }
      )

      /**
       * Adds the user's message and starts the run, as the app does: the reply is saved when the
       * run finishes, so no empty reply sits at the end of the history the model is sent.
       */
      const send = async (conversationId, runId, content, answer) => {
        await page.evaluate(
          async ({ conversationId, runId, content, pinned }) => {
            await window.api.conversations.saveMessage({
              id: `${runId}-user`,
              conversation_id: conversationId,
              role: 'user',
              content,
              timestamp: Date.now()
            })
            await window.api.agentRuns.startConversation({
              id: runId,
              conversationId,
              assistantMessageId: `${runId}-reply`,
              model: pinned
            })
          },
          { conversationId, runId, content, pinned }
        )
        if (answer) {
          await until(
            () =>
              page.evaluate(
                async ({ conversationId, runId, answer }) =>
                  (await window.api.conversations.getMessages(conversationId)).some(
                    (message) =>
                      message.id === `${runId}-reply` && message.content?.includes(answer)
                  ),
                { conversationId, runId, answer }
              ),
            `${runId} should answer "${answer}"`,
            90_000
          )
        }
      }

      // --- Compaction waits for the share of the window Settings names -----------------------
      const notes = await page.evaluate(
        async (projectId) =>
          (await window.api.conversations.create('COMPACTION-FIXTURE', projectId)).id,
        projectId
      )
      // About 58% of the window: past where the old rule compacted (38%), short of the new 73%.
      const history = Math.round(WINDOW * 0.5 * 3.33)
      await page.evaluate(
        async ({ notes, filler, history }) => {
          for (let index = 0; index < 4; index++) {
            await window.api.conversations.saveMessage({
              id: `history-${index}`,
              conversation_id: notes,
              role: index % 2 ? 'agent' : 'user',
              content: `COMPACTION-FIXTURE ${index} ${filler.repeat(Math.ceil(history / 4 / filler.length))}`,
              timestamp: Date.now() - 10_000 + index
            })
          }
        },
        { notes, filler: FILLER, history }
      )
      const before = model.requests.length
      await send(notes, 'notes-first', 'COMPACTION-FIXTURE: one more note.', 'Noted.')
      const first = model.requests.slice(before)
      assert.equal(first.length, 1, 'A chat under the threshold sends exactly one request')
      assert.equal(
        isCompaction(first[0].messages),
        false,
        'It must not compact below the threshold'
      )
      assert.ok(
        first[0].promptCharacters / CHARS_PER_TOKEN > WINDOW * 0.4,
        'The fixture must be past where the old rule compacted'
      )
      // The reply limit is cut to the room left, never the whole configured limit.
      assert.ok(first[0].maxTokens < REPLY_LIMIT)
      first.forEach(assertFits)

      // Past the threshold, the next run compacts once before it asks the model.
      const middle = model.requests.length
      await send(
        notes,
        'notes-second',
        `COMPACTION-FIXTURE: a long addition. ${FILLER.repeat(Math.ceil((WINDOW * 0.3 * 3.33) / FILLER.length))}`,
        'Noted.'
      )
      const second = model.requests.slice(middle)
      assert.deepEqual(
        second.map((record) => (isCompaction(record.messages) ? 'compaction' : 'reply')),
        ['compaction', 'reply'],
        'Past the threshold a run compacts exactly once, then answers'
      )
      second.forEach(assertFits)
      assert.ok(
        second[1].promptCharacters / CHARS_PER_TOKEN < WINDOW * TRIGGER_SHARE,
        'After compacting, the request is back under the threshold'
      )
      assert.ok(
        text(second[1].messages.at(-1).content).includes('a long addition'),
        'The latest message survives compaction word for word'
      )

      // The context card marks where compaction really fires.
      await page.getByText('COMPACTION-FIXTURE', { exact: true }).first().click()
      const card = await until(
        () =>
          page.evaluate(() => {
            const indicator = document.querySelector('.context-indicator')
            if (!indicator) return null
            indicator.dispatchEvent(
              new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })
            )
            const marker = document.querySelector('.context-threshold-marker')
            return marker
              ? {
                  left: parseFloat(marker.style.left),
                  line: document.querySelector('.context-threshold-line')?.textContent ?? ''
                }
              : null
          }),
        'The context card should show where compaction fires',
        15_000
      )
      assert.ok(
        Math.abs(card.left - TRIGGER_SHARE * 100) < 1,
        `The marker sits at ${card.left}%, compaction fires at ${(TRIGGER_SHARE * 100).toFixed(1)}%`
      )
      assert.match(card.line, /73% · 95\.7K/)

      // --- A worker's report reaches its manager whole, and a longer one stays readable -------
      const manager = await page.evaluate(
        async (projectId) => (await window.api.conversations.create('Report checks', projectId)).id,
        projectId
      )
      const familyStart = model.requests.length
      await send(manager, 'manager-run', 'Delegate the report checks.')
      await until(
        () =>
          page.evaluate(
            async (id) =>
              (await window.api.conversations.getMessages(id)).some((message) =>
                message.content?.includes('Read the whole of both reports.')
              ),
            manager
          ),
        'The manager should read both reports and the stored rest of the long one',
        120_000
      )
      const family = model.requests.slice(familyStart)
      family.forEach(assertFits)
      const kinds = family.map((record) =>
        isCompaction(record.messages)
          ? 'compaction'
          : isWorker(record.messages)
            ? 'worker'
            : 'manager'
      )
      assert.deepEqual(
        [...kinds].sort(),
        ['manager', 'manager', 'manager', 'manager', 'worker', 'worker'],
        'Start two chats, two worker replies, read the reports, read the stored rest, answer'
      )

      const reports = await page.evaluate(
        async (id) =>
          (await window.api.sessions.messages(id)).filter(({ intent }) => intent === 'report'),
        manager
      )
      const whole = reports.find(({ body }) => body.includes('BEGIN-whole'))
      const long = reports.find(({ body }) => body.includes('BEGIN-long'))
      assert.ok(
        whole?.body.includes(REPLIES.whole),
        'A 30,000-character reply arrives byte for byte'
      )
      assert.ok(long, 'The long report arrives')
      assert.ok(long.body.includes(REPLIES.long.slice(0, 40_000)), 'It keeps the first 40,000')
      assert.ok(long.body.includes(REPLIES.long.slice(-8_000)), 'and the last 8,000 characters')
      assert.ok(!long.body.includes(REPLIES.long), 'and leaves the middle to the stored reply')

      const readBack = family.find((record) => record.messages.at(-1)?.role === 'tool')
      const stored = family
        .flatMap((record) => record.messages)
        .filter((message) => message.role === 'tool')
        .map((message) => text(message.content))
        .find((content) => content.includes('long finding'))
      assert.ok(readBack && stored, 'The manager read the stored reply with tool_output')
      assert.ok(
        stored.includes(REPLIES.long.slice(40_000, 62_000)),
        'tool_output returns the part the report left out'
      )
    } finally {
      if (application) await application.close()
      await model.close()
      const resolved = resolve(profile)
      assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}`))
      rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)
