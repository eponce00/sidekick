import { AsyncLocalStorage } from 'async_hooks'
import { ComputerUseRefusal, soundsRisky } from './computerUseService'
import type { NativeBrowserPolicy, NativeBrowserSurface } from './nativeBrowserSessionService'

const WAIT_FOR_CHROME_MS = 35_000
const PREVIEW_EVERY_MS = 3_000
const NOTIFY_EVERY_MS = 30 * 60_000

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
  /\b(cookies?|localStorage|sessionStorage|indexedDB|caches|credentials|eval|Function|Reflect|getOwnPropertyDescriptors?|__lookupGetter__|__proto__|prototype|constructor|with|await|async|then)\b/

/**
 * Whether a script can be left to Chromium's check, as far as its words go. Failing here only costs the agent
 * a script, so anything that could be naming a property some other way does.
 */
export function readsLikeALook(expression: string): boolean {
  if (/\\u|\\x/.test(expression)) return false
  // Words in a string are only words, as in a button's "Accept cookies", unless they pick a property.
  for (const picked of expression.matchAll(/\[\s*(['"])(.*?)\1\s*\]/g)) {
    if (NOT_A_LOOK.test(picked[2])) return false
  }
  const code = expression
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
    // A pattern, where one can start. After a value the same marks would be dividing, and hide what's between.
    .replace(/([(,=:!&|?{;]\s*|^\s*)\/(?![*/])(?:[^/\\\n]|\\.)+\/[a-z]*/g, "$1''")
  if (NOT_A_LOOK.test(code)) return false
  // The inside of each [ that picks a property, or names one in an object. After one of these words it's a list.
  for (const bracket of code.matchAll(/([\w$]+|[)\]`'])?\s*\[([^\]]*)\](\s*:)?/g)) {
    if (bracket[3]) return false
    if (/^(return|typeof|void|yield|case|in|of)$/.test(bracket[1] ?? '')) continue
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
    /** Whether the picture of the tab is showing, so that a new one would be seen. */
    wantsPreview: () => boolean
    replyEnded: () => void
    notify: () => void
    /** Asks the user to come and do something on the tab, which `show` brings forward. */
    askForUser: (show: () => void) => void
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
  /** Chats whose reply is still driving, and so what stopping stops. */
  private readonly driving = new Set<string>()
  /** Stopped by the user. Their reply gets nowhere from here, whatever the model tries. */
  private readonly stopped = new Set<string>()
  private lastPreviewAt = 0
  private previewTimer: ReturnType<typeof setTimeout> | null = null
  private stepsRunning = 0
  private notifiedAt = 0
  private readonly quiet = new AbortController().signal

  /** No question about it: nobody should be asked to judge code, and the page tools do the rest. */
  readonly scriptRefusal =
    "That script wasn't run. In the user's own Chrome a script can only look at a page, and this one could change something, reach cookies, saved site data or a filled-in password, or use something that can't be checked as safe, such as object spread, atob, or creating an element. To search the page's words use browser_observe with text and find, and to act use browser_click, browser_type or browser_scroll."

  /** SideKick's stored logins are for its own browser. Chrome has the user's own. */
  readonly signInRefusal =
    "SideKick's stored logins aren't used in Chrome, which fills in the user's saved passwords itself. If it doesn't here, ask the user to sign in."

  constructor(private readonly deps: ChromeUseDependencies) {}

  /** Runs a browser tool as this chat's, so the rules know whose answers apply. */
  async runInChat<T>(chat: string, work: () => Promise<T>): Promise<T> {
    this.stepsRunning++
    try {
      return await this.running.run(chat, work)
    } finally {
      this.stepsRunning--
    }
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
        'The user stopped this, so nothing was done. Do not continue: tell them how far you got.'
      )
    }
  }

  /** Each step renews the marks, as a page that has moved on has lost its own. */
  private async markDriving(id: string, chat: ChromeChat, tabId: number): Promise<void> {
    this.driving.add(id)
    chat.tabs.add(tabId)
    chat.current = tabId
    // Once in a while rather than per chat: the picture says so every time, and this interrupts.
    if (Date.now() - this.notifiedAt >= NOTIFY_EVERY_MS) {
      this.notifiedAt = Date.now()
      this.deps.overlay.notify()
    }
    // The marks and the debugger stay until the reply ends: a slow model's turn is no reason to take the
    // picture away and start it over. This is a tab in the background, so Esc stays with whatever the
    // user is doing: other apps use it, and it would stop the agent instead of reaching them.
    this.deps.overlay.show()
    this.keepPictureFresh()
    const accent = await this.deps.overlay.accent()
    await this.deps.bridge.send('overlay', { tabId, accent }, this.quiet).catch(() => undefined)
  }

  private takeMarksOff(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.deps.overlay.hide()
    const tabIds = [...this.chats.values()].flatMap((chat) => [...chat.tabs])
    void this.deps.bridge.send('overlaysOff', { tabIds }, this.quiet).catch(() => undefined)
    void this.deps.bridge.send('detachAll', {}, this.quiet).catch(() => undefined)
  }

  /** The model can think for a long while between steps, and the page goes on changing. */
  private keepPictureFresh(): void {
    if (this.previewTimer) return
    this.previewTimer = (this.deps.setTimer ?? setTimeout)(() => {
      this.previewTimer = null
      if (!this.driving.size) return
      // A step gets its own picture when it's done, and a capture would only hold it up.
      if (!this.stepsRunning) for (const id of this.driving) void this.refreshPreview(id)
      this.keepPictureFresh()
    }, PREVIEW_EVERY_MS)
  }

  /** The user's stop: everything those chats were allowed ends now, and asking again takes their answer. */
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

  /**
   * Most steps don't take a picture, so the corner one is kept fresh by itself: only while it's showing, and
   * not often, as a capture holds up the step after it.
   */
  async refreshPreview(id: string): Promise<void> {
    const tabId = this.chats.get(id)?.current
    const now = Date.now()
    if (tabId === undefined || !this.driving.has(id) || !this.deps.overlay.wantsPreview()) return
    if (now - this.lastPreviewAt < PREVIEW_EVERY_MS) return
    this.lastPreviewAt = now
    const shot = await this.deps.bridge
      .send<{ data: string }>('preview', { tabId }, this.quiet)
      .catch(() => null)
    // It may have been stopped while the picture was on its way.
    if (shot?.data && this.driving.has(id)) this.deps.overlay.preview(shot)
  }

  /** The picture the agent just took of a tab, for the corner label. */
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

  /** Asks the user over to the chat's tab, for what only they can do on it. */
  showToUser(id: string): void {
    const tabId = this.chats.get(id)?.current
    if (tabId === undefined) return
    this.deps.overlay.askForUser(() => {
      void this.deps.bridge.send('showTab', { tabId }, this.quiet).catch(() => undefined)
    })
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
