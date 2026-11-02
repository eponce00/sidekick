import { AsyncLocalStorage } from 'async_hooks'
import { ComputerUseRefusal, soundsRisky } from './computerUseService'
import type { NativeBrowserPolicy, NativeBrowserSurface } from './nativeBrowserSessionService'

const WAIT_FOR_CHROME_MS = 35_000
// As for computer use: long enough to outlast a slow model's turn. Esc stays the user's otherwise.
const STOP_KEY_HELD_MS = 60_000

// Web vaults of what is blocked as an app: the same passwords, in a page.
const NEVER_SITES = new Set([
  'passwords.google.com',
  'vault.bitwarden.com',
  'my.1password.com',
  'lastpass.com'
])

// Where a page steering the agent could do the most harm with the user's sign-ins: their email, their money
// and their accounts. Names can't catch everything, and a false match only costs one question.
const SENSITIVE_SITES =
  /(^|\.)(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.proton\.me|icloud\.com|accounts\.google\.com|myaccount\.google\.com|pay\.google\.com|account\.microsoft\.com|appleid\.apple\.com|paypal\.com|venmo\.com|cash\.app|wise\.com|coinbase\.com|binance\.com|kraken\.com|robinhood\.com|fidelity\.com|schwab\.com|vanguard\.com|etrade\.com|chase\.com|wellsfargo\.com|bankofamerica\.com|citi\.com|capitalone\.com|americanexpress\.com|discover\.com|usbank\.com|revolut\.com)$|bank|credit/i

// Chromium's own check stops anything that changes the page or reaches the network, but lets a script read what
// it likes. These are what a look has no business with, and the ways of naming them that the words below can't see.
const NOT_A_LOOK =
  /\\u|\\x|\b(cookies?|localStorage|sessionStorage|indexedDB|caches|credentials|eval|Function|Reflect|getOwnPropertyDescriptors?|__lookupGetter__|__proto__|prototype|constructor|with|await|async|then)\b/

/**
 * Whether a script can be left to Chromium's check, as far as its words go. Failing here only costs the agent
 * a script, so anything that could be naming a property some other way does.
 */
