import qrcode from 'qrcode-generator'
import type { CompanionAPI, CompanionStatus } from '../../../shared/companion'

const PREVIEW_ADDRESS = 'http://192.168.1.20:47615'
const PREVIEW_CODE_LIFETIME_MS = 2 * 60_000

function previewPairing(): NonNullable<CompanionStatus['pairing']> {
  const url = `${PREVIEW_ADDRESS}/#pair=${Math.random().toString(36).slice(2, 12)}`
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  const count = code.getModuleCount()
  const modules = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => code.isDark(row, column))
  )
  return { url, modules, expiresAt: Date.now() + PREVIEW_CODE_LIFETIME_MS }
}

function previewDevices(now: number): CompanionStatus['devices'] {
  return [
    {
      id: 'preview-phone-pixel',
      name: 'Pixel 9',
      createdAt: now - 3 * 86_400_000,
      lastSeenAt: now,
      lastAddress: '192.168.1.42',
      connected: true
    },
    {
      id: 'preview-phone-iphone',
      name: 'iPhone',
      createdAt: now - 21 * 86_400_000,
      lastSeenAt: now - 6 * 86_400_000,
      lastAddress: '192.168.1.57',
      connected: false
    }
  ]
}

/**
 * The state the preview starts in, so each one can be reviewed: `?phone=off`, `expired`,
 * `waiting` or `error` (a code otherwise), and `&phones=none` for no paired phones.
 */
function previewStatus(search: string): CompanionStatus {
  const params = new URLSearchParams(search)
  const now = Date.now()
  const devices = params.get('phones') === 'none' ? [] : previewDevices(now)
  const on: CompanionStatus = {
    enabled: true,
    error: null,
    address: PREVIEW_ADDRESS,
    pairing: previewPairing(),
    awaitingApproval: null,
    devices
  }
  const off: CompanionStatus = { ...on, enabled: false, address: null, pairing: null }
  switch (params.get('phone')) {
    case 'off':
      return off
    case 'error':
      return {
        ...off,
        error: 'This computer is not on a local network. Connect to Wi-Fi and try again.'
      }
    case 'expired':
      return { ...on, pairing: { ...previewPairing(), expiresAt: now - 1 } }
    case 'waiting':
      return { ...on, pairing: null, awaitingApproval: { name: 'iPhone', address: '192.168.1.57' } }
    default:
      return on
  }
}

/** Phone access for the renderer preview: one phone connected now and one used last week. */
export function previewCompanionApi(): CompanionAPI {
  let status = previewStatus(window.location.search)
  const listeners = new Set<(status: CompanionStatus) => void>()
  const change = (update: Partial<CompanionStatus>): CompanionStatus => {
    status = { ...status, ...update }
    for (const listener of listeners) listener(status)
    return status
  }

  return {
    status: async () => status,
    setEnabled: async (enabled) =>
      // Turning access off closes every phone's connection, as the real server does.
      enabled
        ? change({ enabled, error: null, address: PREVIEW_ADDRESS, pairing: previewPairing() })
        : change({
            enabled,
            error: null,
            address: null,
            pairing: null,
            awaitingApproval: null,
            devices: status.devices.map((device) =>
              device.connected ? { ...device, connected: false, lastSeenAt: Date.now() } : device
            )
          }),
    newCode: async () => change({ pairing: previewPairing() }),
    removeDevice: async (deviceId) =>
      change({ devices: status.devices.filter(({ id }) => id !== deviceId) }),
    onChanged: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}
