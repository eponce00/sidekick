const assert = require('node:assert/strict')
const { existsSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
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
