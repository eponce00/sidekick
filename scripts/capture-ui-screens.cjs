#!/usr/bin/env node
// Captures deterministic screenshots of the renderer preview (mock data, no Electron) for design
// review. Each state is reached by clicks and keys a user would make, in a fresh browser context.
//
//   node scripts/capture-ui-screens.cjs --out <dir> [--width 1440 --height 900]
//     [--themes dark,light] [--only welcome,chat-populated] [--port 5180] [--root <checkout>]
//   node scripts/capture-ui-screens.cjs --list
//
// Writes <state>-<theme>-<width>.png and manifest.json (file, state, theme, viewport, description).
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const { pathToFileURL } = require('url')

// Fixed clock so relative times ("3m ago", "Worked for 1m 0s") match between rounds.
const FIXED_TIME = new Date('2026-10-27T17:00:00Z')

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, '..'),
    width: 1440,
    height: 900,
    themes: ['dark', 'light'],
    only: null,
    port: 5180
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === '--out') args.out = path.resolve(value())
    else if (flag === '--root') args.root = path.resolve(value())
    else if (flag === '--width') args.width = Number(value())
    else if (flag === '--height') args.height = Number(value())
    else if (flag === '--themes') args.themes = value().split(',').filter(Boolean)
    else if (flag === '--only') args.only = value().split(',').filter(Boolean)
    else if (flag === '--port') args.port = Number(value())
    else if (flag === '--list') args.list = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) {
    throw new Error('--width and --height must be whole numbers')
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error('--port must be between 1 and 65535')
  }
  for (const theme of args.themes) {
    if (theme !== 'dark' && theme !== 'light') throw new Error(`Unknown theme: ${theme}`)
  }
  return args
}

// ---- Steps shared by states --------------------------------------------------------------------

async function openConversation(page, title) {
  const row = page.getByRole('button', { name: title, exact: true }).first()
  if (await row.isVisible()) {
    await row.click()
  } else {
    // A narrow window folds the sidebar to its rail, which has no tree: open the chat from the
    // command palette, as a user would. Expanding the sidebar instead would hold it open.
    await page.keyboard.press('Control+KeyK')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill(title)
    await palette.getByRole('option', { name: title }).first().click()
  }
  await page.locator('.messages-container').waitFor()
  await page.getByRole('textbox', { name: 'Type a message...' }).waitFor()
}

async function openPopulatedChat(page) {
  await openConversation(page, 'Refine the desktop experience')
  await page.getByRole('button', { name: '7 tools · 2 thoughts' }).waitFor()
}

/** Scrolls the conversation with the mouse wheel, as a user would. */
async function wheelMessages(page, deltaY) {
  const box = await page.locator('.messages-container').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(200, box.height / 2))
  await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(400)
}

/** Wheels until `locator`'s top edge sits `margin` px below the top of the conversation. */
async function wheelToTop(page, locator, margin = 12) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const target = await locator.boundingBox()
    const container = await page.locator('.messages-container').boundingBox()
    const delta = Math.round(target.y - container.y - margin)
    if (Math.abs(delta) < 4) return
    await wheelMessages(page, delta)
  }
}

function workspacePanel(page) {
  return page
    .getByRole('complementary')
    .filter({ has: page.getByRole('tablist', { name: 'Panel tabs' }) })
}

async function openPanelTab(page, kind) {
  await workspacePanel(page).getByRole('button', { name: 'New tab', exact: true }).click()
  await workspacePanel(page).getByRole('button', { name: kind, exact: true }).click()
  await workspacePanel(page).getByRole('tab', { name: kind }).waitFor()
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog', { name: 'Settings' }).waitFor()
}

async function openSettingsPage(page, name) {
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  await dialog.getByRole('heading', { level: 2, name, exact: true }).waitFor()
}

// ---- States ------------------------------------------------------------------------------------

