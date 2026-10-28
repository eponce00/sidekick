import { useEffect, useId, useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Info, Loader2, RefreshCw, Smartphone, X } from 'lucide-react'
import type { CompanionDevice, CompanionStatus } from '../../../shared/companion'
import { useModalDialog } from '../hooks/useModalDialog'
import type { PhoneCompanion } from '../hooks/usePhoneCompanionStatus'
import {
  deviceActivity,
  formatCountdown,
  phonePopoverPosition,
  qrPixelSize,
  qrRects,
  qrUnits,
  type PhonePopoverPlacement,
  type PhonePopoverPosition
} from '../utils/phoneCompanion'
import { SettingsSwitch } from './SettingsLayout'
import './PhoneCompanionPanel.css'

interface PhoneCompanionPanelProps {
  isOpen: boolean
  companion: PhoneCompanion
  /** The sidebar button the popover opens from; clicks on it toggle rather than dismiss. */
  anchorRef: RefObject<HTMLElement | null>
  /** Above the button in the full sidebar, beside it in the collapsed rail. */
  placement: PhonePopoverPlacement
  onClose: () => void
}

// Phone cameras read dark-on-light codes most reliably, so the code keeps these colors in both
// themes instead of following the design tokens.
const QR_DARK = '#111111'
const QR_LIGHT = '#ffffff'
const QR_FRAME = 176

const REMOVE_CONFIRM_MS = 3000

const CERTIFICATE_NOTE =
  'SideKick makes its own certificate, so the page can use your phone’s microphone; phones do not know it, so they warn. Your chats stay encrypted with keys only this computer and your phone hold.'

const SAFETY_NOTE =
  'Turn this on only on Wi-Fi you trust, like home. Anyone who can tamper with your network could interfere with the page as it loads.'

export default function PhoneCompanionPanel({
  isOpen,
  ...props
}: PhoneCompanionPanelProps): React.JSX.Element | null {
  if (!isOpen) return null
  // The sidebar clips its content, so the popover draws over the page from the body instead.
  return createPortal(<PhonePopover {...props} />, document.body)
}

function PhonePopover({
  companion,
  anchorRef,
  placement,
  onClose
}: Omit<PhoneCompanionPanelProps, 'isOpen'>): React.JSX.Element {
  const popoverRef = useModalDialog<HTMLDivElement>(true, onClose)
  const titleId = useId()
  const [position, setPosition] = useState<PhonePopoverPosition | null>(null)
  const { status, actionError, busy, refresh, setEnabled, newCode, removeDevice } = companion

  // Change events keep the status current, but one may have been missed while the window slept.
  useEffect(() => refresh(), [refresh])

  useLayoutEffect(() => {
    const place = (): void => {
      const anchor = anchorRef.current
      if (!anchor) return
      setPosition(
        phonePopoverPosition(anchor.getBoundingClientRect(), placement, {
          width: window.innerWidth,
          height: window.innerHeight
        })
      )
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef, placement])

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [anchorRef, onClose, popoverRef])

  const enabled = status?.enabled ?? false
  const error = status?.error ?? actionError
  const devices = status?.devices ?? []
  const safety = status?.address ? `${SAFETY_NOTE}\n\nAddress: ${status.address}` : SAFETY_NOTE

  return (
    <div
      ref={popoverRef}
      className={`phone-popover is-${placement}`}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={
        position
          ? { left: position.left, bottom: position.bottom, maxHeight: position.maxHeight }
          : { visibility: 'hidden' }
      }
    >
      <div className="phone-popover-header">
        <h2 id={titleId}>Phone</h2>
        <SettingsSwitch
          checked={enabled}
          disabled={!status || busy}
          label="Phone access"
          onChange={setEnabled}
        />
      </div>

      {error ? (
        <p className="phone-popover-error" role="alert">
          {error}
        </p>
      ) : (
        !enabled && <p className="phone-popover-hint">Open your chats on a phone on this Wi-Fi.</p>
      )}

      {status?.enabled && !status.error && (
        <Pairing status={status} busy={busy} onNewCode={newCode} />
      )}

      {devices.length > 0 && (
        <section className="phone-popover-devices" aria-labelledby={`${titleId}-devices`}>
          <h3 id={`${titleId}-devices`} className="section-heading">
            Phones
          </h3>
          <ul>
            {devices.map((device) => (
              <PairedPhoneRow
                key={device.id}
                device={device}
                busy={busy}
                onRemove={() => removeDevice(device.id)}
              />
            ))}
          </ul>
        </section>
      )}

      <p className="phone-popover-footer" title={safety}>
        <Info size={12} aria-hidden="true" />
        <span aria-hidden="true">Only on Wi-Fi you trust.</span>
        <span className="phone-popover-visually-hidden">{safety}</span>
      </p>
    </div>
  )
}

