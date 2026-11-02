// SideKick's hands in the user's own Chrome. It asks SideKick for work over this computer's loopback
// address and only does what it is told, on tabs SideKick names. SideKick decides what is allowed. This
// file refuses what must never happen whatever SideKick says, such as pages that aren't web pages.

const instance = crypto.randomUUID()
const version = chrome.runtime.getManifest().version
const GROUP_TITLE = '🤖 SideKick'
const LOAD_WAIT_MS = 8_000
const CAPTURE_WAIT_MS = 4_000
const TABS_BUSY_TRIES = 25
const TABS_BUSY_WAIT_MS = 200
const DRAG_STEPS = 8
const DRAG_STEP_MS = 15
const WINDOW_WIDTH = 1100
const WINDOW_HEIGHT = 800
const attached = new Set()
let polling = false

async function tabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId)
  return {
    id: tab.id,
    title: tab.title ?? '',
    // A tab that has only just opened has no address yet, only the one it's on its way to.
    url: tab.url || tab.pendingUrl || '',
    active: tab.active,
    windowId: tab.windowId,
    loading: tab.status !== 'complete'
  }
}

/**
 * Only ever web pages: not Chrome's own pages, where saved passwords live, nor other extensions. A tab
 * that has just been opened is blank for a moment on its way to one.
 */
async function webTab(tabId) {
  const info = await tabInfo(tabId)
  // Chrome's page for an address that failed still has to be somewhere the agent can leave.
  if (!/^(https?:|about:blank$|chrome-error:)/i.test(info.url)) {
    throw new Error('That tab is not a web page.')
  }
  return info
}

// What SideKick's browser tools use, and nothing else. No cookies or storage, and no way to reach other
// tabs or Chrome itself, whatever it's asked for.
const ALLOWED_COMMANDS = new Set([
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'DOM.describeNode',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getNodeForLocation',
  'DOM.querySelectorAll',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setUserAgentOverride',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Network.enable',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.setInterceptFileChooserDialog',
  'Page.reload',
  'Page.stopLoading',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.releaseObject',
  'WebMCP.cancelInvocation',
  'WebMCP.enable',
  'WebMCP.invokeTool'
])

// What the browser tools listen for. The rest is a lot of traffic with nothing in it for them.
const FORWARDED_EVENTS = new Set([
  'Page.fileChooserOpened',
  'Network.loadingFailed',
  'Network.loadingFinished',
  'Network.requestWillBeSent',
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown'
])
const EVENT_BATCH_MS = 40
const MAX_FILE_BYTES = 25 * 1024 * 1024

/** Domains and scripts turned on for each tab, to turn back on if the debugger has to attach again. */
const remembered = new Map()
let pendingEvents = []
let eventTimer = null

function sendEvent(event) {
  pendingEvents.push(event)
  eventTimer ??= setTimeout(flushEvents, EVENT_BATCH_MS)
}

async function flushEvents() {
  eventTimer = null
  const events = pendingEvents
  pendingEvents = []
  if (!events.length) return
  const paired = await pairing().catch(() => null)
  if (!paired) return
  await fetch(`http://127.0.0.1:${paired.port}/event`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(events)
  }).catch(() => undefined)
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') finish()
    }
    const timer = setTimeout(finish, LOAD_WAIT_MS)
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish()
      })
      .catch(finish)
  })
}

/**
 * Chrome turns tab changes away for a moment while a window is closing or a tab is being dragged, and says
 * so. That's a wait, not a failure: a user dragging a tab shouldn't stop the agent.
 */
async function whenTabsFree(work) {
  for (let tries = 0; ; tries++) {
    try {
      return await work()
    } catch (error) {
      if (tries >= TABS_BUSY_TRIES || !/cannot be edited right now/i.test(error.message))
        throw error
      await new Promise((done) => setTimeout(done, TABS_BUSY_WAIT_MS))
    }
  }
}

async function inGroup(tabId, windowId) {
  const [existing] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE })
  const groupId = await whenTabsFree(() =>
    chrome.tabs.group({
      tabIds: [tabId],
      ...(existing ? { groupId: existing.id } : { createProperties: { windowId } })
    })
  )
  if (!existing) {
    await whenTabsFree(() =>
      chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' })
    )
  }
}

/**
 * A tab in the SideKick group, selected in a window of its own that doesn't take focus. Measured on real
 * pages: an unselected tab in the user's window could take seconds to draw a picture or stall altogether,
 * and a slider dragged there stopped at the first notch, even with the page counting itself visible.
 */