const STATES = [
  {
    name: 'welcome',
    description:
      'Empty new chat on first launch: "What\'s next?" welcome with resume suggestions, project picker, composer, sidebar with projects/chats, and the Files panel with no project folder.',
    run: async (page) => {
      await page.getByRole('heading', { name: 'What’s next?' }).waitFor()
    }
  },
  {
    name: 'dictation-downloading',
    query: 'dictation=downloading',
    description:
      'The welcome composer while the dictation model downloads: the mic inside the 16px download meter, its accent arc at about 41%, beside the context ring.',
    run: async (page) => {
      await page.getByRole('heading', { name: 'What’s next?' }).waitFor()
    }
  },
  {
    name: 'chat-populated',
    extraWidths: [900],
    description:
      'The populated "Refine the desktop experience" conversation scrolled to the top: user message, thought and steer rows, an answered question, a pending two-question card from the agent, and the collapsed "7 tools · 2 thoughts" work row.',
    run: async (page) => {
      await openPopulatedChat(page)
      await wheelMessages(page, -5000)
    }
  },
  {
    name: 'chat-reply',
    description:
      'The same conversation scrolled to the end: the collapsed work row, the "Edited 1 file" change card, the agent\'s formatted markdown reply with file chips and links, source chips, and the pull-request status bar (number, Blocked, checks running) under the composer.',
    run: async (page) => {
      await openPopulatedChat(page)
      await wheelMessages(page, 5000)
    }
  },
  {
    name: 'chat-tools',
    description:
      'The work block expanded: seven tool rows (web search, web fetch, shell commands including a failed one with a red mark, a background dev server with live output, a patch) interleaved with thinking rows, followed by the file-change card.',
    run: async (page) => {
      await openPopulatedChat(page)
      const work = page.getByRole('button', { name: '7 tools · 2 thoughts' })
      await work.click()
      await page.getByRole('button', { name: 'Upload the program. Failed' }).waitFor()
      await wheelToTop(page, work)
    }
  },
  {
    name: 'chat-tool-output',
    description:
      'Inside the expanded work block, the failed "Upload the program" shell command opened to show its command, exit code, stdout/stderr and error detail.',
    run: async (page) => {
      await openPopulatedChat(page)
      await page.getByRole('button', { name: '7 tools · 2 thoughts' }).click()
      const failed = page.getByRole('button', { name: 'Upload the program. Failed' })
      await failed.click()
      await page.waitForTimeout(300)
      await wheelToTop(page, failed, 60)
    }
  },
  {
    name: 'chat-manager',
    description:
      'The "Cline desktop design review" manager chat that started five worker chats in their own worktrees: the end of a manager message, a "Received 2 messages" row, the task list with a worker chip per step (Done, Working, Idle, Needs you, Failed), and the workers summary bar with Stop all above the composer.',
    run: async (page) => {
      await openConversation(
        page,
        'Cline desktop design review 1 needs you · 1 failed · 2 working · 1 done'
      )
      await wheelMessages(page, 5000)
    }
  },
  {
    name: 'composer-plus-menu',
    description:
      'The composer "+" menu open over the populated chat: Add (files, image), Project context (folder, shared notes, instruction files), and Agent behavior (ongoing goal, plan first, research report).',
    run: async (page) => {
      await openPopulatedChat(page)
      await page
        .getByRole('button', { name: 'Add an attachment, project context, or agent behavior' })
        .click()
      await page.getByRole('menu', { name: 'Add to message' }).waitFor()
    },
    keepPointer: true
  },
  {
    name: 'model-picker',
    description:
      'The composer model picker open: pinned models with provider names, the current model checked, and "Manage models".',
    run: async (page) => {
      await openPopulatedChat(page)
      await page.getByRole('button', { name: /^Claude Sonnet 4 · / }).click()
      await page.getByRole('listbox', { name: 'Pinned models' }).waitFor()
    },
    keepPointer: true
  },
  {
    name: 'side-panel-files',
    description:
      'The right workspace panel on its Files tab for the sidekick-demo project, with the src folder expanded in the tree, beside the populated chat.',
    run: async (page) => {
      await openPopulatedChat(page)
      const panel = workspacePanel(page)
      await panel.getByRole('tab', { name: 'Files' }).waitFor()
      await panel.getByRole('button', { name: 'src', exact: true }).click()
      await page.waitForTimeout(400)
    }
  },
  {
    name: 'side-panel-file-viewer',
    description:
      'The Files tab after opening README.md from the tree: the file viewer with a back-to-tree header and rendered markdown (headings, lists, inline code, a callout, a table and a code block).',
    run: async (page) => {
      await openPopulatedChat(page)
      await workspacePanel(page).getByRole('button', { name: 'README.md', exact: true }).click()
      await workspacePanel(page).getByRole('button', { name: 'Back to file tree' }).waitFor()
    }
  },
  {
    name: 'side-panel-terminal',
    description:
      "The workspace panel on a Terminal tab: the agent's command waiting for input, and the terminal list (agent terminals with status and duration).",
    run: async (page) => {
      await openPopulatedChat(page)
      await openPanelTab(page, 'Terminal')
      await page.getByText('Ok to proceed?').waitFor()
    }
  },
  {
    name: 'side-panel-browser',
    description:
      'The workspace panel, now narrower, on a Browser tab in its empty state (the preview cannot load pages): browser tab strip, disabled navigation buttons, address bar, and the hint text; the chat column widens beside it.',
    run: async (page) => {
      await openPopulatedChat(page)
      await openPanelTab(page, 'Browser')
      await page.getByRole('combobox', { name: 'Browser address' }).waitFor()
    }
  },
  {
    name: 'settings-general',
    description:
      'Full-window Settings on General: section navigation on the left, then Notifications, Background and Voice sections with toggles, and the Cancel / Save changes footer.',
    run: async (page) => {
      await openSettings(page)
      await page.getByRole('heading', { level: 2, name: 'General', exact: true }).waitFor()
    }
  },
  {
    name: 'settings-providers',
    description:
      'Full-window Settings on Providers: the provider list (Ollama, OpenRouter) and the Ollama detail pane with enable toggle, base URL, refresh, the searchable and filterable model list, add-model field and utility model picker.',
    run: async (page) => {
      await openSettingsPage(page, 'Providers')
    }
  },
  {
    name: 'settings-appearance',
    description:
      'Full-window Settings on Appearance: accent color swatches (Blue selected) and the text size stepper with a sample message.',
    run: async (page) => {
      await openSettingsPage(page, 'Appearance')
    }
  },
  {
    name: 'command-palette',
    description:
      'The command palette (Ctrl+K) open over the dimmed populated chat: search field, the Actions list with the first item highlighted and keyboard shortcuts on the right, and a key-hint footer.',
    run: async (page) => {
      await openPopulatedChat(page)
      await page.keyboard.press('Control+KeyK')
      await page.getByRole('dialog').waitFor()
    }
  },
  {
    name: 'sidebar-collapsed',
    description:
      'The populated chat with the left sidebar collapsed to an icon rail (sidebar toggle, projects and chats with counts, schedules, phone, more); the conversation column widens and the Files panel stays open.',
    run: async (page) => {
      await openPopulatedChat(page)
      await page.getByRole('button', { name: 'Collapse sidebar' }).click()
      await page.getByRole('button', { name: 'Expand sidebar' }).waitFor()
    }
  }
]