export function readsLikeALook(expression: string): boolean {
  if (NOT_A_LOOK.test(expression)) return false
  const code = expression.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
  // The inside of each [ that picks a property, or names one in an object.
  for (const bracket of code.matchAll(/([\w$)\]`']?)\s*\[([^\]]*)\](\s*:)?/g)) {
    if (bracket[3]) return false
    if (bracket[1] && !/^\s*(\d+|'')\s*$/.test(bracket[2])) return false
  }
  return true
}

/** Whether a site is one to ask about even when the user hasn't asked to be asked about every site. */
export function isSensitiveSite(hostname: string): boolean {
  return SENSITIVE_SITES.test(hostname)
}

interface ChromeTab {
  id: number
  title: string
  url: string
}

export interface ChromeUseDependencies {
  bridge: {
    send: <T>(op: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<T>
    isConnected: () => boolean
    waitForConnection: (ms: number, signal: AbortSignal) => Promise<boolean>
  }
  /** Each answers for the user through a trusted dialog. Nothing else may allow any of these. */
  confirmSite: (origin: string, sensitive: boolean, signal: AbortSignal) => Promise<boolean>
  /** The user's choice to be asked about every site, and not only sensitive ones. */
  askEverySite: () => boolean
  confirmSharedTab: (tab: { title: string; url: string }, signal: AbortSignal) => Promise<boolean>
  confirmPress: (name: string, origin: string, signal: AbortSignal) => Promise<boolean>
  confirmDownload: (url: string, signal: AbortSignal) => Promise<boolean>
  confirmUpload: (files: readonly string[], origin: string, signal: AbortSignal) => Promise<boolean>
  /** Opens Chrome if SideKick's extension was set up in it, or offers to set it up. */
  bringUpChrome: (signal: AbortSignal) => Promise<boolean>
  /** The same marks computer use shows, so it is always clear that SideKick is driving. */
  overlay: {
    show: () => void
    hide: () => void
    preview: (image: { data: string }) => void
    replyEnded: () => void
    /** Esc from anywhere, for as long as the agent can act. Returns how to take it back. */
    armStop: (stop: () => void) => () => void
    notify: () => void
    /** The colour of the glow and pointer inside a page. */
    accent: () => Promise<string>
  }
  setTimer?: typeof setTimeout
}

interface ChromeChat {
  sites: Set<string>
  /** Tabs this chat has used, for taking its marks off them. */
  tabs: Set<number>
  current?: number
  notified?: boolean
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : ''
  } catch {
    return ''
  }
}

function refuseUnsafe(url: string): string {
  const origin = originOf(url)
  if (!origin) throw new ComputerUseRefusal(`Only web pages can be opened, not ${url}.`)
  if (NEVER_SITES.has(new URL(url).hostname.toLowerCase())) {
    throw new ComputerUseRefusal('That site holds saved passwords, so it is never available.')
  }
  return origin
}

/** A blank tab or Chrome's own error page isn't a site, and has to stay somewhere the agent can leave. */
function isNowhere(url: string): boolean {
  return !url || url === 'about:blank' || url.startsWith('chrome-error:')
}

/**
 * What is different about driving the user's own Chrome, signed in to everything: which sites and actions
 * ask them first, what is never available, and showing that SideKick is at the controls. The browser tools
 * do the work, the same as in the built-in browser, and call in here.
 */
export class ChromeUseService implements NativeBrowserPolicy {
  /** Chats working in Chrome. It lasts between replies, so a follow-up stays in the same tabs. */
  readonly inChrome = new Set<string>()
  private readonly chats = new Map<string, ChromeChat>()
  /** Which chat a browser tool is running for, through everything it awaits. */
  private readonly running = new AsyncLocalStorage<string>()
  /** Chats whose reply is still driving, and so what Esc stops. */
  private readonly driving = new Set<string>()
  /** Stopped with Esc. Their reply gets nowhere from here, whatever the model tries. */
  private readonly stopped = new Set<string>()
  private disarm: (() => void) | null = null
  private disarmTimer: ReturnType<typeof setTimeout> | null = null
  private readonly quiet = new AbortController().signal

  /** No question about it: nobody should be asked to judge code, and the page tools do the rest. */
  readonly scriptRefusal =
    "That script wasn't run. In the user's own Chrome a script can only look at a page, and this one could change something or reach cookies, saved site data or a filled-in password. Use browser_observe, browser_click, browser_type or browser_scroll."

  /** SideKick's stored logins are for its own browser. Chrome has the user's own. */
  readonly signInRefusal =
    "SideKick's stored logins aren't used in Chrome, which fills in the user's saved passwords itself. If it doesn't here, ask the user to sign in."

  constructor(private readonly deps: ChromeUseDependencies) {}

  /** Runs a browser tool as this chat's, so the rules know whose answers apply. */
  runInChat<T>(chat: string, work: () => Promise<T>): Promise<T> {
    return this.running.run(chat, work)
  }

  private currentChat(): string {
    const chat = this.running.getStore()
    if (!chat) throw new ComputerUseRefusal('This did not come from a chat.')
    return chat
  }

  private chat(id: string): ChromeChat {
    let chat = this.chats.get(id)
    if (!chat) {
      chat = { sites: new Set(), tabs: new Set() }
      this.chats.set(id, chat)
    }
    return chat
  }

  private refuseIfStopped(id: string): void {
    if (this.stopped.has(id)) {
      throw new ComputerUseRefusal(
        'The user pressed Esc to stop this, so nothing was done. Do not continue: tell them how far you got.'
      )
    }
  }

  /** Each step renews the marks, as a page that has moved on has lost its own. */
  private async markDriving(id: string, chat: ChromeChat, tabId: number): Promise<void> {
    this.driving.add(id)
    chat.tabs.add(tabId)
    chat.current = tabId
    if (!chat.notified) {
      chat.notified = true
      this.deps.overlay.notify()
    }
    this.disarm ??= this.deps.overlay.armStop(() => this.stop())
    this.deps.overlay.show()
    if (this.disarmTimer) clearTimeout(this.disarmTimer)
    // The debugger stays until the reply ends: a slow model's turn is no reason to cut the tab off.
    this.disarmTimer = (this.deps.setTimer ?? setTimeout)(
      () => this.takeMarksOff(false),
      STOP_KEY_HELD_MS
    )
    const accent = await this.deps.overlay.accent()
    await this.deps.bridge.send('overlay', { tabId, accent }, this.quiet).catch(() => undefined)
  }

  private takeMarksOff(letGo = true): void {
    if (this.disarmTimer) clearTimeout(this.disarmTimer)
    this.disarmTimer = null
    this.disarm?.()
    this.disarm = null
    this.deps.overlay.hide()
    const tabIds = [...this.chats.values()].flatMap((chat) => [...chat.tabs])
    void this.deps.bridge.send('overlaysOff', { tabIds }, this.quiet).catch(() => undefined)
    if (letGo) void this.deps.bridge.send('detachAll', {}, this.quiet).catch(() => undefined)
  }

  /** Esc: everything those chats were allowed ends now, and asking again takes the user's answer. */
  stop(): void {
    const tabIds = [...this.driving].flatMap((id) => [...(this.chats.get(id)?.tabs ?? [])])
    for (const id of this.driving) this.stopped.add(id)
    this.takeMarksOff()
    void this.deps.bridge.send('overlaysOff', { tabIds }, this.quiet).catch(() => undefined)
    for (const id of this.driving) this.chats.delete(id)
    this.driving.clear()
  }

  /** A finished reply takes the marks off and lets go of the debugger. Approvals last the chat. */
  runEnded(id: string): void {
    this.deps.overlay.replyEnded()
    this.stopped.delete(id)
    if (!this.driving.delete(id) || this.driving.size) return
    this.takeMarksOff()
  }

  /** The agent's pointer, where a step is about to happen. */
  showPointer(tabId: number, x: number, y: number): void {
    void this.deps.overlay
      .accent()
      .then((accent) => this.deps.bridge.send('overlay', { tabId, accent, x, y }, this.quiet))
      .catch(() => undefined)
  }

  /** The picture the agent just took of a tab, for the corner label. A second capture just for that held up the next action. */
  showLook(tabId: number, data: string): void {
    for (const id of this.driving) {
      if (this.chats.get(id)?.current === tabId) return this.deps.overlay.preview({ data })
    }
  }

  /** Chrome open with the extension in it, or the question that gets it there. */
  async ready(signal: AbortSignal): Promise<void> {
    this.refuseIfStopped(this.currentChat())
    if (this.deps.bridge.isConnected()) return
    if (!(await this.deps.bringUpChrome(signal))) {
      throw new ComputerUseRefusal(
        "SideKick's extension isn't connected in Chrome, and the user did not set it up. Tell them what you wanted to do."
      )
    }
    if (!(await this.deps.bridge.waitForConnection(WAIT_FOR_CHROME_MS, signal))) {
      throw new ComputerUseRefusal(
        "Chrome didn't connect to SideKick in time. Ask the user to check that Chrome is open."
      )
    }
  }

  private async allowSite(chat: ChromeChat, url: string, signal: AbortSignal): Promise<void> {
    const origin = refuseUnsafe(url)
    if (chat.sites.has(origin)) return
    // Turning this on was the user's answer for ordinary sites. Asking on every one only teaches them
    // to press Allow without reading, including on the few where it matters.
    const sensitive = isSensitiveSite(new URL(origin).hostname)
    if (!sensitive && !this.deps.askEverySite()) return
    if (!(await this.deps.confirmSite(origin, sensitive, signal))) {
      throw new ComputerUseRefusal(
        `The user did not allow ${origin}. Do not try to reach it another way.`
      )
    }
    chat.sites.add(origin)
  }

  async beforeStep(surface: NativeBrowserSurface, signal?: AbortSignal): Promise<void> {
    const id = this.currentChat()
    this.refuseIfStopped(id)
    const chat = this.chat(id)
    // It may have gone somewhere by itself since the last step, as a click or a page can.
    const url = surface.getURL()
    if (!isNowhere(url)) await this.allowSite(chat, url, signal ?? this.quiet)
    await this.markDriving(id, chat, surface.webContentsId)
  }

  async beforeNavigate(url: string, signal?: AbortSignal): Promise<void> {
    const id = this.currentChat()
    this.refuseIfStopped(id)
    if (!isNowhere(url)) await this.allowSite(this.chat(id), url, signal ?? this.quiet)
  }

  /** Things that can't be taken back ask the user, not the model: a page can talk a model into anything. */
  async beforePress(name: string, pageUrl: string, signal?: AbortSignal): Promise<void> {
    if (!soundsRisky(name)) return
    if (!(await this.deps.confirmPress(name, originOf(pageUrl), signal ?? this.quiet))) {
      throw new ComputerUseRefusal(
        `The user did not allow pressing "${name}", so nothing was sent. Do not try to do it another way.`
      )
    }
  }

  beforeTyping(field: { secret: boolean }): void {
    if (field.secret) {
      throw new ComputerUseRefusal(
        'That is a password or payment field, which only Chrome or the user may fill in. Ask the user to fill it.'
      )
    }
  }

  mayRunScript(expression: string): boolean {
    return readsLikeALook(expression)
  }

  async beforeDownload(url: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.deps.confirmDownload(url, signal ?? this.quiet))) {
      throw new ComputerUseRefusal('The user did not allow that download.')
    }
  }

  /** A signed-in site is somewhere a file could leave for without anyone noticing, so it asks. */
  async beforeUpload(
    files: readonly string[],
    pageUrl: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!(await this.deps.confirmUpload(files, originOf(pageUrl), signal ?? this.quiet))) {
      throw new ComputerUseRefusal('The user did not allow uploading those files.')
    }
  }

  /** Brings the chat's tab forward, for what only the user can do on it. */
  async showToUser(id: string): Promise<void> {
    const tabId = this.chats.get(id)?.current
    if (tabId !== undefined) {
      await this.deps.bridge.send('showTab', { tabId }, this.quiet).catch(() => undefined)
    }
  }

  /**
   * "Continue in the tab I have open": the user sees which one, and the model sees nothing until they say
   * yes. The tab's id, for the browser tools to take it on.
   */
  async shareMyTab(signal: AbortSignal): Promise<number> {
    const tab = await this.deps.bridge.send<ChromeTab>('activeTab', {}, signal)
    const origin = refuseUnsafe(tab.url)
    if (!(await this.deps.confirmSharedTab({ title: tab.title, url: tab.url }, signal))) {
      throw new ComputerUseRefusal(
        'The user did not share that tab. Ask them to go to the one they meant, or to say what to do.'
      )
    }
    this.chat(this.currentChat()).sites.add(origin)
    return tab.id
  }
}
