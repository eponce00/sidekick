import { useEffect, useId, useState } from 'react'
import { Loader2, RefreshCw, ShieldAlert, Smartphone, Trash2, X } from 'lucide-react'
import type { CompanionDevice, CompanionStatus } from '../../../shared/companion'
import { useModalDialog } from '../hooks/useModalDialog'
import type { PhoneCompanion } from '../hooks/usePhoneCompanionStatus'
import {
  deviceActivity,
  formatCountdown,
  qrPixelSize,
  qrRects,
  qrUnits
} from '../utils/phoneCompanion'
import { SettingsSwitch } from './SettingsLayout'
import './PhoneCompanionPanel.css'

interface PhoneCompanionPanelProps {
  isOpen: boolean
  companion: PhoneCompanion
  onClose: () => void
}

// Phone cameras read dark-on-light codes most reliably, so the code keeps these colors in both
// themes instead of following the design tokens.
const QR_DARK = '#111111'
const QR_LIGHT = '#ffffff'

const REMOVE_CONFIRM_MS = 3000

export default function PhoneCompanionPanel({
  isOpen,
  companion,
  onClose
}: PhoneCompanionPanelProps): React.JSX.Element | null {
  const dialogRef = useModalDialog<HTMLElement>(isOpen, onClose)
  const titleId = useId()
  const descriptionId = useId()
  const { status, actionError, busy, refresh, setEnabled, newCode, removeDevice } = companion

  // Change events keep the status current, but one may have been missed while the window slept.
  useEffect(() => {
    if (isOpen) refresh()
  }, [isOpen, refresh])

  if (!isOpen) return null

  const enabled = status?.enabled ?? false

  return (
    <div className="phone-companion-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="phone-companion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="phone-companion-header">
          <span className="phone-companion-icon">
            <Smartphone size={18} />
          </span>
          <div>
            <h2 id={titleId}>Use SideKick from your phone</h2>
            <p id={descriptionId}>
              Your phone connects to this computer over your Wi-Fi. Nothing goes through the
              internet.
            </p>
          </div>
          <button
            type="button"
            className="phone-companion-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <label className="phone-companion-access">
          <span>
            <strong>Phone access</strong>
            <small>{enabled ? 'On. Phones on this Wi-Fi can pair.' : 'Off'}</small>
          </span>
          <SettingsSwitch
            checked={enabled}
            disabled={!status || busy}
            label="Phone access"
            onChange={setEnabled}
          />
        </label>

        {(status?.error || actionError) && (
          <div className="phone-companion-error" role="alert">
            {status?.error ?? actionError}
          </div>
        )}

        {status?.enabled && <PairingArea status={status} busy={busy} onNewCode={newCode} />}

        <p className="phone-companion-safety">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>
            Turn this on only on Wi-Fi you trust, like home. Anyone who can tamper with your network
            could interfere with the page as it loads.
          </span>
        </p>

        <section className="phone-companion-devices" aria-labelledby={`${titleId}-devices`}>
          <h3 id={`${titleId}-devices`}>Paired phones</h3>
          {status && status.devices.length > 0 ? (
            <ul>
              {status.devices.map((device) => (
                <PairedPhoneRow
                  key={device.id}
                  device={device}
                  busy={busy}
                  onRemove={() => removeDevice(device.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="phone-companion-empty">No phones yet.</p>
          )}
        </section>
      </section>
    </div>
  )
}

function PairingArea({
  status,
  busy,
  onNewCode
}: {
  status: CompanionStatus
  busy: boolean
  onNewCode: () => void
}): React.JSX.Element {
  return (
    <div className="phone-companion-pairing">
      {status.awaitingApproval ? (
        <div className="phone-companion-waiting" role="status">
          <Loader2 size={18} className="icon-spin" aria-hidden="true" />
          <div>
            <p>
              Waiting for you to allow {status.awaitingApproval.name} (
              {status.awaitingApproval.address})…
            </p>
            <small>Answer the prompt on this computer.</small>
          </div>
        </div>
      ) : status.pairing ? (
        <PairingCode
          // A new code restarts the countdown's clock.
          key={status.pairing.url}
          pairing={status.pairing}
          busy={busy}
          onNewCode={onNewCode}
        />
      ) : (
        <div className="phone-companion-expired">
          <p>No code is showing.</p>
          <NewCodeButton busy={busy} onClick={onNewCode} />
        </div>
      )}
      {status.address && (
        <p className="phone-companion-address">
          <code>{status.address}</code>
          <span>Same Wi-Fi only</span>
        </p>
      )}
    </div>
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
  // Mounted only while a code shows, so the clock starts fresh each time the panel opens.
  const [now, setNow] = useState(() => Date.now())
  const remaining = pairing.expiresAt - now
  const expired = remaining <= 0
  useEffect(() => {
    if (expired) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expired])

  if (expired) {
    return (
      <div className="phone-companion-expired">
        <p>This code expired.</p>
        <NewCodeButton busy={busy} onClick={onNewCode} />
      </div>
    )
  }

  return (
    <div className="phone-companion-code">
      <QrCode modules={pairing.modules} />
      <div className="phone-companion-code-text">
        <p>Scan with your phone&apos;s camera.</p>
        <small className="phone-companion-countdown">
          Code expires in {formatCountdown(remaining)}
        </small>
        <NewCodeButton busy={busy} onClick={onNewCode} />
      </div>
    </div>
  )
}

function QrCode({ modules }: { modules: boolean[][] }): React.JSX.Element {
  const units = qrUnits(modules)
  const size = qrPixelSize(units)
  return (
    <div className="phone-companion-qr">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${units} ${units}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="QR code for pairing a phone"
      >
        <rect width={units} height={units} fill={QR_LIGHT} />
        {qrRects(modules).map(({ x, y, width }) => (
          <rect key={`${x},${y}`} x={x} y={y} width={width} height={1} fill={QR_DARK} />
        ))}
      </svg>
    </div>
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
      className="settings-secondary-action is-small"
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
    <li className="phone-companion-device">
      <span
        className={`phone-companion-device-dot${device.connected ? ' is-connected' : ''}`}
        aria-hidden="true"
      />
      <div className="phone-companion-device-text">
        <strong>{device.name}</strong>
        <small>
          {deviceActivity(device)}
          {device.lastAddress && (
            <>
              {' · '}
              <code>{device.lastAddress}</code>
            </>
          )}
        </small>
      </div>
      <button
        type="button"
        className={`${confirming ? 'settings-danger-action' : 'settings-ghost-action'} is-small`}
        disabled={busy}
        aria-label={confirming ? `Confirm removing ${device.name}` : `Remove ${device.name}`}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            return
          }
          setConfirming(false)
          onRemove()
        }}
      >
        <Trash2 size={13} aria-hidden="true" />
        {confirming ? 'Remove?' : 'Remove'}
      </button>
    </li>
  )
}