// ---- Vite and browser --------------------------------------------------------------------------

function fromRoot(root) {
  const load = createRequire(path.join(root, 'package.json'))
  return {
    load,
    importModule: (name) => import(pathToFileURL(load.resolve(name)).href)
  }
}

async function startVite(root, port) {
  const { importModule } = fromRoot(root)
  const { createServer } = await importModule('vite')
  const react = (await importModule('@vitejs/plugin-react')).default
  // Vite expects forward slashes; a backslash root breaks /@fs/ URLs such as the title-bar icon.
  const posix = (...parts) =>
    path
      .join(...parts)
      .split(path.sep)
      .join('/')
  const server = await createServer({
    configFile: false,
    root: posix(root, 'src/renderer'),
    resolve: { alias: { '@renderer': posix(root, 'src/renderer/src') } },
    plugins: [react()],
    // Its own dependency cache, so it never invalidates the shared node_modules/.vite.
    cacheDir: path.join(os.tmpdir(), 'sidekick-ui-capture', 'vite-cache'),
    logLevel: 'error',
    clearScreen: false,
    // The page's CSP refuses the HMR socket anyway; a capture run never needs it.
    server: { port, strictPort: false, host: 'localhost', hmr: false, ws: false }
  })
  // Registered before listen() so a failed start still closes the watcher and optimizer.
  cleanup.push(() => server.close())
  await server.listen()
  const address = server.httpServer.address()
  return { server, origin: `http://localhost:${address.port}` }
}

async function launchBrowser(chromium) {
  if (process.platform === 'win32') {
    try {
      return { browser: await chromium.launch({ channel: 'msedge' }), name: 'Microsoft Edge' }
    } catch (error) {
      console.warn(`Edge unavailable (${error.message.split('\n')[0]}); using bundled Chromium.`)
    }
  }
  return { browser: await chromium.launch(), name: 'Playwright Chromium' }
}

