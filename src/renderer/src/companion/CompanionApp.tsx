import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Smartphone } from 'lucide-react'
import type { CompanionChat, CompanionEvent } from '../../../shared/companion'
import type { CompanionConnection } from './chatState'
import { ChatList } from './ChatList'
import { ChatView } from './ChatView'
import {
  CompanionClient,
  CompanionForgottenError,
  CompanionPairingError,
  forgetDevice,
  pair,
  type StoredDevice
} from './companionClient'
import { bindPhoneApi, dispatchToPhoneApi } from './phoneApi'
import { refreshPhoneVoice } from './phoneVoice'

export interface CompanionBoot {
  /** The one-time secret from a scanned code. */
  secret: Uint8Array | null
  device: StoredDevice | null
  /** The preview's fake computer, used instead of pairing. */
  preview?: { device: StoredDevice; connection: CompanionConnection }
}

type Screen =
  | { kind: 'pairing'; secret: Uint8Array }
  | { kind: 'start'; notice?: string }
  | { kind: 'ready'; device: StoredDevice; connection: CompanionConnection }

const REMOVED_NOTICE = 'This phone was removed. Scan a new code on the computer.'

const PAIRING_HINTS: Record<CompanionPairingError['reason'], string> = {
  denied: 'If that was a mistake, show a new code on the computer and scan it again.',
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
  if (boot.preview) return { kind: 'ready', ...boot.preview }
  if (boot.secret) return { kind: 'pairing', secret: boot.secret }
  if (boot.device)
    return { kind: 'ready', device: boot.device, connection: new CompanionClient(boot.device) }
  return { kind: 'start' }
}

function StartScreen({ notice }: { notice?: string }) {
  return (
    <div className="cp-screen cp-center">
      <Smartphone size={40} className="cp-center-icon" aria-hidden="true" />
      <h1>SideKick on your phone</h1>
      {notice && (
        <p className="cp-inline-error" role="alert">
          {notice}
        </p>
      )}
      <p>
        Open SideKick on your computer, click the phone icon at the bottom of the sidebar, and scan
        the code.
      </p>
    </div>
  )
}

function PairingScreen({
  secret,
  onPaired,
  onFailed
}: {
  secret: Uint8Array
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
  }, [secret, onPaired, onFailed])
  return (
    <div className="cp-screen cp-center" role="status">
      <Loader2 size={32} className="icon-spin cp-center-icon" aria-hidden="true" />
      <h1>Waiting for you to allow this phone on your computer…</h1>
      <p>Check the computer for a SideKick prompt.</p>
    </div>
  )
}

type View = { kind: 'list' } | { kind: 'chat'; id: string | null; title: string; key: number }

const HISTORY_MARK = 'sidekickCompanionChat'

function Connected({
  device,
  connection,
  onForget,
  onRemoved
}: {
  device: StoredDevice
  connection: CompanionConnection
  onForget: () => void
  onRemoved: () => void
}) {
  const [chats, setChats] = useState<CompanionChat[] | null>(null)
  const [listError, setListError] = useState('')
  // Null until the stream first opens.
  const [online, setOnline] = useState<boolean | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [now, setNow] = useState(() => Date.now())
  const [notice, setNotice] = useState('')
  const listeners = useRef(new Set<(event: CompanionEvent) => void>())
  const nextViewKey = useRef(1)
  const refreshing = useRef<{ again: boolean } | null>(null)

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
        setNow(Date.now())
        setListError('')
      } while (refreshing.current.again)
    } catch (error) {
      const message = onFailure(error)
      if (message) setListError(message)
    } finally {
      refreshing.current = null
    }
  }, [connection, onFailure])

  useEffect(() => {
    void refreshList()
  }, [refreshList, reconnects])

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

  // Ages in the list stay current while it is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const subscribe = useCallback((listener: (event: CompanionEvent) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  // The phone's back gesture returns to the list instead of leaving the page.
  useEffect(() => {
    const onPop = (): void => setView({ kind: 'list' })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const openChat = (id: string | null, title: string): void => {
    history.pushState({ [HISTORY_MARK]: id ?? '' }, '')
    setView({ kind: 'chat', id, title, key: nextViewKey.current++ })
  }
  const back = (): void => {
    if (history.state && HISTORY_MARK in history.state) history.back()
    else setView({ kind: 'list' })
    void refreshList()
  }
  const onCreated = useCallback(
    (id: string) => {
      history.replaceState({ [HISTORY_MARK]: id }, '')
      void refreshList()
    },
    [refreshList]
  )

  return (
    <div className="cp-app">
      {online !== true && (
        <div className="cp-connection" role="status">
          <Loader2 size={14} className="icon-spin" aria-hidden="true" />
          {online === null ? 'Connecting…' : 'Reconnecting…'}
        </div>
      )}
      {notice && (
        <div className="cp-toast" role="status">
          {notice}
        </div>
      )}
      {view.kind === 'chat' ? (
        <ChatView
          key={view.key}
          connection={connection}
          conversationId={view.id}
          fallbackTitle={view.title}
          subscribe={subscribe}
          reconnects={reconnects}
          onBack={back}
          onCreated={onCreated}
          onFailure={onFailure}
        />
      ) : (
        <ChatList
          chats={chats}
          now={now}
          error={listError}
          deviceName={device.name}
          onOpen={(chat) => openChat(chat.id, chat.title)}
          onNew={() => openChat(null, 'New chat')}
          onForget={onForget}
        />
      )}
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
        <PairingScreen secret={screen.secret} onPaired={onPaired} onFailed={onPairingFailed} />
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
      onForget={onForget}
      onRemoved={onRemoved}
    />
  )
}
