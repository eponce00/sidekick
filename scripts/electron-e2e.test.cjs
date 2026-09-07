const assert = require('node:assert/strict')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { _electron: electron } = require('playwright')

const ROOT = resolve(__dirname, '..')
const APP_ENTRY = join(ROOT, 'out', 'main', 'index.js')

test(
  'a killed desktop recovers an uncertain tool journal through the real preload API without replay',
  { timeout: 90000 },
  async () => {
    const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-crash-'))
    let application
    let writer
    try {
      application = await launchSideKick(profile)
      await waitForVisible(
        (await application.firstWindow()).getByRole('heading', { name: 'What’s next?' }),
        'startup'
      )
      // Inject a real durable partial-run boundary in this disposable profile. The
      // provider/tool is synthetic; restart and recovery use the actual application.
      const script = join(profile, 'crash-writer.cjs')
      await require('esbuild').build({
        entryPoints: [join(ROOT, 'src/main/services/fixtures/crashRunWriter.ts')],
        outfile: script,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external'
      })
      writer = spawn(
        require('electron'),
        [script, join(profile, 'conversations.db'), join(profile, 'effect.txt')],
        {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_PATH: join(ROOT, 'node_modules')
          }
        }
      )
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Crash writer checkpoint timed out')),
          10000
        )
        writer.once('message', () => {
          clearTimeout(timer)
          resolve()
        })
        writer.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        writer.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('Crash writer exited before checkpoint'))
        })
      })
      const writerStopped = new Promise((resolve) => writer.once('exit', resolve))
      writer.kill('SIGKILL')
      await writerStopped
      writer = undefined
      const ownedProcess = application.process()
      const stopped = new Promise((resolve) => ownedProcess.once('exit', resolve))
      if (process.platform === 'win32')
        await promisify(execFile)('taskkill', ['/PID', String(ownedProcess.pid), '/T', '/F'], {
          windowsHide: true
        })
      else ownedProcess.kill('SIGKILL')
      await stopped
      application = undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        application = await launchSideKick(profile)
        const page = await application.firstWindow()
        const state = await page.evaluate(() => window.api.agentRuns.latest('crash-thread'))
        assert.equal(state.run.phase, 'interrupted')
        const completed = state.events.filter((event) => event.type === 'tool.completed')
        assert.equal(completed.length, 1)
        assert.match(JSON.stringify(completed[0]), /OUTCOME UNKNOWN/)
        assert.equal(completed[0].payload.result.error.recoveryAction, 'refresh_state')
        assert.equal(state.events.filter((event) => event.type === 'run.finalized').length, 1)
        assert.equal(readFileSync(join(profile, 'effect.txt'), 'utf8'), 'effect\n')
        await closeApplication(application)
        application = undefined
      }
    } finally {
      if (writer && writer.exitCode === null) {
        const stopped = new Promise((resolve) => writer.once('exit', resolve))
        writer.kill('SIGKILL')
        await stopped
      }
      await closeApplication(application)
      removeIsolatedProfile(profile)
    }
  }
)

async function launchSideKick(profile) {
  const executablePath = process.env.SIDEKICK_E2E_EXECUTABLE
  assert.ok(
    existsSync(executablePath || APP_ENTRY),
    'The Electron runtime is not built. Run `npm run build` before the runtime E2E test.'
  )

  return electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    args: [
      ...(executablePath ? [] : [ROOT]),
      '--disable-gpu',
      '--sidekick-packaged-smoke-test',
      '--sidekick-e2e'
    ],
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
  try {
    await locator.waitFor({ state: 'visible', timeout: 20_000 })
  } catch (cause) {
    throw new Error(`${label} should be visible`, { cause })
  }
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
      assert.equal(await page.getByRole('button', { name: 'Resume agent' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Take control' }).count(), 0)
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
      await page.getByRole('button', { name: 'New browser tab' }).click()
      await waitForVisible(page.getByRole('tab', { name: 'about:blank', exact: true }), 'new blank tab')
      assert.equal(await page.getByRole('tab', { name: 'Shared browser fixture' }).count(), 1)
      await page.getByRole('tab', { name: 'Shared browser fixture' }).click()
      await address.fill(`http://127.0.0.1:${server.address().port}/again`)
      await address.press('Enter')
      await page.waitForFunction((url) => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((item) => item.title === url)
        return tab?.getAttribute('aria-selected') === 'true' && !tab.disabled &&
          tab.textContent.includes('Shared browser fixture')
      }, `http://127.0.0.1:${server.address().port}/again`)
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

      // Actual preload/IPC export; replace only the native picker in this owned
      // profile. Independently identify the package bytes, not its version label.
      const diagnosticPath = join(profile, 'synthetic-diagnostics.json')
      await application.evaluate(({ dialog }, filePath) => {
        globalThis.sidekickTestOriginalSaveDialog = dialog.showSaveDialog
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, diagnosticPath)
      try {
        const result = await page.evaluate(() => window.api.support.export())
        assert.equal(result.success, true)
        const report = JSON.parse(readFileSync(diagnosticPath, 'utf8'))
        const appRoot = await application.evaluate(({ app }) => app.getAppPath())
        const code = process.env.SIDEKICK_E2E_EXECUTABLE
          ? require('@electron/asar').extractFile(appRoot, join('out', 'main', 'index.js'))
          : readFileSync(join(appRoot, 'out', 'main', 'index.js'))
        assert.deepEqual(report.application.artifact, {
          scope: 'main-bundle-on-disk', algorithm: 'sha256',
          sha256: require('node:crypto').createHash('sha256').update(code).digest('hex')
        })
        assert.equal(JSON.stringify(report).includes(profile), false)
      } finally {
        await application.evaluate(({ dialog }) => {
          dialog.showSaveDialog = globalThis.sidekickTestOriginalSaveDialog
          delete globalThis.sidekickTestOriginalSaveDialog
        })
      }

      await page.getByRole('button', { name: /^Agent/ }).click()
      const completionHooks = page.locator('section.settings-card').filter({
        has: page.getByRole('heading', { name: 'Project completion hooks', exact: true })
      })
      await completionHooks
        .getByRole('textbox', { name: 'completion hook project folder' })
        .fill(profile)
      await completionHooks
        .getByRole('textbox', { name: 'completion hook command' })
        .fill('echo fixture-only')
      await completionHooks.getByRole('button', { name: 'Add disabled hook' }).click()
      assert.equal(await completionHooks.getByRole('checkbox').isChecked(), false)
      await completionHooks.getByRole('button', { name: 'Remove hook' }).click()
      assert.equal(await completionHooks.getByRole('checkbox').count(), 0)

      const worktreeHooks = page.locator('section.settings-card').filter({
        has: page.getByRole('heading', { name: 'Project worktree hooks', exact: true })
      })
      await worktreeHooks
        .getByRole('textbox', { name: 'worktree hook project folder' })
        .fill(profile)
      await worktreeHooks
        .getByRole('textbox', { name: 'worktree hook command' })
        .fill('echo fixture-only')
      await worktreeHooks.getByRole('button', { name: 'Add disabled hook' }).click()
      assert.equal(await worktreeHooks.getByRole('checkbox').isChecked(), false)
      await worktreeHooks.getByRole('button', { name: 'Remove hook' }).click()
      assert.equal(await worktreeHooks.getByRole('checkbox').count(), 0)

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