async function newPage(browser, origin, { theme, width, height, query }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'UTC'
  })
  await context.clock.setFixedTime(FIXED_TIME)
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('theme', value)
    } catch {
      // Storage is optional; the theme query parameter still applies.
    }
    // The preview's terminal mock appends a fake "hmr update" line every few seconds, so the dev
    // server's live output would depend on how long a state took to reach. Skip that one timer.
    const setIntervalNative = window.setInterval
    window.setInterval = function (handler, ...rest) {
      if (typeof handler === 'function' && String(handler).includes('hmr update')) return 0
      return setIntervalNative.call(window, handler, ...rest)
    }
  }, theme)
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) console.warn(`    ${response.status()} ${response.url()}`)
  })
  await page.goto(`${origin}/?ui-preview=1&theme=${theme}${query ? `&${query}` : ''}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000
  })
  // The composer, not the sidebar's search: a 900px window starts with the sidebar on its rail.
  await page.getByRole('textbox', { name: 'Type a message...' }).waitFor({ timeout: 60_000 })
  await page.locator('.app-loading').waitFor({ state: 'detached' })
  await settle(page)
  return { context, page, problems }
}

/** Waits for web fonts, layout, and any finite animation still running. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect?.getComputedTiming().iterations === Infinity
          ),
      null,
      { timeout: 5_000 }
    )
    .catch(() => undefined)
  await page.waitForTimeout(250)
}

// ---- Main --------------------------------------------------------------------------------------

const cleanup = []
let cleaning = null
function shutDown() {
  if (!cleaning) {
    cleaning = (async () => {
      for (const step of cleanup.reverse()) {
        try {
          await step()
        } catch {
          // Best effort: keep closing the rest.
        }
      }
    })()
  }
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutDown().finally(() => process.exit(130))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.list || args.help) {
    console.log(
      'Usage: node scripts/capture-ui-screens.cjs --out <dir> [--width 1440 --height 900] ' +
        '[--themes dark,light] [--only a,b] [--port 5180] [--root <checkout>]\n\nStates:'
    )
    for (const state of STATES) console.log(`  ${state.name}`)
    return 0
  }
  if (!args.out) throw new Error('--out <dir> is required')
  const unknown = (args.only ?? []).filter((name) => !STATES.some((state) => state.name === name))
  if (unknown.length) throw new Error(`Unknown state: ${unknown.join(', ')}`)
  if (!fs.existsSync(path.join(args.root, 'src/renderer/index.html'))) {
    throw new Error(`${args.root} is not a SideKick checkout (use --root)`)
  }
  const states = args.only ? STATES.filter((state) => args.only.includes(state.name)) : STATES
  fs.mkdirSync(args.out, { recursive: true })

  const started = Date.now()
  const { chromium } = fromRoot(args.root).load('playwright')
  // Vite resolves /@fs/ files outside src/renderer (the title-bar icon) against the working
  // directory; started elsewhere it serves index.html in their place.
  process.chdir(args.root)
  const { origin } = await startVite(args.root, args.port)
  console.log(`Renderer preview at ${origin}`)

  const { browser, name: browserName } = await launchBrowser(chromium)
  cleanup.push(() => browser.close())
  console.log(`Browser: ${browserName} ${browser.version()}`)

  // Warm-up: the first load makes Vite optimize dependencies; later loads then see a stable set.
  {
    const warm = await newPage(browser, origin, {
      theme: 'dark',
      width: args.width,
      height: args.height
    })
    await warm.context.close()
  }

  const files = []
  const failures = []
  for (const state of states) {
    const widths = [args.width, ...(state.extraWidths ?? []).filter((w) => w !== args.width)]
    for (const width of widths) {
      for (const theme of args.themes) {
        const file = `${state.name}-${theme}-${width}.png`
        const viewport = { width, height: args.height }
        let context
        try {
          const opened = await newPage(browser, origin, { theme, ...viewport, query: state.query })
          context = opened.context
          const { page, problems } = opened
          await state.run(page)
          // Park the pointer on empty title bar so no hover state leaks into the shot.
          if (!state.keepPointer) await page.mouse.move(Math.round(width / 2), 20)
          await settle(page)
          const shownTheme = await page.evaluate(() => document.body.dataset.theme)
          if (shownTheme !== theme) throw new Error(`page shows the ${shownTheme} theme`)
          if (problems.length) throw new Error(`page error: ${problems[0]}`)
          await page.screenshot({
            path: path.join(args.out, file),
            animations: 'disabled',
            caret: 'hide'
          })
          files.push({ file, state: state.name, theme, viewport, description: state.description })
          console.log(`  ok    ${file}`)
        } catch (error) {
          failures.push({ file, state: state.name, theme, error: error.message.split('\n')[0] })
          console.error(`  FAIL  ${file}: ${error.message.split('\n')[0]}`)
        } finally {
          await context?.close().catch(() => undefined)
        }
      }
    }
  }

  const manifest = {
    app: 'SideKick renderer preview (mock data, no Electron)',
    url: '/?ui-preview=1&theme=<theme>',
    browser: `${browserName} ${browser.version()}`,
    fixedTime: FIXED_TIME.toISOString(),
    note: 'Each state starts from a fresh load and is reached with real clicks and keys. Window chrome is the Windows layout (SideKick caption buttons). The Browser tab cannot load pages outside Electron.',
    files,
    failures
  }
  fs.writeFileSync(path.join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `${files.length} screenshot(s), ${failures.length} failure(s) in ${seconds}s -> ${args.out}`
  )
  return failures.length ? 1 : 0
}

main()
  .then(async (code) => {
    await shutDown()
    process.exit(code)
  })
  .catch(async (error) => {
    console.error(error.stack || error.message)
    await shutDown()
    process.exit(1)
  })
