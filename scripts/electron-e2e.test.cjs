const assert = require('node:assert/strict')
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { _electron: electron } = require('playwright')

const ROOT = resolve(__dirname, '..')
const APP_ENTRY = join(ROOT, 'out', 'main', 'index.js')

async function launchSideKick(profile) {
  assert.ok(
    existsSync(APP_ENTRY),
    'The Electron runtime is not built. Run `npm run build` before the runtime E2E test.'
  )

  return electron.launch({
    args: [ROOT, '--disable-gpu', '--sidekick-packaged-smoke-test', '--sidekick-e2e'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SIDEKICK_E2E_USER_DATA_DIR: profile,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    timeout: 30_000
  })
}

async function waitForVisible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 20_000 })
  assert.equal(await locator.isVisible(), true, `${label} should be visible`)
}

async function closeApplication(application) {
  if (!application) return
  await application.close()
}

function removeIsolatedProfile(profile) {
  const expectedRoot = resolve(tmpdir())
  const resolvedProfile = resolve(profile)
  assert.ok(resolvedProfile.startsWith(`${expectedRoot}${require('node:path').sep}`))
  assert.ok(resolvedProfile.split(require('node:path').sep).at(-1).startsWith('sidekick-e2e-'))
  rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test(
  'user opens and controls a live page inside the main app window',
  { timeout: 120_000 },
  async () => {
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-browser-'))
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(
        '<!doctype html><title>Shared browser fixture</title><h1>Shared page</h1><label>Name<input id="name"></label>'
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    let application
    try {
      application = await launchSideKick(profile)
      const page = await application.firstWindow()
      await page.getByRole('button', { name: 'Create new' }).click()
      await page.getByRole('menuitem', { name: 'New chat' }).click()
      const expand = page.getByRole('button', { name: 'Open Browser activity', exact: true })
      if (await expand.isVisible()) await expand.click()
      else await page.getByRole('button', { name: 'Open browser activity', exact: true }).click()
      const address = page.getByRole('textbox', { name: 'Browser address' })
      await address.fill(`http://127.0.0.1:${server.address().port}/`)
      await address.press('Enter')
      await waitForVisible(
        page.getByRole('tab', { name: 'Shared browser fixture' }),
        'user-opened tab'
      )
      await waitForVisible(page.getByRole('button', { name: 'Resume agent' }), 'shared control')
      const embedded = await application.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes('/out/renderer/')
        )
        if (!main) throw new Error('Main window missing')
        return {
          visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible())
            .length,
          tabs: main.contentView.children.filter((view) =>
            view.webContents?.getURL().startsWith('http://127.0.0.1')
          ).length
        }
      })
      assert.equal(embedded.tabs, 1, 'The actual web page must belong to the main contentView')
      assert.equal(embedded.visibleWindows, 1, 'Browser must not appear in a second window')
      if (process.env.SIDEKICK_E2E_BROWSER_SCREENSHOT) {
        const png = await application.evaluate(async ({ BrowserWindow }) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().includes('/out/renderer/')
          )
          return (await main.capturePage()).toPNG().toString('base64')
        })
        writeFileSync(process.env.SIDEKICK_E2E_BROWSER_SCREENSHOT, Buffer.from(png, 'base64'))
      }
      if (process.env.SIDEKICK_E2E_VISUAL_REVIEW === '1') {
        await new Promise((resolve) => setTimeout(resolve, 45_000))
      }
      await page.getByRole('button', { name: 'Resume agent' }).click()
      await waitForVisible(page.getByRole('button', { name: 'Take control' }), 'resumed browser')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await waitForVisible(page.getByRole('dialog', { name: 'Settings' }), 'settings above browser')
    } finally {
      await closeApplication(application)
      await new Promise((resolve) => server.close(resolve))
      removeIsolatedProfile(profile)
    }
  }
)