async function open({ url, windowId }) {
  const window = windowId ? await chrome.windows.get(windowId).catch(() => null) : null
  // A window on its way out can still be found, and then not take a tab.
  let tab = window
    ? await whenTabsFree(() =>
        chrome.tabs.create({ windowId: window.id, url, active: true })
      ).catch(() => null)
    : null
  if (!tab) {
    const created = await whenTabsFree(() =>
      chrome.windows.create({
        url,
        focused: false,
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
      })
    )
    tab = created.tabs[0]
  }
  tracked.add(tab.id)
  // The group is only a label, and no reason to fail a tab that's open and works.
  await inGroup(tab.id, tab.windowId).catch(() => undefined)
  // Selected before it counted as the agent's, and nothing here is the user's to give back.
  selectedTabs.delete(tab.windowId)
  // A page that thinks it's hidden may not even draw.
  await debug(tab.id, 'Page.enable')
  await loaded(tab.id)
  return tabInfo(tab.id)
}

async function activeTab() {
  // A normal window, as a popup can have been focused last and isn't what the user means.
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id })
  if (!tab) throw new Error('Chrome has no tab open.')
  return tabInfo(tab.id)
}

// Runs in the page, kept apart from the page's own scripts. Every value a page keeps secret stays here.
function showOverlay(accent, x, y) {
  const STYLE = `
    .glow { position: fixed; inset: 0; border: 2px solid var(--accent); box-shadow: inset 0 0 36px 2px color-mix(in srgb, var(--accent) 38%, transparent); animation: breathe 2.6s ease-in-out infinite; }
    @keyframes breathe { 50% { opacity: 0.65; } }
    svg { position: fixed; left: 0; top: 0; overflow: visible; transition: transform 300ms ease-in-out; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35)); }
    .ring { position: fixed; left: -16px; top: -16px; width: 32px; height: 32px; box-sizing: border-box; border: 2px solid var(--accent); border-radius: 50%; opacity: 0; }
  `
  let overlay = window.__sidekickOverlay
  if (!overlay?.host.isConnected) {
    document.querySelector('sidekick-overlay')?.remove()
    const host = document.createElement('sidekick-overlay')
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; pointer-events: none;'
    const root = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(STYLE)
    root.adoptedStyleSheets = [sheet]
    const glow = document.createElement('div')
    glow.className = 'glow'
    const ring = document.createElement('div')
    ring.className = 'ring'
    const SVG = 'http://www.w3.org/2000/svg'
    const pointer = document.createElementNS(SVG, 'svg')
    pointer.setAttribute('width', '26')
    pointer.setAttribute('height', '30')
    pointer.setAttribute('viewBox', '0 0 26 30')
    pointer.style.visibility = 'hidden'
    const arrow = document.createElementNS(SVG, 'path')
    arrow.setAttribute(
      'd',
      'M3 4.4C3 2.6 5 1.6 6.4 2.7l15.5 12.4c1.5 1.2.7 3.6-1.2 3.7l-6.1.3c-.8 0-1.5.5-1.9 1.2l-3.1 5.9c-.9 1.7-3.5 1.3-3.8-.6z'
    )
    arrow.setAttribute('fill', 'var(--accent)')
    arrow.setAttribute('stroke', '#ffffff')
    arrow.setAttribute('stroke-width', '2')
    arrow.setAttribute('stroke-linejoin', 'round')
    pointer.append(arrow)
    root.append(glow, ring, pointer)
    document.documentElement.append(host)
    overlay = window.__sidekickOverlay = { host, pointer, ring }
  }
  overlay.host.style.display = 'block'
  overlay.host.style.setProperty('--accent', accent)
  if (typeof x !== 'number') return
  // The arrow's tip is 3 and 2 pixels into its picture.
  overlay.pointer.style.transform = `translate(${x - 3}px, ${y - 2}px)`
  overlay.pointer.style.visibility = 'visible'
  overlay.ring.style.transform = `translate(${x}px, ${y}px)`
  setTimeout(() => {
    overlay.ring.animate(
      [
        { opacity: 0.9, transform: `translate(${x}px, ${y}px) scale(0.2)` },
        { opacity: 0, transform: `translate(${x}px, ${y}px) scale(1.3)` }
      ],
      { duration: 460, easing: 'ease-out' }
    )
  }, 300)
}

// By its tag: an extension reloaded since it showed this no longer has the reference.
function removeOverlay() {
  document.querySelector('sidekick-overlay')?.remove()
  window.__sidekickOverlay = undefined
}

function overlayShown(shown) {
  const host = window.__sidekickOverlay?.host
  // Not visibility: the pointer sets its own, which would leave it in the model's picture.
  if (host) host.style.display = shown ? 'block' : 'none'
}

async function inPage(tabId, func, ...args) {
  await webTab(tabId)
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return result?.result ?? null
}

