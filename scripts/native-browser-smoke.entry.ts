import assert from 'node:assert/strict'
import { fillablePdfFixture } from './fixtures/fillablePdf'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, nativeImage, screen, BrowserWindow, webContents } from 'electron'
import {
  mountBrowserView,
  unmountBrowserHost,
  browserViewHost
} from '../src/main/services/browserViewHost'
import {
  installArtifactProtocol,
  registerArtifactScheme
} from '../src/main/bootstrap/artifactProtocol'
import { NativeBrowserSessionService } from '../src/main/services/nativeBrowserSessionService'

const RESULT_PREFIX = 'SIDEKICK_NATIVE_BROWSER_SMOKE='
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The production app keeps its main window alive while browser surfaces come and go.
// This smoke has no visible app window, so keep Electron alive across session lifecycle checks.
app.on('window-all-closed', () => undefined)
registerArtifactScheme()

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
        <label for="rejected-text">Rejected text</label>
        <input id="rejected-text" onbeforeinput="event.preventDefault()">
        <label>Upload fixture<input id="upload" type="file"></label>
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

/** A page that marks its right edge, to show whether the whole viewport is seen and reachable. */
function wideHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wide fixture</title>
<style>html,body{margin:0;height:100%;background:#1f7a3a}#edge{position:fixed;top:0;right:0;width:48px;height:100%;background:#ff0000}#reach{position:fixed;right:64px;top:50%;width:120px;height:48px}</style></head>
<body><div id="edge"></div><button id="reach" onclick="document.title='clicked-right'">Right edge</button></body></html>`
}

/** Whether a PNG has a mostly red pixel in the given column band, at mid-height. */
function hasRedAt(path: string, fromX: number, toX: number): boolean {
  const image = nativeImage.createFromPath(path)
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const y = Math.floor(height / 4)
  for (let x = Math.max(0, fromX); x < Math.min(width, toX); x++) {
    const offset = (y * width + x) * 4
    // toBitmap() is BGRA.
    const [b, g, r] = [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]]
    if (r > 200 && g < 60 && b < 60) return true
  }
  return false
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
  const fillablePdf = join(allowedRoot, 'fillable.pdf')
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
    writeFileSync(fillablePdf, fillablePdfFixture())
    writeFileSync(join(isolatedRoot, 'profile-marker'), 'isolated', 'utf8')
    app.setPath('userData', join(isolatedRoot, 'electron-profile'))
    await app.whenReady()
    await installArtifactProtocol()
    progress('Electron ready')

    server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/download') {
        response.setHeader('content-type', 'application/octet-stream')
        response.end('download-fixture')
        return
      }
      if (requestUrl.pathname === '/oversized-download') {
        response.setHeader('content-length', String(26 * 1024 * 1024))
        response.end(Buffer.alloc(26 * 1024 * 1024))
        return
      }
      if (requestUrl.pathname === '/unsafe-download') {
        response.writeHead(302, { location: 'http://example.com/file' })
        response.end()
        return
      }
      if (requestUrl.pathname === '/redirect-download') {
        response.writeHead(302, { location: '/download' })
        response.end()
        return
      }
      if (requestUrl.pathname === '/redirected.pdf') {
        response.writeHead(302, { location: '/fixture.pdf' })
        response.end()
        return
      }
      if (requestUrl.pathname === '/fixture.pdf') {
        response.setHeader('content-type', 'application/pdf')
        response.end(fillablePdfFixture())
        return
      }
      if (requestUrl.pathname === '/drop') {
        request.socket.destroy()
        return
      }
      response.statusCode = 200
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(
        requestUrl.pathname === '/popup'
          ? popupHtml()
          : requestUrl.pathname === '/wide'
            ? wideHtml()
            : pageHtml()
      )
    })
    const port = await listen(server)
    const baseUrl = `http://127.0.0.1:${port}`
    progress(`Loopback fixture ready on ${port}`)

    service = new NativeBrowserSessionService({
      artifactRoot,
      pdfOutputRoot: join(isolatedRoot, 'downloads'),
      maxTotalSessions: 4,
      maxSessionsPerRun: 2
    })

    progress('Checking non-loopback HTTP rejection')
    await assert.rejects(
      service.open({ runId: 'blocked-http', url: 'http://example.com/not-loopback' }),
      /Plain HTTP is allowed only for this computer/
    )
    progress('Checking active-content URL rejection')
    await assert.rejects(
      service.open({ runId: 'blocked-scheme', url: 'javascript:document.body.remove()' }),
      /Only HTTPS, plain HTTP on this computer/
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

    progress('Checking embedded shared browser')
    const shared = await service.open({ runId: 'shared-view', url: baseUrl })
    const host = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    host.showInactive()
    const contents = webContents.fromId(shared.tab.webContentsId)!
    const identity = contents.id
    let userInputs = 0
    mountBrowserView(identity, host, { x: 20, y: 80, width: 900, height: 600 }, () => {
      userInputs++
      return true
    })
    assert.equal(browserViewHost(identity), host)
    assert.equal(contents.id, identity, 'Embedding must preserve the original tab')
    const live = await service.observe(shared.sessionId, { screenshot: 'viewport' })
    assert.ok(live.screenshot && live.screenshot.bytes > 1000)
    const sharedType = await service.type({
      sessionId: shared.sessionId,
      target: { role: 'textbox', name: 'Name', exact: true },
      text: 'Shared browser test'
    })
    const sharedValue = await service.evaluate({
      sessionId: shared.sessionId,
      expression: "document.querySelector('#name').value"
    })
    if (sharedValue.value !== 'Shared browser test') {
      // Capture focus and action evidence only after a mismatch: no retry or
      // extra pre-assertion wait that could conceal an input-dispatch race.
      const focusState = await contents.executeJavaScript(`({
        documentFocused: document.hasFocus(),
        targetActive: document.activeElement === document.querySelector('#name')
      })`)
      assert.fail(
        `Embedded type did not persist exact text: ${JSON.stringify({
          hostFocused: host.isFocused(),
          contentsFocused: contents.isFocused(),
          ...focusState,
          observedLength: typeof sharedValue.value === 'string' ? sharedValue.value.length : null,
          action: sharedType.action,
          targetMode: sharedType.targetMode,
          durationMs: sharedType.durationMs,
          screenshotChanged: sharedType.observation.screenshotChanged
        })}`
      )
    }
    assert.equal(userInputs, 0, 'Agent-generated input must not claim user control')
    contents.sendInputEvent({ type: 'keyDown', keyCode: '!' })
    contents.sendInputEvent({ type: 'char', keyCode: '!' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: '!' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(userInputs > 0, 'Native user input should notify the shared control gate')
    const manualValue = await service.evaluate({
      sessionId: shared.sessionId,
      expression: "document.querySelector('#name').value"
    })
    assert.equal(
      manualValue.value,
      'Shared browser test!',
      'Agent must observe manual edits on the same page'
    )
    await assert.rejects(
      service.type({
        sessionId: shared.sessionId,
        target: { role: 'textbox', name: 'Rejected text', exact: true },
        text: 'vetoed-text'
      }),
      /Browser text entry could not be verified/
    )
    assert.equal(
      (
        await service.evaluate({
          sessionId: shared.sessionId,
          expression: "document.querySelector('#rejected-text').value"
        })
      ).value,
      ''
    )
    progress('Native beforeinput veto rejected without false-success or retry')

    const embeddedTakeover = await service.beginHumanTakeover(shared.sessionId)
    assert.equal(embeddedTakeover.active, true)
    assert.equal(browserViewHost(identity), host, 'Takeover must stay embedded')
    await service.completeHumanTakeover(shared.sessionId)
    unmountBrowserHost(host)
    assert.equal(browserViewHost(identity), undefined)
    const parked = await service.observe(shared.sessionId, { screenshot: 'viewport' })
    assert.ok(parked.screenshot)
    host.destroy()
    await service.close({ sessionId: shared.sessionId })
    progress(
      `Embedded browser, same-tab input, takeover, and background recapture passed (${userInputs} input events)`
    )

    {
      // The agent sets a desktop viewport while the page sits in a narrow panel at the app's zoom.
      // Its screenshots must show the whole viewport, its clicks must land, and the panel must
      // show the whole page scaled to fit, not its left part clipped.
      progress('Checking an agent viewport wider than the panel')
      const wide = await service.open({ runId: 'wide-view', url: `${baseUrl}/wide` })
      const narrowHost = new BrowserWindow({
        show: false,
        width: 900,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      narrowHost.showInactive()
      const panel = { x: 20, y: 80, width: 460, height: 600 }
      mountBrowserView(wide.tab.webContentsId, narrowHost, panel, () => true, 0.9)
      await service.resize({
        sessionId: wide.sessionId,
        viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }
      })
      const innerWidth = (
        await service.evaluate({ sessionId: wide.sessionId, expression: 'window.innerWidth' })
      ).value
      assert.equal(innerWidth, 1280, 'The page lays out at the viewport the agent asked for')
      const shot = await service.observe(wide.sessionId, { screenshot: 'viewport' })
      const size = nativeImage.createFromPath(shot.screenshot!.path).getSize()
      // A desktop width scaled to the panel's width grows tall enough to fill the panel's height.
      const filledHeight = Math.floor(panel.height / (panel.width / 1280))
      const innerHeight = (
        await service.evaluate({ sessionId: wide.sessionId, expression: 'window.innerHeight' })
      ).value
      assert.equal(innerHeight, filledHeight, 'A desktop size fills the panel height')
      assert.deepEqual(
        [size.width, size.height],
        [1280, filledHeight],
        'Screenshot is the whole viewport'
      )
      assert.ok(
        hasRedAt(shot.screenshot!.path, 1240, 1280),
        'The agent screenshot shows the right edge of its viewport'
      )
      await service.click({
        sessionId: wide.sessionId,
        target: { role: 'button', name: 'Right edge', exact: true }
      })
      assert.equal(
        (await service.evaluate({ sessionId: wide.sessionId, expression: 'document.title' })).value,
        'clicked-right',
        'A click near the right edge of the viewport lands'
      )
      // The same button, by the point on the agent's screenshot.
      await service.evaluate({
        sessionId: wide.sessionId,
        expression: "document.title = 'unclicked'"
      })
      const fresh = await service.observe(wide.sessionId, { screenshot: 'viewport' })
      await service.click({
        sessionId: wide.sessionId,
        target: {
          coordinates: { x: 1280 - 64 - 60, y: Math.round(filledHeight / 2) + 24 },
          screenshotId: fresh.screenshot!.id
        }
      })
      assert.equal(
        (await service.evaluate({ sessionId: wide.sessionId, expression: 'document.title' })).value,
        'clicked-right',
        'A click at screenshot coordinates near the right edge lands'
      )
      // Scaled to fit, the page's 48-pixel right edge falls at the panel's own right edge. The
      // capture starts at the panel's top-left in device pixels on every platform; whether it
      // also holds the rest of the emulated surface differs, so only that band is checked.
      const shown = await webContents.fromId(wide.tab.webContentsId)!.capturePage()
      const shownPath = join(dirname(shot.screenshot!.path), 'panel-view.png')
      writeFileSync(shownPath, shown.toPNG())
      const fit = Math.min(1, panel.width / 1280, panel.height / 900)
      const devicePixels = screen.getDisplayMatching(narrowHost.getBounds()).scaleFactor
      assert.ok(
        hasRedAt(
          shownPath,
          Math.floor((1280 - 40) * fit * devicePixels),
          Math.ceil(1280 * fit * devicePixels)
        ),
        `The panel shows the right edge of the page, scaled to fit (capture ${shown.getSize().width}x${shown.getSize().height}, scale ${devicePixels})`
      )
      unmountBrowserHost(narrowHost)
      const parkedWide = await service.observe(wide.sessionId, { screenshot: 'viewport' })
      assert.ok(
        hasRedAt(parkedWide.screenshot!.path, 1240, 1280),
        'A parked page keeps the agent viewport'
      )

      // A phone preset lays out at its width as a touch, mobile page; responsive gives the page
      // back the panel's size with the browser's own user agent and input.
      mountBrowserView(wide.tab.webContentsId, narrowHost, panel, () => true, 1)
      const page = async (): Promise<{ width: number; touch: number; agent: string }> =>
        (
          await service.evaluate({
            sessionId: wide.sessionId,
            expression:
              '({ width: window.innerWidth, touch: navigator.maxTouchPoints, agent: navigator.userAgent })'
          })
        ).value as { width: number; touch: number; agent: string }
      await service.resize({
        sessionId: wide.sessionId,
        viewport: { width: 393, height: 852, deviceScaleFactor: 1 },
        emulation: { mobile: true },
        device: { id: 'iphone-14-pro', label: 'iPhone 14 Pro', source: 'user' }
      })
      const phone = await page()
      assert.equal(phone.width, 393, 'A phone lays out at its width')
      assert.equal(
        (await service.evaluate({ sessionId: wide.sessionId, expression: 'window.innerHeight' }))
          .value,
        852,
        'A phone keeps its exact height, centred in the panel'
      )
      assert.ok(phone.touch > 0, 'A phone has touch input')
      assert.match(phone.agent, /Mobile/, 'A phone reports a mobile user agent')
      assert.equal(service.workspaceSnapshot(wide.sessionId).device?.id, 'iphone-14-pro')
      await service.resetViewport({ sessionId: wide.sessionId })
      const responsive = await page()
      assert.equal(responsive.width, panel.width, 'Responsive lays out at the panel width at 100%')
      assert.equal(responsive.touch, 0, 'Responsive has no emulated touch')
      assert.doesNotMatch(responsive.agent, /Mobile/, 'Responsive has the browser user agent')
      assert.equal(service.workspaceSnapshot(wide.sessionId).device, null)
      unmountBrowserHost(narrowHost)
      narrowHost.destroy()
      await service.close({ sessionId: wide.sessionId })
      progress('Agent viewport wider than the panel: screenshot, click, and fit passed')
    }

    const externalPdf = process.env.SIDEKICK_NATIVE_BROWSER_SMOKE_PDF
    const remotePdf = process.env.SIDEKICK_NATIVE_BROWSER_SMOKE_PDF_URL
    {
      const pdfPath = remotePdf ? undefined : resolve(externalPdf || fillablePdf)
      if (pdfPath) assert.ok(existsSync(pdfPath), `Diagnostic PDF does not exist: ${pdfPath}`)
      progress('Opening PDF fixture')
      const pdf = await service.open({
        runId: 'pdf-diagnostic',
        url: remotePdf || pathToFileURL(pdfPath!).href,
        ...(pdfPath ? { allowedFileRoots: [dirname(pdfPath)] } : {}),
        viewport: { width: 1200, height: 900, deviceScaleFactor: 1 }
      })
      const image = nativeImage.createFromPath(pdf.screenshot!.path)
      const bitmap = image.toBitmap()
      const colors = new Set<string>()
      const step = Math.max(4, Math.floor(bitmap.byteLength / 20_000 / 4) * 4)
      for (let offset = 0; offset + 3 < bitmap.byteLength; offset += step) {
        colors.add(bitmap.subarray(offset, offset + 3).toString('hex'))
      }
      progress(
        `PDF diagnostic: title=${JSON.stringify(pdf.tab.title)}, semanticNodes=${pdf.semanticNodeCount ?? 0}, sampledColors=${colors.size}, screenshotBytes=${pdf.screenshot!.bytes}`
      )
      if (externalPdf) progress(`PDF semantics: ${JSON.stringify(pdf.semanticSnapshot ?? '')}`)
      if (remotePdf)
        progress(
          `Remote PDF semantics preview: ${JSON.stringify((pdf.semanticSnapshot ?? '').slice(0, 2_000))}`
        )
      assert.match(pdf.semanticSnapshot ?? '', /textbox "/)
      assert.ok(colors.size > 10, 'Rendered PDF screenshot should contain visible document detail')
      const remoteTextbox = remotePdf
        ? pdf.semanticSnapshot
            ?.split('\n')
            .filter(
              (line) =>
                line.includes('textbox "') &&
                line.includes('Family Name (Last Name)') &&
                !line.includes('disabled=true')
            )
            .map((line) => line.match(/\[ref=([^\s\]]+)/)?.[1])
            .find(Boolean)
        : undefined
      if (remotePdf) assert.ok(remoteTextbox, 'Remote PDF should expose a semantic textbox')
      const pdfFields = remotePdf
        ? ([
            {
              kind: 'textbox',
              target: { ref: remoteTextbox! },
              value: 'Test'
            }
          ] as const)
        : externalPdf
          ? ([
              {
                kind: 'textbox',
                target: { role: 'textbox', name: 'Applicant full legal name', exact: true },
                value: 'Avery Test'
              },
              {
                kind: 'select',
                target: { role: 'combobox', name: 'Applicant mailing state', exact: true },
                values: ['NV']
              },
              {
                kind: 'checkbox',
                target: {
                  role: 'checkbox',
                  name: 'Email a copy of the completed request',
                  exact: true
                },
                checked: true
              }
            ] as const)
          : ([
              {
                kind: 'textbox',
                target: { role: 'textbox', name: 'Applicant name', exact: true },
                value: 'Avery Test'
              }
            ] as const)
      const filledPdf = await service.fillForm({
        sessionId: pdf.sessionId,
        fields: [...pdfFields]
      })
      assert.equal(filledPdf.completed, true, JSON.stringify(filledPdf.fields))
      if (externalPdf && !remotePdf) {
        await service.select({
          sessionId: pdf.sessionId,
          target: { role: 'combobox', name: 'Applicant mailing state', exact: true },
          values: ['NV']
        })
        progress('Standalone PDF select and verification passed')
      }
      await service.click({
        sessionId: pdf.sessionId,
        target: { role: 'button', name: 'Save filled copy', exact: true }
      })
      await service.wait({
        sessionId: pdf.sessionId,
        condition: { type: 'text', text: 'Filled copy saved:', state: 'present' }
      })
      const saved = await service.evaluate({
        sessionId: pdf.sessionId,
        expression: `document.documentElement.dataset.sidekickPdfOutput || ''`
      })
      assert.equal(typeof saved.value, 'string')
      assert.ok(
        existsSync(saved.value as string),
        'Filled PDF copy should be written to its configured destination'
      )
      assert.equal(
        readFileSync(saved.value as string)
          .subarray(0, 5)
          .toString('ascii'),
        '%PDF-'
      )
      progress(`PDF form fill and save passed: ${saved.value}`)
      await service.close({ sessionId: pdf.sessionId })
    }

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
    await service.evaluate({
      sessionId: opened.sessionId,
      expression: `(() => {
        window.__shadowFixture = [];
        for (const mode of ['open', 'closed', 'nested']) {
          const host = document.createElement('div');
          document.querySelector('main').prepend(host);
          let root = host.attachShadow({mode: mode === 'closed' ? 'closed' : 'open'});
          if (mode === 'nested') {
            const inner = document.createElement('div'); root.append(inner);
            root = inner.attachShadow({mode:'closed'});
          }
          const input = document.createElement('input');
          input.setAttribute('aria-label', 'Shadow ' + mode);
          root.append(input); window.__shadowFixture.push({input, host});
        }
      })()`
    })
    await service.observe(opened.sessionId)
    for (const mode of ['open', 'closed', 'nested']) {
      await service.type({
        sessionId: opened.sessionId,
        target: { role: 'textbox', name: 'Shadow ' + mode, exact: true },
        text: 'fixture-' + mode
      })
    }
    const shadowValues = await service.evaluate({
      sessionId: opened.sessionId,
      expression: `window.__shadowFixture.map(({input}) => input.value)`
    })
    assert.deepEqual(shadowValues.value, ['fixture-open', 'fixture-closed', 'fixture-nested'])
    progress('Open, closed and nested shadow textbox native input passed')
    await assert.rejects(
      service.upload({
        sessionId: opened.sessionId,
        workspaceRoot: allowedRoot,
        paths: ['../outside.txt'],
        target: { selector: '#upload' }
      }),
      /escapes/
    )
    // An absolute path names a project file as well as a relative one does,
    // but only while it stays inside the project.
    await assert.rejects(
      service.upload({
        sessionId: opened.sessionId,
        workspaceRoot: allowedRoot,
        paths: [outsideFile],
        target: { selector: '#upload' }
      }),
      /outside the project/
    )
    await service.upload({
      sessionId: opened.sessionId,
      workspaceRoot: allowedRoot,
      paths: [insideFile],
      target: { selector: '#upload' }
    })
    await service.upload({
      sessionId: opened.sessionId,
      workspaceRoot: allowedRoot,
      paths: [relative(allowedRoot, insideFile)],
      target: { selector: '#upload' }
    })
    const selectedFile = await service.evaluate({
      sessionId: opened.sessionId,
      expression: `document.querySelector('#upload').files[0].name`
    })
    assert.equal(selectedFile.value, relative(allowedRoot, insideFile))
    progress('Real file input selection and upload path boundaries passed')
    const downloaded = await service.download({
      sessionId: opened.sessionId,
      workspaceRoot: allowedRoot,
      url: `${baseUrl}/download`,
      destination: 'downloaded.txt'
    })
    assert.equal(readFileSync(downloaded.path, 'utf8'), 'download-fixture')
    await assert.rejects(
      service.download({
        sessionId: opened.sessionId,
        workspaceRoot: allowedRoot,
        url: `${baseUrl}/download`,
        destination: 'downloaded.txt'
      }),
      /EEXIST/
    )
    assert.equal(readFileSync(downloaded.path, 'utf8'), 'download-fixture')
    const redirectedDownload = await service.download({
      sessionId: opened.sessionId,
      url: `${baseUrl}/redirect-download`,
      workspaceRoot: allowedRoot,
      destination: 'redirected-download.txt'
    })
    assert.equal(readFileSync(redirectedDownload.path, 'utf8'), 'download-fixture')
    await assert.rejects(
      service.download({
        sessionId: opened.sessionId,
        workspaceRoot: allowedRoot,
        url: `${baseUrl}/unsafe-download`,
        destination: 'unsafe.txt'
      })
    )
    assert.equal(existsSync(join(allowedRoot, 'unsafe.txt')), false)
    await assert.rejects(
      service.download({
        sessionId: opened.sessionId,
        workspaceRoot: allowedRoot,
        url: `${baseUrl}/oversized-download`,
        destination: 'oversized.bin'
      }),
      /limit|exceed|large/i
    )
    assert.equal(existsSync(join(allowedRoot, 'oversized.bin')), false)
    progress('Session download, no-overwrite and redirect boundaries passed')
    const redirectedPdf = await service.open({
      runId: 'redirected-pdf-smoke',
      url: `${baseUrl}/redirected.pdf`,
      allowedFileRoots: [allowedRoot]
    })
    assert.match(redirectedPdf.semanticSnapshot ?? '', /textbox "/)
    assert.equal(redirectedPdf.tab.url, `${baseUrl}/redirected.pdf`)
    await service.close({ sessionId: redirectedPdf.sessionId })
    progress('Redirected remote PDF rendered with accessible form fields')

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
