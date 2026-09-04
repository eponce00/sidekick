import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { NativeBrowserSessionService } from '../src/main/services/nativeBrowserSessionService'

const RESULT_PREFIX = 'SIDEKICK_NATIVE_BROWSER_SMOKE='
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The production app keeps its main window alive while browser surfaces come and go.
// This smoke has no visible app window, so keep Electron alive across session lifecycle checks.
app.on('window-all-closed', () => undefined)

interface SmokeResult {
  sessionId: string
  semanticNodeCount: number
  screenshotBytes: number
  viewportPixelsMatch: boolean
  formFieldsVerified: number
  fullPageBytes: number
  elementBytes: number
  screenshotChanged: boolean
  consoleEntries: number
  networkFailures: number
  popupTabs: number
  blockedPopupTabs: number
  partitionIsolated: boolean
  localFileAllowed: boolean
  closeSessions: number
}

function progress(step: string): void {
  process.stdout.write(`[native-browser-smoke] ${step}\n`)
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Native Browser Smoke</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; background: #10151f; color: #f5f7fb; }
      main { box-sizing: border-box; min-height: 100vh; padding: 48px; }
      #scene { width: 560px; min-height: 240px; padding: 32px; border-radius: 24px; background: #273a63; }
      body.changed #scene { background: #7a3150; transform: translateX(48px); }
      button, input, select { display: block; box-sizing: border-box; margin-top: 16px; padding: 12px 16px; font: inherit; }
      input[type="checkbox"], input[type="radio"] { display: inline-block; margin-right: 8px; }
      fieldset { margin-top: 16px; }
      #typed { min-height: 28px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <main>
      <section id="scene" aria-label="Test scene">
        <h1 id="status">Initial scene</h1>
        <button id="change" type="button">Change scene</button>
        <label for="name">Name</label>
        <input id="name" name="name" autocomplete="off">
        <p id="typed" aria-live="polite">Nothing typed</p>
        <form id="profile-form">
          <label for="account-token">Account token</label>
          <input id="account-token" name="account-token" type="password" autocomplete="off">
          <label for="preferred-language">Preferred language</label>
          <select id="preferred-language" name="preferred-language">
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
          <label><input id="product-updates" type="checkbox">Receive product updates</label>
          <fieldset>
            <legend>Plan</legend>
            <label><input id="plan-basic" type="radio" name="plan" value="basic" checked>Basic</label>
            <label><input id="plan-pro" type="radio" name="plan" value="pro">Professional</label>
          </fieldset>
        </form>
        <button id="popup" type="button">Open popup</button>
        <button id="blocked" type="button">Open blocked popup</button>
      </section>
      <img src="/drop" alt="">
    </main>
    <script>
      console.info('sidekick-native-browser-smoke-ready');
      document.querySelector('#change').addEventListener('click', () => {
        document.body.classList.add('changed');
        document.querySelector('#status').textContent = 'Scene changed';
        console.info('sidekick-native-browser-scene-changed');
      });
      document.querySelector('#name').addEventListener('input', (event) => {
        document.querySelector('#typed').textContent = 'Typed: ' + event.target.value;
      });
      document.querySelector('#popup').addEventListener('click', () => {
        window.open('/popup', '_blank');
      });
      document.querySelector('#blocked').addEventListener('click', () => {
        window.open('http://example.com/blocked', '_blank');
      });
    </script>
  </body>
</html>`
}

function popupHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Smoke Popup</title></head><body><main><h1>Popup ready</h1></main><script>console.info('sidekick-native-browser-popup-ready')</script></body></html>`
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Loopback smoke server did not bind')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  const startedAt = Date.now()
  let latest = await read()
  while (!predicate(latest)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    latest = await read()
  }
  return latest
}