/** Real input takes the debugger, which is what makes Chrome show its banner, so only from here on. */
async function debug(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    // This worker can have been restarted and forgotten it was attached already.
    await chrome.debugger.attach({ tabId }, '1.3').catch((error) => {
      if (!/already attached/i.test(error.message)) throw error
    })
    attached.add(tabId)
    // Chrome stops drawing a window that's fully covered: input took 5 seconds and pictures never came.
    // Measured with this on, in a covered window: 90 ms and 150 ms, and the page counts itself visible.
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', {
      enabled: true
    })
    for (const [method, params] of remembered.get(tabId) ?? []) {
      await chrome.debugger.sendCommand({ tabId }, method, params).catch(() => undefined)
    }
  }
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ])

// One at a time: a picture for the model asked for while one for the corner label was on its way never came.
let lastCapture = Promise.resolve()
function capturing(work) {
  const turn = lastCapture.catch(() => undefined).then(work)
  lastCapture = turn
  return turn
}

const captureOnce = (tabId, params) =>
  withTimeout(
    debug(tabId, 'Page.captureScreenshot', params),
    CAPTURE_WAIT_MS,
    'Chrome gave no picture of this tab in time.'
  )

/** A capture that has stalled stays stalled until the debugger lets go, so that's worth one more try. */
async function capture(tabId, params) {
  try {
    return await captureOnce(tabId, params)
  } catch {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
    return captureOnce(tabId, params)
  }
}

/**
 * For the corner picture. It keeps the glow, being for the user to see, and leaves the debugger alone if it
 * stalls: this is only a picture, and letting go of a tab would interrupt what the agent is doing in it.
 */
async function preview({ tabId }) {
  await webTab(tabId)
  return capturing(() => captureOnce(tabId, { format: 'jpeg', quality: 70 }))
}

/**
 * All of a drag from here, with no trip to SideKick between moves. A page that redraws as a slider's value
 * changes loses a drag that arrives slowly.
 */
async function drag({ tabId, from, to, button = 'left' }) {
  await webTab(tabId)
  const buttons = { left: 1, right: 2, middle: 4 }[button] ?? 1
  const mouse = (type, at, extra) =>
    debug(tabId, 'Input.dispatchMouseEvent', { type, ...at, button, buttons, ...extra })
  await mouse('mouseMoved', from, { button: 'none', buttons: 0 })
  await mouse('mousePressed', from, { clickCount: 1 })
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await new Promise((done) => setTimeout(done, DRAG_STEP_MS))
    await mouse('mouseMoved', {
      x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
      y: from.y + ((to.y - from.y) * step) / DRAG_STEPS
    })
  }
  await mouse('mouseReleased', to, { buttons: 0, clickCount: 1 })
}

async function navigate({ tabId, url }) {
  await webTab(tabId)
  let failure = ''
  const failed = (details) => {
    if (details.tabId === tabId && details.frameId === 0 && !/ABORTED/.test(details.error)) {
      failure = details.error
    }
  }
  chrome.webNavigation.onErrorOccurred.addListener(failed)
  try {
    await whenTabsFree(() => chrome.tabs.update(tabId, { url }))
    await loaded(tabId)
  } finally {
    chrome.webNavigation.onErrorOccurred.removeListener(failed)
  }
  if (failure) throw new Error(`The page could not be loaded: ${failure}`)
  return tabInfo(tabId)
}

/** Brings a tab to the front of the agent's window, where only the selected tab draws properly. */
async function selectTab({ tabId }) {
  await whenTabsFree(() => chrome.tabs.update(tabId, { active: true }))
}

async function showTab({ tabId }) {
  const tab = await chrome.tabs.update(tabId, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
}

async function overlaysOff({ tabIds = [] }) {
  for (const tabId of tabIds) await inPage(tabId, removeOverlay).catch(() => undefined)
}

async function detachAll() {
  for (const tabId of [...attached]) {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
  }
}

/** A command from the browser tools, on a tab SideKick has told this about. */
async function cdp({ tabId, method, params = {} }) {
  if (!ALLOWED_COMMANDS.has(method)) throw new Error(`${method} is not available.`)
  await webTab(tabId)
  if (method.endsWith('.enable') || method === 'Page.addScriptToEvaluateOnNewDocument') {
    const list = remembered.get(tabId) ?? []
    list.push([method, params])
    remembered.set(tabId, list)
  }
  tracked.add(tabId)
  if (method !== 'Page.captureScreenshot') return (await debug(tabId, method, params)) ?? {}
  return capturing(async () => {
    // For the model: its own glow and pointer aren't part of the page.
    await inPage(tabId, overlayShown, false).catch(() => undefined)
    try {
      return await capture(tabId, params)
    } finally {
      await inPage(tabId, overlayShown, true).catch(() => undefined)
    }
  })
}

/** With the user's own cookies, for a download they asked the agent for. */
async function fetchFile({ url, method = 'GET' }) {
  if (!/^https?:/i.test(url)) throw new Error('Only web addresses can be downloaded.')
  const answer = await fetch(url, { method, credentials: 'include' })
  const bytes = await answer.arrayBuffer()
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('That file is too large to download.')
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let at = 0; at < view.length; at += 0x8000) {
    binary += String.fromCharCode(...view.subarray(at, at + 0x8000))
  }
  return { status: answer.status, headers: [...answer.headers.entries()], data: btoa(binary) }
}

