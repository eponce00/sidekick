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
// The most one reply may hold on a hosted model that refuses more without listing its cap.
const HOSTED_REPLY_CAP = 16_384
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

// Workers answer once the manager's own turn is over, as real workers, which take far longer than
// one turn, do. An instant worker reports while the manager is still answering, and that report is
// steered into the turn instead of waking the manager with both reports.
let releaseWorkers
const workersMayAnswer = new Promise((done) => (releaseWorkers = done))

const isCompaction = (messages) =>
  messages.some((message) => text(message.content).includes('<previous_summary'))
const isWorker = (messages) =>
  messages.some(
    (message) =>
      message.role === 'system' && text(message.content).includes('started by another chat')
  )

function reply(messages, request) {
  const all = messages.map((message) => text(message.content)).join('\n')
  if (isCompaction(messages)) return { content: 'Summary: fixture notes, nothing decided yet.' }
  if (all.includes('REFUSAL-FIXTURE')) {
    // Groq's own words when a reply limit is above its cap.
    const message = `\`max_tokens\` must be less than or equal to \`${HOSTED_REPLY_CAP}\`, the maximum value for \`max_tokens\` is less than the \`context_window\` for this model`
    return request.maxTokens > HOSTED_REPLY_CAP
      ? { refuse: { status: 400, body: JSON.stringify({ error: { message } }) } }
      : { content: 'Answered within the cap.' }
  }
  if (all.includes('GATEWAY-FIXTURE')) {
    // A gateway whose model is down answers with a bare status page.
    return { refuse: { status: 502, body: '<html>Bad Gateway</html>', contentType: 'text/html' } }
  }
  if (isWorker(messages)) {
    const handle = /Reply as (\w+)/.exec(all)?.[1]
    // The short report streams in many small pieces, as a slow local model sends it.
    return workersMayAnswer.then(() => ({
      content: REPLIES[handle] ?? 'Unknown brief.',
      stream: handle === 'whole' ? { chunks: 150, delayMs: 2 } : undefined
    }))
  }
  if (all.includes('COMPACTION-FIXTURE')) return { content: 'Noted.' }
  const last = messages.at(-1)
  if (all.includes('RUNAWAY-FIXTURE')) {
    if (last.role === 'tool') return { content: 'Ran it once; the cell answered.' }
    if (text(last.content).includes('sidekick_runaway_reply'))
      return {
        toolCall: { name: 'shell', arguments: { title: 'Once', command: 'echo once-call' } }
      }
    // The work PC's runaway: the same call written over and over, a model still streaming it.
    return {
      toolCalls: Array.from({ length: 50 }, () => ({
        name: 'shell',
        arguments: { title: 'Click', command: 'echo runaway-call' }
      })),
      stream: { delayMs: 25 }
    }
  }
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
  'compaction, request size, worker reports, and provider refusals behave as configured',
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

      // --- A reply that writes the same call over and over is stopped as it streams -----------
      // A work PC's 767 refused calls all came from one reply that wrote 784 calls in five
      // minutes, 781 of them the same click, until its output limit cut it off.
      const runawayChat = await page.evaluate(
        async (projectId) => (await window.api.conversations.create('Runaway', projectId)).id,
        projectId
      )
      const runawayStart = model.requests.length
      await send(
        runawayChat,
        'runaway-run',
        'RUNAWAY-FIXTURE: click the start button.',
        'Ran it once; the cell answered.'
      )
      const runawayRequests = model.requests.slice(runawayStart)
      assert.equal(
        runawayRequests.length,
        3,
        'The runaway reply, the reply after the notice, and the answer to its one call'
      )
      assert.equal(runawayRequests[0].aborted, true, 'SideKick hung up while the reply streamed')
      const notice = text(runawayRequests[1].messages.at(-1).content)
      assert.ok(
        notice.includes(
          'SideKick stopped your last reply because it wrote the same shell call, with the same arguments, 4 times. None of its tool calls ran.'
        ),
        `The next request says why: ${notice}`
      )
      const sentAfterStop = runawayRequests[1].messages
      assert.ok(
        !sentAfterStop.some((message) => message.tool_calls?.length || message.role === 'tool'),
        'None of the runaway calls reached the transcript, and none ran'
      )
      const once = text(runawayRequests[2].messages.at(-1).content)
      assert.ok(
        once.startsWith('Exit code: 0\n') && once.includes('once-call'),
        `The one call ran, and its output reads as text: ${once.slice(0, 200)}`
      )
      assert.ok(!once.includes('\\n'), 'Command output is not JSON-escaped')
      assert.ok(
        !runawayRequests.some((record) =>
          record.messages.some(
            (message) => message.role === 'tool' && text(message.content).includes('runaway-call')
          )
        ),
        'No runaway command ran'
      )

      // --- A worker's report reaches its manager whole, and a longer one stays readable -------
      const manager = await page.evaluate(
        async (projectId) => (await window.api.conversations.create('Report checks', projectId)).id,
        projectId
      )
      const familyStart = model.requests.length
      await send(
        manager,
        'manager-run',
        'Delegate the report checks.',
        'Started two chats; I will read their reports.'
      )
      await until(
        () =>
          page.evaluate(async (id) => {
            const status = (await window.api.sessions.statuses()).find(
              ({ conversationId }) => conversationId === id
            )
            return status?.state !== 'working' && status?.state !== 'queued'
          }, manager),
        'The manager should finish its turn'
      )
      releaseWorkers()
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
      const intentOf = (message) =>
        message?.role === 'user'
          ? /<sidekick_chat_message [^>]*intent="(\w+)"/.exec(text(message.content))?.[1]
          : undefined
      // What prompted each request, so a failure says which turn was extra.
      const trace = family
        .map((record, index) => {
          const last = record.messages.at(-1)
          return `${kinds[index]} after ${intentOf(last) ?? last?.role}`
        })
        .join('; ')
      assert.deepEqual(
        [...kinds].sort(),
        ['manager', 'manager', 'manager', 'manager', 'worker', 'worker'],
        `Start two chats, two worker replies, read the reports, read the stored rest, answer. Sent: ${trace}`
      )
      const woken = family.find((record) =>
        record.messages.some((message) => intentOf(message) === 'report')
      )
      assert.ok(
        ['BEGIN-whole', 'BEGIN-long'].every((marker) =>
          woken?.messages.some(
            (message) => intentOf(message) === 'report' && text(message.content).includes(marker)
          )
        ),
        `The manager wakes once, with both reports. Sent: ${trace}`
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

      // --- A provider's refusals: retried where SideKick can, said plainly where it cannot ----
      // Last, because the reply cap it teaches the app holds for this model from then on.
      const refusals = await page.evaluate(
        async (projectId) =>
          (await window.api.conversations.create('Refusal checks', projectId)).id,
        projectId
      )
      const refusalStart = model.requests.length
      await send(
        refusals,
        'refusal-first',
        'REFUSAL-FIXTURE: answer within the cap.',
        'Answered within the cap.'
      )
      const refused = model.requests.slice(refusalStart).map((record) => record.maxTokens)
      assert.equal(refused.length, 2, 'A refused reply limit is asked again exactly once')
      assert.ok(refused[0] > HOSTED_REPLY_CAP, 'The first request asks for more than the cap')
      assert.equal(refused[1], HOSTED_REPLY_CAP, 'The retry asks for the cap the provider named')
      const laterStart = model.requests.length
      await send(
        refusals,
        'refusal-later',
        'REFUSAL-FIXTURE: and once more.',
        'Answered within the cap.'
      )
      assert.deepEqual(
        model.requests.slice(laterStart).map((record) => record.maxTokens <= HOSTED_REPLY_CAP),
        [true],
        'A later run asks for no more than the cap from the start'
      )

      const gateway = await page.evaluate(
        async (projectId) =>
          (await window.api.conversations.create('Gateway checks', projectId)).id,
        projectId
      )
      const gatewayStart = model.requests.length
      await send(gateway, 'gateway-run', 'GATEWAY-FIXTURE: is anyone there?')
      const failed = await until(
        () =>
          page.evaluate(async (id) => {
            const reply = (await window.api.conversations.getMessages(id)).find(
              (message) => message.id === 'gateway-run-reply'
            )
            const segments =
              typeof reply?.segments === 'string' ? JSON.parse(reply.segments) : reply?.segments
            return segments?.find((segment) => segment.type === 'run_error')?.runError
          }, gateway),
        'The gateway run should fail'
      )
      assert.equal(failed.code, 'transient', 'A gateway with nothing behind it is not "internal"')
      // The sidebar lists chats made through the API after a reload.
      await page.reload()
      await page.waitForFunction(() => Boolean(window.api?.sessions))
      await page.getByText('Gateway checks', { exact: true }).first().click()
      const failure = await until(
        () =>
          page.evaluate(() => {
            const segment = document.querySelector('.run-error-segment')
            return segment
              ? {
                  title: segment.querySelector('strong')?.textContent ?? '',
                  text: segment.textContent ?? ''
                }
              : null
          }),
        'The failed reply should say what went wrong'
      )
      assert.equal(model.requests.length - gatewayStart, 1, 'A gateway failure is not retried')
      assert.equal(failure.title, 'Model server unavailable')
      assert.ok(
        failure.text.includes(
          'The server in front of the model got no answer from it (HTTP 502 Bad Gateway).'
        ),
        `The failed reply says what the gateway answered: ${failure.text}`
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