function Pairing({
  status,
  busy,
  onNewCode
}: {
  status: CompanionStatus
  busy: boolean
  onNewCode: () => void
}): React.JSX.Element {
  if (status.awaitingApproval) {
    const { name, address } = status.awaitingApproval
    return (
      <div className="phone-popover-waiting" role="status" title={address}>
        <Loader2 size={16} className="icon-spin" aria-hidden="true" />
        <p>Allow “{name}” on this computer</p>
      </div>
    )
  }
  if (!status.pairing) {
    return (
      <div className="phone-popover-pairing">
        <div className="phone-popover-qr is-expired">
          <NewCodeButton busy={busy} onClick={onNewCode} />
        </div>
      </div>
    )
  }
  return (
    <PairingCode
      // A new code restarts the countdown's clock.
      key={status.pairing.url}
      pairing={status.pairing}
      busy={busy}
      onNewCode={onNewCode}
    />
  )
}

function PairingCode({
  pairing,
  busy,
  onNewCode
}: {
  pairing: NonNullable<CompanionStatus['pairing']>
  busy: boolean
  onNewCode: () => void
}): React.JSX.Element {
  // Mounted only while a code shows, so the clock starts fresh each time the popover opens.
  const [now, setNow] = useState(() => Date.now())
  const remaining = pairing.expiresAt - now
  const expired = remaining <= 0
  useEffect(() => {
    if (expired) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expired])

  return (
    <div className="phone-popover-pairing">
      <div className={`phone-popover-qr${expired ? ' is-expired' : ''}`}>
        <QrCode modules={pairing.modules} hidden={expired} />
        {expired && <NewCodeButton busy={busy} onClick={onNewCode} />}
      </div>
      {expired ? (
        <p className="phone-popover-caption">This code expired</p>
      ) : (
        <p className="phone-popover-caption">
          <span>Scan with your phone’s camera</span>
          <span className="phone-popover-countdown" title="Time left on this code">
            {formatCountdown(remaining)}
          </span>
          <button
            type="button"
            className="phone-popover-icon-button"
            onClick={onNewCode}
            disabled={busy}
            aria-label="New code"
            title="New code"
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </p>
      )}
      {!expired && (
        <p className="phone-popover-note" title={CERTIFICATE_NOTE}>
          If it says the connection isn’t private, open the details and continue.
        </p>
      )}
    </div>
  )
}

function QrCode({ modules, hidden }: { modules: boolean[][]; hidden: boolean }): React.JSX.Element {
  const units = qrUnits(modules)
  const size = qrPixelSize(units, QR_FRAME)
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${units} ${units}`}
      shapeRendering="crispEdges"
      // An expired code is only a faint outline in the theme's colors behind the button over it.
      {...(hidden
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': 'QR code for pairing a phone' })}
    >
      {!hidden && <rect width={units} height={units} fill={QR_LIGHT} />}
      {qrRects(modules).map(({ x, y, width }) => (
        <rect
          key={`${x},${y}`}
          x={x}
          y={y}
          width={width}
          height={1}
          fill={hidden ? 'currentColor' : QR_DARK}
        />
      ))}
    </svg>
  )
}

function NewCodeButton({
  busy,
  onClick
}: {
  busy: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="settings-secondary-action is-small phone-popover-new-code"
      onClick={onClick}
      disabled={busy}
    >
      <RefreshCw size={13} aria-hidden="true" />
      New code
    </button>
  )
}

function PairedPhoneRow({
  device,
  busy,
  onRemove
}: {
  device: CompanionDevice
  busy: boolean
  onRemove: () => void
}): React.JSX.Element {
  // Removing asks once inline, so a stray click cannot forget a phone.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), REMOVE_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirming])

  return (
    <li
      className={`phone-popover-device${confirming ? ' is-confirming' : ''}`}
      title={device.lastAddress ?? undefined}
    >
      <Smartphone size={14} aria-hidden="true" />
      <span className="phone-popover-device-name">{device.name}</span>
      <span className="phone-popover-device-status">
        {device.connected && <span className="phone-popover-device-dot" aria-hidden="true" />}
        {deviceActivity(device)}
      </span>
      <button
        type="button"
        className={confirming ? 'phone-popover-remove-confirm' : 'phone-popover-icon-button'}
        disabled={busy}
        aria-label={confirming ? `Confirm removing ${device.name}` : `Remove ${device.name}`}
        title={confirming ? undefined : 'Remove'}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            return
          }
          setConfirming(false)
          onRemove()
        }}
      >
        {confirming ? 'Remove' : <X size={14} aria-hidden="true" />}
      </button>
    </li>
  )
}