const tracked = new Set()
/** The tab the user last had selected in each window, as a new tab of the agent's mustn't take it over. */
const selectedTabs = new Map()

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (!tracked.has(tabId)) selectedTabs.set(windowId, tabId)
})

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId === undefined) return
  // A page's alert would freeze it, and everything waiting on it, until someone answered.
  if (method === 'Page.javascriptDialogOpening') {
    void chrome.debugger
      .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
        accept: params.type === 'beforeunload'
      })
      .catch(() => undefined)
    sendEvent({
      kind: 'cdp',
      tabId,
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'warning',
        args: [{ value: `A page dialog was dismissed: ${params.message}` }]
      }
    })
    return
  }
  if (FORWARDED_EVENTS.has(method) || method.startsWith('WebMCP.')) {
    sendEvent({ kind: 'cdp', tabId, method, params })
  }
})

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId)
  if (tabId !== undefined && tracked.has(tabId)) sendEvent({ kind: 'detached', tabId, reason })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  remembered.delete(tabId)
  if (tracked.delete(tabId)) sendEvent({ kind: 'removed', tabId })
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tracked.has(tabId) || !('url' in change || 'title' in change || 'status' in change)) return
  sendEvent({
    kind: 'tab',
    tabId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    loading: tab.status !== 'complete'
  })
})

// A link or script in one of the agent's tabs that opens another: the page may need that exact tab, as a
// sign-in popup does. It joins the group, and the user keeps the tab they were on.
// Not tabs.onCreated: a link that opens a new tab has no opener, as far as that one can tell. Only while the
// agent holds the tab it came from, so what the user opens from a tab they shared stays theirs.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId, url }) => {
  if (!tracked.has(sourceTabId) || !attached.has(sourceTabId)) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) return
  tracked.add(tabId)
  void inGroup(tabId, tab.windowId).catch(() => undefined)
  const theirs = selectedTabs.get(tab.windowId)
  if (tab.active && theirs !== undefined && theirs !== tabId) {
    void chrome.tabs.update(theirs, { active: true }).catch(() => undefined)
  }
  sendEvent({ kind: 'popup', tabId, openerTabId: sourceTabId, url, title: tab.title ?? '' })
})

const OPERATIONS = {
  open,
  activeTab,
  tabInfo: ({ tabId }) => tabInfo(tabId),
  navigate,
  drag,
  preview,
  selectTab,
  showTab,
  closeTab: ({ tabId }) => whenTabsFree(() => chrome.tabs.remove(tabId)),
  detachAll,
  cdp,
  fetchFile,
  overlay: ({ tabId, accent, x, y }) => inPage(tabId, showOverlay, accent, x, y),
  overlaysOff,
  // The user pressed Disconnect in SideKick, which needs no permission and nothing more from them.
  uninstallSelf: () => chrome.management.uninstallSelf({ showConfirmDialog: false }),
  // SideKick has put a newer copy of these files in place.
  reload: () => setTimeout(() => chrome.runtime.reload(), 100)
}

async function pairing() {
  const answer = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store' })
  return answer.json()
}

async function answer(paired, id, work) {
  let body
  try {
    body = { id, result: (await work()) ?? null }
  } catch (error) {
    body = { id, error: error instanceof Error ? error.message : String(error) }
  }
  await fetch(`http://127.0.0.1:${paired.port}/answer`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => undefined)
}

async function poll() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      const paired = await pairing()
      const reply = await fetch(`http://127.0.0.1:${paired.port}/next`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${paired.token}`,
          'x-sidekick-instance': instance,
          'x-sidekick-version': version
        }
      })
      if (!reply.ok) return
      // An extension call keeps Chrome from putting this to sleep between requests.
      await chrome.runtime.getPlatformInfo()
      const work = await reply.json()
      if (work?.op) {
        const run = OPERATIONS[work.op]
        void answer(paired, work.id, () =>
          run ? run(work.args ?? {}) : Promise.reject(new Error(`No such operation: ${work.op}`))
        )
      }
    }
  } catch {
    // SideKick isn't running. The alarm tries again.
  } finally {
    polling = false
  }
}

chrome.alarms.create('sidekick-connect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void poll())
chrome.runtime.onStartup.addListener(() => void poll())
chrome.runtime.onInstalled.addListener(() => void poll())
void poll()
