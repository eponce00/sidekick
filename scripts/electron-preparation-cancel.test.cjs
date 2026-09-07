// Packaged preload/coordinator regression: disposable profile, loopback only, no inference.
const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join, relative } = require('node:path')
const { createServer } = require('node:http')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(predicate, message) {
  const deadline = Date.now() + 15000
  do {
    if (await predicate()) return
    await delay(50)
  } while (Date.now() < deadline)
  assert.fail(message)
}

test(
  'packaged preparation cancellation prevents late model start and durably finalizes',
  {
    skip: process.env.SIDEKICK_PREPARATION_CANCEL_RUN !== '1',
    timeout: 90000
  },
  async () => {
    assert.equal(process.platform, 'win32')
    assert.ok(process.env.SIDEKICK_E2E_EXECUTABLE, 'Set the explicit packaged executable')
    const executable = resolve(process.env.SIDEKICK_E2E_EXECUTABLE)
    assert.ok(existsSync(executable) && executable.endsWith('.exe'))
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-preparation-cancel-'))
    const workspace = join(profile, 'workspace')
    mkdirSync(workspace)
    const pendingMetadata = new Set()
    let metadataCalls = 0,
      completionCalls = 0,
      released = false
    const respondMetadata = (response) => {
      if (!response.destroyed) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'cancel-fixture', context_length: 32768 }] }))
      }
    }
    const releaseMetadata = () => {
      released = true
      for (const response of pendingMetadata) respondMetadata(response)
      pendingMetadata.clear()
    }
    const server = createServer((request, response) => {
      request.resume()
      if (request.url === '/v1/models') {
        metadataCalls++
        if (released) respondMetadata(response)
        else pendingMetadata.add(response)
      } else if (request.url === '/v1/chat/completions') {
        completionCalls++
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          'data: {"choices":[{"delta":{"content":"Unexpected request"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        )
      } else response.writeHead(404).end()
    })
    let application, primaryError
    try {
      await new Promise((done, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', done)
      })
      const launch = async () => {
        application = await electron.launch({
          executablePath: executable,
          args: ['--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
          env: {
            ...process.env,
            NODE_ENV: 'production',
            SIDEKICK_E2E_USER_DATA_DIR: profile,
            ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
          },
          timeout: 30000
        })
        assert.equal(
          resolve(await application.evaluate(({ app }) => app.getPath('userData'))),
          resolve(profile)
        )
        assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
        const page = await application.firstWindow()
        await page.waitForFunction(() => Boolean(window.api?.agentRuns))
        return page
      }
      let page = await launch()
      const conversationId = await page.evaluate(
        async ({ baseUrl, workspace }) => {
          // No contextLength on either target or configuration: preparation must discover it.
          const model = {
            id: 'cancel-fixture',
            name: 'cancel-fixture',
            provider: 'lmstudio',
            providerKind: 'openai-compatible',
            providerInstanceId: 'cancel-provider',
            providerModelId: 'cancel-fixture',
            supportsTools: false,
            supportsVision: false,
            maxOutputTokens: 128
          }
          await window.api.settings.save({
            providerInstances: [
              {
                id: 'cancel-provider',
                name: 'Controlled loopback fixture',
                type: 'openai-compatible',
                preset: 'generic',
                enabled: true,
                baseUrl,
                modelSource: 'manual',
                models: [
                  {
                    id: 'cancel-fixture',
                    enabled: true,
                    supportsTools: false,
                    maxOutputTokens: 128
                  }
                ]
              }
            ],
            notificationsEnabled: false
          })
          const project = await window.api.projects.create(workspace, 'Cancellation fixture')
          const conversation = await window.api.conversations.create(
            'Cancellation fixture',
            project.id
          )
          await window.api.conversations.saveMessage({
            id: 'cancel-user',
            conversation_id: conversation.id,
            role: 'user',
            content: 'Synthetic cancellation fixture.',
            timestamp: Date.now()
          })
          await window.api.conversations.saveMessage({
            id: 'cancel-assistant',
            conversation_id: conversation.id,
            role: 'agent',
            content: '',
            timestamp: Date.now() + 1
          })
          window.__cancelFixture = { settled: false }
          // Observe rejection, but leave the renderer free for the separate stop IPC.
          void window.api.agentRuns
            .startConversation({
              id: 'cancel-run',
              conversationId: conversation.id,
              assistantMessageId: 'cancel-assistant',
              model
            })
            .then(
              () => {
                window.__cancelFixture.settled = true
              },
              () => {
                window.__cancelFixture.settled = true
                window.__cancelFixture.rejected = true
              }
            )
          return conversation.id
        },
        { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, workspace }
      )
      await until(() => metadataCalls > 0, 'Preparation must request controlled metadata')
      assert.equal(await page.evaluate(() => window.__cancelFixture.settled), false)
      const stopped = await page.evaluate(() => window.api.agentRuns.stop('cancel-run'))
      assert.equal(
        stopped.stopped,
        true,
        'Stop must accept cancellation before kernel registration'
      )
      await until(
        () => page.evaluate(() => window.__cancelFixture.settled),
        'Cancelled start must settle before metadata release'
      )
      assert.equal(await page.evaluate(() => Boolean(window.__cancelFixture.rejected)), false)
      const inspect = async () => {
        const journal = await page.evaluate(() => window.api.agentRuns.events('cancel-run'))
        assert.equal(journal.run.phase, 'cancelled')
        assert.equal(journal.events.filter((event) => event.type === 'run.completed').length, 1)
        assert.equal(journal.events.filter((event) => event.type === 'run.finalized').length, 1)
        assert.equal(journal.events.filter((event) => event.type.startsWith('tool.')).length, 0)
        const messages = await page.evaluate(
          (id) => window.api.conversations.getMessages(id),
          conversationId
        )
        assert.equal(
          messages.filter(
            (message) => message.id === 'cancel-assistant' && message.runId === 'cancel-run'
          ).length,
          1
        )
        assert.equal(
          completionCalls,
          0,
          'Cancelled preparation must never dispatch chat/completions'
        )
      }
      await inspect()
      releaseMetadata()
      await delay(500)
      await inspect()
      await application.close()
      application = undefined
      page = await launch()
      await inspect()
      console.info(
        JSON.stringify({
          preparationCancelled: true,
          durableAfterRestart: true,
          metadataCalls,
          completionCalls
        })
      )
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      const errors = []
      try {
        if (application) await application.close()
      } catch (error) {
        errors.push(error)
      }
      releaseMetadata()
      try {
        server.closeAllConnections()
        if (server.listening)
          await new Promise((done, reject) =>
            server.close((error) => (error ? reject(error) : done()))
          )
      } catch (error) {
        errors.push(error)
      }
      try {
        const inside = relative(resolve(tmpdir()), resolve(profile))
        assert.ok(inside.startsWith('sidekick-e2e-preparation-cancel-') && !inside.includes('..'))
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        assert.equal(existsSync(profile), false)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length) {
        if (!primaryError) throw new AggregateError(errors, 'Preparation fixture cleanup failed')
        console.error(`Preparation fixture cleanup encountered ${errors.length} error(s).`)
      }
    }
  }
)