function assertPathWithin(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate))
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function readPngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path)
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE)
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function runSmoke(): Promise<SmokeResult> {
  const isolatedRoot = process.env.SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT
    ? resolve(process.env.SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT)
    : mkdtempSync(join(tmpdir(), 'sidekick-native-browser-smoke-'))
  const artifactRoot = join(isolatedRoot, 'artifacts')
  const allowedRoot = join(isolatedRoot, 'allowed-project')
  const insideFile = join(allowedRoot, 'index.html')
  const outsideFile = join(isolatedRoot, 'outside.html')
  let server: Server | undefined
  let service: NativeBrowserSessionService | undefined

  try {
    mkdirSync(isolatedRoot, { recursive: true })
    mkdirSync(allowedRoot, { recursive: true })
    writeFileSync(
      insideFile,
      '<!doctype html><title>Allowed Project File</title><h1>Allowed</h1>',
      'utf8'
    )
    writeFileSync(outsideFile, '<!doctype html><title>Outside</title>', 'utf8')
    writeFileSync(join(isolatedRoot, 'profile-marker'), 'isolated', 'utf8')
    app.setPath('userData', join(isolatedRoot, 'electron-profile'))
    await app.whenReady()
    progress('Electron ready')

    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/drop') {
        request.socket.destroy()
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(requestUrl.pathname === '/popup' ? popupHtml() : pageHtml())
    })
    const port = await listen(server)
    const baseUrl = `http://127.0.0.1:${port}`
    progress(`Loopback fixture ready on ${port}`)

    service = new NativeBrowserSessionService({
      artifactRoot,
      maxTotalSessions: 4,
      maxSessionsPerRun: 2
    })

    progress('Checking non-loopback HTTP rejection')
    await assert.rejects(
      service.open({ runId: 'blocked-http', url: 'http://example.com/not-loopback' }),
      /Plain HTTP is allowed only for loopback/
    )
    progress('Checking active-content URL rejection')
    await assert.rejects(
      service.open({ runId: 'blocked-scheme', url: 'javascript:document.body.remove()' }),
      /Only HTTPS, loopback HTTP, and approved local file URLs/
    )
    await assert.rejects(
      service.open({ runId: 'blocked-credentials', url: 'https://user:secret@example.com/' }),
      /cannot contain credentials/
    )
    progress('Checking file-root rejection')
    await assert.rejects(
      service.open({
        runId: 'blocked-file',
        url: pathToFileURL(outsideFile).href,
        allowedFileRoots: [allowedRoot]
      }),
      /approved project root/
    )
    const localFile = await service.open({
      runId: 'allowed-file',
      url: pathToFileURL(insideFile).href,
      allowedFileRoots: [allowedRoot]
    })
    assert.equal(localFile.tab.title, 'Allowed Project File')
    await service.close({ sessionId: localFile.sessionId })
    progress('Navigation policy checks passed')

    const opened = await service.open({
      runId: 'native-browser-smoke',
      url: baseUrl,
      viewport: { width: 1024, height: 720, deviceScaleFactor: 1 }
    })
    assert.equal(opened.tab.title, 'Native Browser Smoke')
    assert.equal(opened.tab.url, `${baseUrl}/`)
    assert.ok((opened.semanticNodeCount ?? 0) > 0, 'Semantic tree should not be empty')
    assert.match(opened.semanticSnapshot ?? '', /button "Change scene" \[ref=ax-/)
    assert.match(opened.semanticSnapshot ?? '', /textbox "Name" \[ref=ax-/)
    assert.ok(opened.screenshot, 'Opening a browser session should capture a screenshot')
    assert.ok(opened.screenshot.bytes > PNG_SIGNATURE.length, 'Screenshot should contain PNG data')
    assert.equal(opened.screenshot.url.startsWith('sidekick-browser://artifact/'), true)
    assert.equal(existsSync(opened.screenshot.path), true)
    assertPathWithin(artifactRoot, opened.screenshot.path)
    const viewportPixels = readPngDimensions(opened.screenshot.path)
    assert.deepEqual(viewportPixels, {
      width: opened.viewport.width,
      height: opened.viewport.height
    })
    assert.equal(opened.screenshot.width, opened.viewport.width)
    assert.equal(opened.screenshot.height, opened.viewport.height)
    progress('Open, semantic observation, and viewport-sized screenshot passed')

    const initialHash = opened.screenshot.sha256
    const clicked = await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Change scene', exact: true }
    })
    assert.equal(clicked.targetMode, 'semantic')
    assert.equal(clicked.coordinateFallbackUsed, false)
    assert.equal(clicked.observation.screenshotChanged, true)
    assert.notEqual(clicked.observation.screenshot?.sha256, initialHash)
    assert.match(clicked.observation.semanticSnapshot ?? '', /heading "Scene changed"/)
    const clickedBounds = await service.evaluate({
      sessionId: opened.sessionId,
      expression: `(() => { const r = document.querySelector('#change').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`
    })
    const bounds = clickedBounds.value as {
      left: number
      right: number
      top: number
      bottom: number
    }
    assert.ok(clicked.observation.pointer, 'Semantic click should expose its resolved pointer')
    assert.ok(clicked.observation.pointer.x >= bounds.left)
    assert.ok(clicked.observation.pointer.x <= bounds.right)
    assert.ok(clicked.observation.pointer.y >= bounds.top)
    assert.ok(clicked.observation.pointer.y <= bounds.bottom)
    progress('Semantic click and visual change passed')

    const typed = await service.type({
      sessionId: opened.sessionId,
      target: { role: 'textbox', name: 'Name', exact: true },
      text: 'Ada Lovelace',
      clear: true
    })
    assert.equal(typed.targetMode, 'semantic')
    const typedValue = await service.evaluate({
      sessionId: opened.sessionId,
      expression: `document.querySelector('#name').value`
    })
    assert.equal(typedValue.value, 'Ada Lovelace')
    assert.match(typed.observation.semanticSnapshot ?? '', /Typed: Ada Lovelace/)
    progress('Semantic type passed')

    const sensitiveFormValue = 'native-browser-smoke-sensitive-9472'
    const filledForm = await service.fillForm({
      sessionId: opened.sessionId,
      fields: [
        {
          kind: 'textbox',
          target: { role: 'textbox', name: 'Account token', exact: true },
          value: sensitiveFormValue
        },
        {
          kind: 'select',
          target: { role: 'combobox', name: 'Preferred language', exact: true },
          values: ['es']
        },
        {
          kind: 'checkbox',
          target: { role: 'checkbox', name: 'Receive product updates', exact: true },
          checked: true
        },
        {
          kind: 'radio',
          target: { role: 'radio', name: 'Professional', exact: true },
          checked: true
        }
      ]
    })
    const safeFormDiagnostics = JSON.stringify({
      stopReason: filledForm.stopReason,
      fields: filledForm.fields.map((field) => ({
        index: field.index,
        kind: field.kind,
        status: field.status,
        error: field.error,
        verification: field.verification
      }))
    })
    assert.equal(filledForm.completed, true, safeFormDiagnostics)
    assert.equal(filledForm.stopReason, 'completed')
    assert.equal(filledForm.attemptedFields, 4)
    assert.equal(filledForm.filledFields, 4)
    assert.equal(
      filledForm.fields.every(
        (field) => field.status === 'filled' && field.verification?.passed === true
      ),
      true
    )
    assert.equal(filledForm.observation.screenshot, undefined)
    assert.equal(JSON.stringify(filledForm).includes(sensitiveFormValue), false)
    const verifiedFormState = await service.evaluate({
      sessionId: opened.sessionId,
      expression: `(() => ({
        textboxMatches: document.querySelector('#account-token').value === ${JSON.stringify(sensitiveFormValue)},
        selectMatches: document.querySelector('#preferred-language').value === 'es',
        checkboxMatches: document.querySelector('#product-updates').checked === true,
        radioMatches: document.querySelector('#plan-pro').checked === true,
        otherRadioCleared: document.querySelector('#plan-basic').checked === false
      }))()`
    })
    assert.deepEqual(verifiedFormState.value, {
      textboxMatches: true,
      selectMatches: true,
      checkboxMatches: true,
      radioMatches: true,
      otherRadioCleared: true
    })
    progress('Verified batched native form fill without exposing the sensitive value')

    await service.evaluate({
      sessionId: opened.sessionId,
      expression: `(() => { localStorage.setItem('sidekick-smoke', 'private'); document.cookie = 'sidekickSmoke=private'; return true })()`
    })
    const isolatedSession = await service.open({
      runId: 'partition-isolation',
      url: baseUrl,
      viewport: { width: 640, height: 480, deviceScaleFactor: 1 }
    })
    const isolatedStorage = await service.evaluate({
      sessionId: isolatedSession.sessionId,
      expression: `({ local: localStorage.getItem('sidekick-smoke'), cookie: document.cookie })`
    })
    assert.deepEqual(isolatedStorage.value, { local: null, cookie: '' })
    await service.close({ sessionId: isolatedSession.sessionId })
    progress('Ephemeral session partition isolation passed')

    const fullPage = await service.screenshot({
      sessionId: opened.sessionId,
      kind: 'fullPage'
    })
    const element = await service.screenshot({
      sessionId: opened.sessionId,
      kind: 'element',
      target: { role: 'button', name: 'Change scene', exact: true }
    })
    for (const screenshot of [fullPage, element]) {
      assert.ok(screenshot.bytes > PNG_SIGNATURE.length)
      assert.deepEqual(readFileSync(screenshot.path).subarray(0, 8), PNG_SIGNATURE)
      assertPathWithin(artifactRoot, screenshot.path)
    }
    assert.equal(fullPage.kind, 'fullPage')
    assert.equal(element.kind, 'element')
    assert.ok(element.width < opened.viewport.width)
    assert.ok(element.height < opened.viewport.height)
    progress('CDP full-page and element screenshots passed')

    const consoleResult = await service.console({ sessionId: opened.sessionId, afterSequence: 0 })
    assert.equal(
      consoleResult.entries.some((entry) =>
        entry.message.includes('sidekick-native-browser-smoke-ready')
      ),
      true,
      'Page console output should be captured'
    )
    const networkResult = await waitFor(
      () => service!.network({ sessionId: opened.sessionId, afterSequence: 0 }),
      (result) => result.failures.some((failure) => failure.url.includes('/drop')),
      'failed request telemetry'
    )
    progress('Console and network telemetry passed')

    await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Open popup', exact: true }
    })
    const popupTabs = await waitFor(
      () => service!.tabs({ sessionId: opened.sessionId, action: 'list' }),
      (result) => result.tabs.length === 2,
      'allowed popup tab'
    )
    progress('Allowed popup became a managed tab')
    const popup = popupTabs.tabs.find((tab) => tab.id !== opened.tab.id)
    assert.ok(popup, 'Allowed popup should become a managed tab')
    assert.equal(popup.url, `${baseUrl}/popup`)
    const selected = await service.tabs({
      sessionId: opened.sessionId,
      action: 'select',
      tabId: popup.id
    })
    assert.equal(selected.activeTabId, popup.id)
    assert.equal(selected.observation?.tab.title, 'Smoke Popup')
    const closedPopup = await service.tabs({
      sessionId: opened.sessionId,
      action: 'close',
      tabId: popup.id
    })
    assert.equal(closedPopup.tabs.length, 1)
    const explicitTab = await service.tabs({
      sessionId: opened.sessionId,
      action: 'new',
      url: `${baseUrl}/popup`
    })
    assert.equal(explicitTab.tabs.length, 2)
    const explicitTabId = explicitTab.activeTabId
    const explicitlyClosed = await service.tabs({
      sessionId: opened.sessionId,
      action: 'close',
      tabId: explicitTabId
    })
    assert.equal(explicitlyClosed.tabs.length, 1)
    progress('Popup and explicit tab create/select/close passed')

    await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Open blocked popup', exact: true }
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    const blockedPopupTabs = await service.tabs({
      sessionId: opened.sessionId,
      action: 'list'
    })
    assert.equal(blockedPopupTabs.tabs.length, 1, 'Disallowed popup URL should remain blocked')
    progress('Disallowed popup stayed blocked')

    const takeover = await service.beginHumanTakeover(opened.sessionId)
    assert.equal(takeover.active, true, 'Human takeover should reveal the existing browser surface')
    assert.equal(takeover.observation.tab.url, opened.tab.url)
    await service.click({
      sessionId: opened.sessionId,
      target: { role: 'button', name: 'Open popup', exact: true }
    })
    const takeoverPopup = await waitFor(
      () => service!.tabs({ sessionId: opened.sessionId, action: 'list' }),
      (result) => result.tabs.length === 1 && result.tabs[0]?.url === `${baseUrl}/popup`,
      'takeover popup in the visible tab'
    )
    assert.equal(takeoverPopup.tabs[0]?.id, opened.tab.id)
    const takeoverComplete = await service.completeHumanTakeover(opened.sessionId)
    assert.equal(takeoverComplete.active, false)
    assert.equal(takeoverComplete.observation.tab.url, `${baseUrl}/popup`)
    assert.ok(takeoverComplete.observation.screenshot)
    progress('Same-session human takeover reveal and recapture passed')

    const closeResult = await service.close({ sessionId: opened.sessionId })
    assert.deepEqual(closeResult.closedSessions, [opened.sessionId])
    await assert.rejects(
      service.observe(opened.sessionId, { screenshot: 'none' }),
      /not found or already closed/
    )
    progress('Clean close passed')

    return {
      sessionId: opened.sessionId,
      semanticNodeCount: opened.semanticNodeCount ?? 0,
      screenshotBytes: opened.screenshot.bytes,
      viewportPixelsMatch: true,
      formFieldsVerified: filledForm.fields.filter((field) => field.verification?.passed).length,
      fullPageBytes: fullPage.bytes,
      elementBytes: element.bytes,
      screenshotChanged: clicked.observation.screenshotChanged === true,
      consoleEntries: consoleResult.entries.length,
      networkFailures: networkResult.failures.length,
      popupTabs: popupTabs.tabs.length,
      blockedPopupTabs: blockedPopupTabs.tabs.length,
      humanTakeover: true,
      partitionIsolated: true,
      localFileAllowed: true,
      closeSessions: closeResult.closedSessions.length
    }
  } finally {
    await service?.dispose().catch(() => undefined)
    if (server) await closeServer(server).catch(() => undefined)
  }
}

runSmoke()
  .then((result) => {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
    app.quit()
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    app.exit(1)
  })