test(
  'critical desktop journey stays isolated, persists locally, and exposes release support UI',
  {
    timeout: 120_000
  },
  async () => {
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-'))
    let application
    let page

    try {
      application = await launchSideKick(profile)
      page = await application.firstWindow()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))

      await waitForVisible(
        page.getByRole('heading', { name: 'What’s next?' }),
        'clean start screen'
      )
      assert.equal(await page.title(), 'SideKick')
      assert.deepEqual(
        await page.evaluate(() => ({
          api: typeof window.api,
          nodeRequire: typeof window.require,
          nodeProcess: typeof window.process
        })),
        { api: 'object', nodeRequire: 'undefined', nodeProcess: 'undefined' }
      )

      const actualProfile = await application.evaluate(({ app }) => app.getPath('userData'))
      assert.equal(
        resolve(actualProfile),
        resolve(profile),
        'Electron must use only the E2E profile'
      )

      await page.getByRole('button', { name: 'Create new' }).click()
      await waitForVisible(page.getByRole('menuitem', { name: 'New chat' }), 'new-chat menu item')
      await page.getByRole('menuitem', { name: 'New chat' }).click()
      await waitForVisible(page.getByText('New Conversation', { exact: true }).first(), 'new chat')

      await page.getByRole('button', { name: 'Settings' }).click()
      await waitForVisible(page.getByRole('dialog', { name: 'Settings' }), 'settings dialog')
      await waitForVisible(page.getByRole('main', { name: 'General settings' }), 'general settings')
      await waitForVisible(
        page.getByRole('button', { name: 'Export diagnostics' }),
        'diagnostic export action'
      )
      assert.match(
        await page.getByText(/Excludes conversations, prompts, files/).textContent(),
        /credentials/
      )

      await page.getByRole('button', { name: /^Providers/ }).click()
      await waitForVisible(page.getByRole('heading', { name: 'Providers' }), 'provider settings')
      await waitForVisible(page.getByRole('heading', { name: 'Add a provider' }), 'provider picker')
      await page.getByRole('button', { name: 'Close provider picker' }).click()
      await waitForVisible(page.getByText('No providers configured yet.'), 'empty provider state')

      await page.getByRole('button', { name: /^Integrations/ }).click()
      await waitForVisible(
        page.getByRole('heading', { name: 'Integrations' }),
        'integration settings'
      )
      for (const connector of ['Atlassian', 'Notion', 'Airtable']) {
        await waitForVisible(
          page.getByRole('button', { name: new RegExp(connector) }),
          `${connector} connector`
        )
      }
      await page.getByRole('button', { name: 'Back to app' }).click()

      await page.getByRole('textbox', { name: 'Search conversations' }).fill('New Conversation')
      await waitForVisible(
        page.getByText('New Conversation', { exact: true }).first(),
        'chat search result'
      )
      assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join('\n')}`)

      await closeApplication(application)
      application = undefined
      assert.ok(existsSync(join(profile, 'conversations.db')), 'the isolated database should exist')

      application = await launchSideKick(profile)
      page = await application.firstWindow()
      await waitForVisible(
        page.getByText('New Conversation', { exact: true }).first(),
        'persisted chat after restart'
      )

      const persistedChat = page.getByText('New Conversation', { exact: true }).first()
      await persistedChat.hover()
      await page.getByRole('button', { name: 'Delete New Conversation' }).click()
      await waitForVisible(
        page.getByRole('heading', { name: 'Delete conversation?' }),
        'delete confirmation'
      )
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
      await waitForVisible(page.getByText('Standalone chats appear here'), 'empty chat state')
    } catch (error) {
      if (page) {
        try {
          const resultsDirectory = join(ROOT, 'test-results')
          mkdirSync(resultsDirectory, { recursive: true })
          await page.screenshot({
            path: join(resultsDirectory, 'electron-e2e-failure.png'),
            fullPage: true
          })
        } catch {
          // The application may already be closed; keep the original failure.
        }
      }
      throw error
    } finally {
      await closeApplication(application)
      removeIsolatedProfile(profile)
    }
  }
)
