// SideKick's hands in the user's own Chrome. It asks SideKick for work over this computer's loopback
// address and only does what it is told, on tabs SideKick names. SideKick decides what is allowed. This
// file refuses what must never happen whatever SideKick says, such as pages that aren't web pages.

const instance = crypto.randomUUID()
const version = chrome.runtime.getManifest().version
const GROUP_TITLE = 'SideKick'
const LOAD_WAIT_MS = 15_000
const CAPTURE_WAIT_MS = 6_000
const WINDOW_WIDTH = 1100
const WINDOW_HEIGHT = 800
const attached = new Set()
let polling = false

const KEYS = {
  return: ['Enter', 13, '\r'],
  enter: ['Enter', 13, '\r'],
  tab: ['Tab', 9],
  escape: ['Escape', 27],
  esc: ['Escape', 27],
  space: [' ', 32, ' '],
  backspace: ['Backspace', 8],
  delete: ['Delete', 46],
  home: ['Home', 36],
  end: ['End', 35],
  pageup: ['PageUp', 33],
  pagedown: ['PageDown', 34],
  up: ['ArrowUp', 38],
  down: ['ArrowDown', 40],
  left: ['ArrowLeft', 37],
  right: ['ArrowRight', 39]
}
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, shift: 8 }

async function tabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId)
  return {
    id: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active,
    windowId: tab.windowId,
    loading: tab.status !== 'complete'
  }
}

/** Only ever web pages: not Chrome's own pages, where saved passwords live, nor other extensions. */
async function webTab(tabId) {
  const info = await tabInfo(tabId)
  if (!/^https?:/i.test(info.url)) throw new Error('That tab is not a web page.')
  return info
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

async function inGroup(tabId, windowId) {
  const [existing] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE })
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    ...(existing ? { groupId: existing.id } : { createProperties: { windowId } })
  })
  if (!existing) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue' })
}

/**
 * A tab in the SideKick group, in the window the chat already uses or the user's latest one. Never the
 * selected tab: created selected, it brought the whole window in front of what the user was doing, and
 * with focus emulation an unselected tab works as well as any.
 */
async function open({ url, windowId }) {
  const window =
    (windowId ? await chrome.windows.get(windowId).catch(() => null) : null) ??
    (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))
  let tab
  if (window) {
    tab = await chrome.tabs.create({ windowId: window.id, url, active: false })
  } else {
    const created = await chrome.windows.create({
      url,
      focused: false,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT
    })
    tab = created.tabs[0]
  }
  await inGroup(tab.id, tab.windowId)
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
function snapshot(maxElements, maxText) {
  const SELECTOR =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=switch],[role=combobox],[role=textbox],[contenteditable="true"],[onclick]'
  const SECRET =
    /password|passwd|passcode|one-time-code|cc-|card.?(num|number)|cvv|cvc|security.?code|ssn/i
  const found = []
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.matches(SELECTOR)) found.push(element)
      if (element.shadowRoot) walk(element.shadowRoot)
    }
  }
  walk(document)
  const isSecret = (element) =>
    element.type === 'password' ||
    SECRET.test(
      [element.autocomplete, element.name, element.id, element.getAttribute?.('aria-label')].join(
        ' '
      )
    )
  const nameOf = (element) =>
    (
      element.getAttribute('aria-label') ||
      element.labels?.[0]?.innerText ||
      element.innerText ||
      (element.type === 'submit' || element.type === 'button' ? element.value : '') ||
      element.placeholder ||
      element.title ||
      element.alt ||
      element.name ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  const shown = []
  for (const element of found) {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    if (box.width <= 0 || box.height <= 0) continue
    if (style.visibility === 'hidden' || style.display === 'none') continue
    shown.push(element)
    if (shown.length >= maxElements) break
  }
  window.__sidekickElements = shown
  const rows = shown.map((element, index) => {
    const box = element.getBoundingClientRect()
    const secret = isSecret(element)
    const holdsValue = 'value' in element && element.type !== 'submit' && element.type !== 'button'
    return {
      index,
      role: element.getAttribute('role') || element.type || element.tagName.toLowerCase(),
      name: nameOf(element),
      value: holdsValue
        ? secret
          ? element.value
            ? '(hidden)'
            : ''
          : String(element.value).slice(0, 200)
        : undefined,
      checked:
        element.type === 'checkbox' || element.type === 'radio' ? element.checked : undefined,
      disabled: element.disabled === true || undefined,
      secret: secret || undefined,
      onScreen: box.bottom > 0 && box.top < innerHeight
    }
  })
  return {
    title: document.title,
    url: location.href,
    rows,
    total: found.length,
    text: (document.body?.innerText ?? '').slice(0, maxText),
    scrolled: Math.round(scrollY),
    pageHeight: document.documentElement.scrollHeight,
    viewHeight: innerHeight
  }
}

