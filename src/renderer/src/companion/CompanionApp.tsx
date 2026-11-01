import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { CompanionChat, CompanionEvent, CompanionProject } from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import { ChatDrawer } from './ChatDrawer'
import { ChatView } from './ChatView'
import {
  CompanionClient,
  CompanionForgottenError,
  CompanionPairingError,
  forgetDevice,
  pair,
  type StoredDevice
} from './companionClient'
import { homeSuggestions } from './homeSuggestions'
import { entryState, HOME, readEntry, releaseLayers, type ShownChat } from './navigation'
import { bindPhoneApi, dispatchToPhoneApi } from './phoneApi'
import { refreshPhoneVoice } from './phoneVoice'
import { Robot } from './Robot'

export interface CompanionBoot {
  /** The one-time secret from a scanned code. */
  secret: Uint8Array | null
  device: StoredDevice | null
  /** The preview's fake computer, used instead of pairing, or one of the screens before it. */
  preview?: {
    device: StoredDevice
    connection: CompanionConnection
    screen?: 'start' | 'pairing' | 'denied'
    /** Opens the chat drawer at once, for screenshots. */
    drawer?: boolean
  }
}

type Pair = (secret: Uint8Array) => Promise<StoredDevice>

type Screen =
  | { kind: 'pairing'; secret: Uint8Array; pair: Pair }
  | { kind: 'start'; notice?: string }
  | { kind: 'ready'; device: StoredDevice; connection: CompanionConnection; drawer?: boolean }

const REMOVED_NOTICE = 'This phone was removed on the computer.'

// The start screen says how to scan a new code, so only what it does not say is added.
const PAIRING_HINTS: Record<CompanionPairingError['reason'], string> = {
  denied: '',
  expired: '',
  unreachable:
    'Check that this phone is on the same Wi-Fi network as the computer, then scan the code again.',
  failed: ''
}

function pairingNotice(error: unknown): string {
  if (error instanceof CompanionPairingError) {
    return [error.message, PAIRING_HINTS[error.reason]].filter(Boolean).join(' ')
  }
  return 'Pairing did not work. Scan a new code.'
}

function initialScreen(boot: CompanionBoot): Screen {
  if (boot.preview) {
    const { screen, device, connection } = boot.preview
    if (screen === 'start') return { kind: 'start' }
    if (screen === 'denied')
      return {
        kind: 'start',
        notice: pairingNotice(
          new CompanionPairingError('denied', 'The computer did not allow this phone.')
        )
      }
    // The preview's computer never answers, so its pairing screen stays up.
    if (screen === 'pairing')
      return { kind: 'pairing', secret: new Uint8Array(), pair: () => new Promise(() => {}) }
    return { kind: 'ready', device, connection, drawer: boot.preview.drawer }
  }
  if (boot.secret) return { kind: 'pairing', secret: boot.secret, pair }
  if (boot.device)
    return { kind: 'ready', device: boot.device, connection: new CompanionClient(boot.device) }
  return { kind: 'start' }
}

const SCAN_INSTRUCTION =
  'On your computer, click the phone icon at the bottom of the sidebar and scan the code.'

function StartScreen({ notice }: { notice?: string }) {
  return (
    <div className="cp-screen cp-center">
      <Robot />
      <h1>SideKick on your phone</h1>
      {notice && (
        <p className="cp-center-error" role="alert">
          {notice}
        </p>
      )}
      <p>{SCAN_INSTRUCTION}</p>
    </div>
  )
}

function PairingScreen({
  secret,
  pair,
  onPaired,
  onFailed
}: {
  secret: Uint8Array
  pair: Pair
  onPaired: (device: StoredDevice) => void
  onFailed: (notice: string) => void
}) {
  useEffect(() => {
    let current = true
    pair(secret).then(
      (device) => current && onPaired(device),
      (error: unknown) => current && onFailed(pairingNotice(error))
    )
    return () => {
      current = false
    }
  }, [secret, pair, onPaired, onFailed])
  return (
    <div className="cp-screen cp-center">
      <Robot />
      <h1>Allow this phone on your computer</h1>
      <p className="cp-center-status" role="status">
        <Loader2 size={15} className="icon-spin" aria-hidden="true" />
        Waiting for your answer…
      </p>
    </div>
  )
}

interface View {
  /** The history entry the chat is shown at; a new one remounts the chat. */
  nav: number
  chat: ShownChat
}