// Also in the page: what a row is right now, in view, and where. Null once the page has replaced it.
function locate(index) {
  const SECRET =
    /password|passwd|passcode|one-time-code|cc-|card.?(num|number)|cvv|cvc|security.?code|ssn/i
  const element = window.__sidekickElements?.[index]
  if (!element?.isConnected) return null
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const box = element.getBoundingClientRect()
  const form = element.form ?? element.closest?.('form')
  const submit = form?.querySelector('[type=submit],button:not([type=button])')
  return {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    name: (
      element.getAttribute('aria-label') ||
      element.innerText ||
      element.value ||
      element.title ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
    submit: (submit?.innerText || submit?.value || '').trim().slice(0, 120),
    secret:
      element.type === 'password' ||
      SECRET.test(
        [element.autocomplete, element.name, element.id, element.getAttribute('aria-label')].join(
          ' '
        )
      )
  }
}

// In the page: what Enter would do where the focus is now.
function focused() {
  const SECRET =
    /password|passwd|passcode|one-time-code|cc-|card.?(num|number)|cvv|cvc|security.?code|ssn/i
  const element = document.activeElement
  const form = element?.form ?? element?.closest?.('form')
  const submit = form?.querySelector('[type=submit],button:not([type=button])')
  return {
    name: (element?.innerText || '').trim().slice(0, 120),
    submit: (submit?.innerText || submit?.value || '').trim().slice(0, 120),
    secret:
      element?.type === 'password' ||
      SECRET.test([element?.autocomplete, element?.name, element?.id].join(' '))
  }
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
  }
  return chrome.debugger.sendCommand({ tabId }, method, params)
}

async function pressAt(tabId, x, y) {
  const mouse = (type, extra = {}) =>
    debug(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra })
  await mouse('mouseMoved')
  await mouse('mousePressed', { button: 'left', buttons: 1, clickCount: 1 })
  await mouse('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 })
}

async function click({ tabId, x, y }) {
  await webTab(tabId)
  await pressAt(tabId, x, y)
}

async function typeText({ tabId, text }) {
  await webTab(tabId)
  await debug(tabId, 'Input.insertText', { text })
}

async function pressKey({ tabId, key, modifiers = [] }) {
  await webTab(tabId)
  const named = KEYS[key.toLowerCase()]
  const single = key.length === 1 ? key : null
  if (!named && !single) throw new Error(`There is no key called "${key}".`)
  const bits = modifiers.reduce((all, name) => all | (MODIFIER_BITS[name.toLowerCase()] ?? 0), 0)
  const code = named ? named[1] : single.toUpperCase().charCodeAt(0)
  const shared = { key: named ? named[0] : single, windowsVirtualKeyCode: code, modifiers: bits }
  // A key with ctrl or alt held is a shortcut, not a character to type.
  const text = bits & 3 ? undefined : named ? named[2] : single
  await debug(tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...shared,
    ...(text ? { text } : {})
  })
  await debug(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...shared })
}

async function wheel({ tabId, direction, amount = 3 }) {
  await webTab(tabId)
  const { innerWidth: width, innerHeight: height } = await inPage(tabId, () => ({
    innerWidth,
    innerHeight
  }))
  const distance = Math.round((height / 3) * amount)
  await debug(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(width / 2),
    y: Math.round(height / 2),
    deltaX: direction === 'left' ? -distance : direction === 'right' ? distance : 0,
    deltaY: direction === 'up' ? -distance : direction === 'down' ? distance : 0
  })
}

async function navigate({ tabId, url }) {
  await webTab(tabId)
  await chrome.tabs.update(tabId, { url })
  await loaded(tabId)
  return tabInfo(tabId)
}

async function back({ tabId }) {
  await webTab(tabId)
  await chrome.tabs.goBack(tabId)
  await loaded(tabId)
  return tabInfo(tabId)
}

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ])

async function screenshot({ tabId }) {
  await webTab(tabId)
  return withTimeout(
    debug(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 }),
    CAPTURE_WAIT_MS,
    'Chrome gave no picture of this tab in time.'
  )
}

async function detachAll() {
  for (const tabId of [...attached]) {
    attached.delete(tabId)
    await chrome.debugger.detach({ tabId }).catch(() => undefined)
  }
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId))
chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId))

const OPERATIONS = {
  open,
  activeTab,
  tabInfo: ({ tabId }) => tabInfo(tabId),
  read: ({ tabId, maxElements, maxText }) => inPage(tabId, snapshot, maxElements, maxText),
  locate: ({ tabId, index }) => inPage(tabId, locate, index),
  focused: ({ tabId }) => inPage(tabId, focused),
  click,
  typeText,
  pressKey,
  wheel,
  navigate,
  back,
  screenshot,
  closeTab: ({ tabId }) => chrome.tabs.remove(tabId),
  detachAll,
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