/**
 * Keeps the page inside the part of the screen the keyboard leaves, so the message box sits just
 * above it. Android resizes the page itself; iOS only shrinks the visual viewport and pans it.
 */
function useKeyboardViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = (): void => {
      root.style.setProperty('--cp-viewport-height', `${Math.round(viewport.height)}px`)
      root.style.setProperty('--cp-viewport-top', `${Math.round(viewport.offsetTop)}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty('--cp-viewport-height')
      root.style.removeProperty('--cp-viewport-top')
    }
  }, [])
}

function Connected({
  device,
  connection,
  initialDrawer = false,
  onForget,
  onRemoved
}: {
  device: StoredDevice
  connection: CompanionConnection
  initialDrawer?: boolean
  onForget: () => void
  onRemoved: () => void
}) {
  const [chats, setChats] = useState<CompanionChat[] | null>(null)
  const [projects, setProjects] = useState<CompanionProject[]>([])
  const [listError, setListError] = useState('')
  // Null until the stream first opens.
  const [online, setOnline] = useState<boolean | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [view, setView] = useState<View>({ nav: 0, chat: HOME })
  const [drawerOpen, setDrawerOpen] = useState(initialDrawer)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const listeners = useRef(new Set<(event: CompanionEvent) => void>())
  const nextNav = useRef(1)
  const shownNav = useRef(0)
  const refreshing = useRef<{ again: boolean } | null>(null)
  useKeyboardViewport()

  const onFailure = useCallback(
    (error: unknown): string | null => {
      if (error instanceof CompanionForgottenError) {
        onRemoved()
        return null
      }
      return error instanceof Error && error.message
        ? error.message
        : 'The computer did not answer. Check that SideKick is open.'
    },
    [onRemoved]
  )

  // Changes can arrive faster than the list loads; one more load after the current one covers them.
  const refreshList = useCallback(async () => {
    if (refreshing.current) {
      refreshing.current.again = true
      return
    }
    refreshing.current = { again: false }
    try {
      do {
        refreshing.current.again = false
        const next = await connection.call('chats.list', {})
        setChats(next)
        setListError('')
      } while (refreshing.current.again)
    } catch (error) {
      const message = onFailure(error)
      if (message) setListError(message)
    } finally {
      refreshing.current = null
    }
  }, [connection, onFailure])

  // Projects change rarely, and listing them asks Git about each folder, so once per connection
  // and when the drawer opens.
  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await connection.call('projects.list', {}))
    } catch {
      /* The drawer keeps the projects it has. */
    }
  }, [connection])

  useEffect(() => {
    void refreshList()
    void refreshProjects()
  }, [refreshList, refreshProjects, reconnects])

  // The desktop's components on the phone reach the computer through this connection.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    bindPhoneApi(connection, (text) => {
      setNotice(text)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setNotice(''), 4_000)
    })
    return () => {
      if (timer) clearTimeout(timer)
      bindPhoneApi(null)
      void refreshPhoneVoice(null)
    }
  }, [connection])

  useEffect(() => {
    let opened = false
    connection.listen(
      (event) => {
        if (event.type === 'chats.changed') void refreshList()
        dispatchToPhoneApi(event)
        for (const listener of listeners.current) listener(event)
      },
      (open) => {
        setOnline(open)
        // Events sent while the stream was down are lost, so everything on screen reloads.
        if (open && opened) setReconnects((count) => count + 1)
        if (open) {
          opened = true
          void refreshPhoneVoice(connection)
        }
      }
    )
    return () => connection.close()
  }, [connection, refreshList])

  const subscribe = useCallback((listener: (event: CompanionEvent) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  // The page opens on the new-chat home; back from there leaves it, as it would any page. Runs
  // before the drawer's own entry, which a preview can open at once.
  useLayoutEffect(() => {
    history.replaceState(entryState({ nav: 0, chat: HOME, layer: 0 }), '')
  }, [])

  // Back closes a sheet or the drawer first (see navigation.ts), then shows the chat before.
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      const entry = readEntry(event.state) ?? { nav: 0, chat: HOME, layer: 0 }
      if (entry.nav === shownNav.current) return
      shownNav.current = entry.nav
      setView({ nav: entry.nav, chat: entry.chat })
      void refreshList()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [refreshList])

  const show = useCallback(
    (chat: ShownChat): void => {
      const nav = nextNav.current++
      const entry = entryState({ nav, chat, layer: 0 })
      // Picked in the drawer: the drawer's entry becomes the chat's, so back skips the drawer.
      if (readEntry(history.state)?.layer) {
        releaseLayers()
        history.replaceState(entry, '')
      } else history.pushState(entry, '')
      shownNav.current = nav
      setView({ nav, chat })
      void refreshList()
    },
    [refreshList]
  )
  const openChat = useCallback(
    (chat: CompanionChat) => {
      if (chat.id === view.chat.id) setDrawerOpen(false)
      else show({ id: chat.id, title: chat.title })
    },
    [show, view.chat.id]
  )
  const newChat = useCallback(() => {
    if (view.chat.id === null && !view.chat.projectId) setDrawerOpen(false)
    else show(HOME)
  }, [show, view.chat.id, view.chat.projectId])
  const newChatIn = useCallback(
    (project: CompanionProject) => {
      if (view.chat.id === null && view.chat.projectId === project.id) setDrawerOpen(false)
      else show({ ...HOME, projectId: project.id })
    },
    [show, view.chat.id, view.chat.projectId]
  )
  const onCreated = useCallback(
    (id: string) => {
      // The home's entry now holds the chat it started; the chat itself stays mounted.
      const entry = readEntry(history.state)
      if (entry && entry.nav === shownNav.current && !entry.layer)
        history.replaceState(entryState({ ...entry, chat: { id, title: '' } }), '')
      setView((current) => ({ ...current, chat: { id, title: '' } }))
      void refreshList()
    },
    [refreshList]
  )
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  // Shown once the chats are in, so the pills do not change under a finger as they arrive.
  const suggestions = useMemo(() => (chats ? homeSuggestions(chats) : []), [chats])

  return (
    <div className="cp-app">
      {online !== true && (
        <div className="cp-connection" role="status">
          <Loader2 size={13} className="icon-spin" aria-hidden="true" />
          {online === null ? 'Connecting…' : 'Reconnecting…'}
        </div>
      )}
      {notice && (
        <div className="cp-toast" role="status">
          {notice}
        </div>
      )}
      <ChatView
        key={view.nav}
        connection={connection}
        conversationId={view.chat.id}
        fallbackTitle={view.chat.title}
        subscribe={subscribe}
        reconnects={reconnects}
        suggestions={suggestions}
        projects={projects}
        startIn={view.chat.projectId ?? null}
        onMenu={() => {
          setDrawerOpen(true)
          void refreshList()
          void refreshProjects()
        }}
        onNew={newChat}
        onOpenChat={openChat}
        onCreated={onCreated}
        onFailure={onFailure}
      />
      <ChatDrawer
        open={drawerOpen}
        chats={chats}
        projects={projects}
        error={listError}
        currentId={view.chat.id}
        collapsed={collapsed}
        onToggle={toggle}
        host={window.location.host}
        online={online}
        deviceName={device.name}
        onOpen={openChat}
        onNew={newChat}
        onNewInProject={newChatIn}
        onClose={closeDrawer}
        onForget={onForget}
      />
    </div>
  )
}

export default function CompanionApp({ boot }: { boot: CompanionBoot }) {
  const [screen, setScreen] = useState<Screen>(() => initialScreen(boot))
  const onPaired = useCallback((device: StoredDevice) => {
    setScreen({ kind: 'ready', device, connection: new CompanionClient(device) })
  }, [])
  const onPairingFailed = useCallback((notice: string) => {
    setScreen({ kind: 'start', notice })
  }, [])
  const onForget = useCallback(() => {
    forgetDevice()
    setScreen({ kind: 'start' })
  }, [])
  const onRemoved = useCallback(() => {
    forgetDevice()
    setScreen({ kind: 'start', notice: REMOVED_NOTICE })
  }, [])

  if (screen.kind === 'pairing')
    return (
      <div className="cp-app">
        <PairingScreen
          secret={screen.secret}
          pair={screen.pair}
          onPaired={onPaired}
          onFailed={onPairingFailed}
        />
      </div>
    )
  if (screen.kind === 'start')
    return (
      <div className="cp-app">
        <StartScreen notice={screen.notice} />
      </div>
    )
  return (
    <Connected
      key={screen.device.deviceId}
      device={screen.device}
      connection={screen.connection}
      initialDrawer={screen.drawer}
      onForget={onForget}
      onRemoved={onRemoved}
    />
  )
}
