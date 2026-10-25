import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Import,
  Minus,
  MonitorSmartphone,
  Plus,
  Printer,
  Search,
  Settings
} from 'lucide-react'
import {
  BROWSER_DEVICE_PRESETS,
  BROWSER_RESPONSIVE_DEVICE,
  type BrowserDeviceState
} from '../../../shared/browserDevices'
import {
  BROWSER_ZOOM_LEVELS,
  DEFAULT_BROWSER_ZOOM,
  type BrowserZoomStep
} from '../../../shared/browserZoom'

export type BrowserMenuCommand = 'find' | 'print' | 'screenshot' | 'import' | 'settings'

/**
 * The Browser panel's ⋯ menu, as a browser's: find, print, zoom, device size, a screenshot for
 * the agent, importing bookmarks, and settings. Zoom steps keep the menu open, as they do in a
 * browser; any other choice closes it. Device sizes open in the menu's place, since the panel
 * leaves no room beside it.
 */
export function BrowserMenu({
  zoom,
  device,
  canScreenshot,
  onCommand,
  onZoom,
  onDevice,
  onClose
}: {
  zoom: number
  device?: BrowserDeviceState | null
  canScreenshot: boolean
  onCommand: (command: BrowserMenuCommand) => void
  onZoom: (step: BrowserZoomStep) => void
  onDevice: (device: string) => void
  /** `focusButton` when the keyboard closed it, so focus returns to the menu button. */
  onClose: (focusButton: boolean) => void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [devices, setDevices] = useState(false)
  const current = device?.id ?? BROWSER_RESPONSIVE_DEVICE

  // The first item takes focus, or the checked size when the sizes open.
  useEffect(() => {
    const element = menu.current
    ;(
      (devices && element?.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)')) ||
      element?.querySelector<HTMLElement>('button:not(:disabled)')
    )?.focus()
  }, [devices])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('button') ?? [])].filter(
      (item) => !item.hasAttribute('disabled')
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape' || (event.key === 'ArrowLeft' && devices)) {
      event.preventDefault()
      event.stopPropagation()
      if (devices) setDevices(false)
      else onClose(true)
    } else if (event.key === 'Tab') onClose(false)
  }

  const item = (
    command: BrowserMenuCommand,
    label: string,
    icon: React.ReactNode,
    disabled = false
  ): React.JSX.Element => (
    <button
      type="button"
      role="menuitem"
      className="app-menu-item"
      disabled={disabled}
      onClick={() => onCommand(command)}
    >
      <span className="app-menu-mark" aria-hidden="true">
        {icon}
      </span>
      <span className="app-menu-label">{label}</span>
    </button>
  )
  const deviceOption = (id: string, label: string, size?: string): React.JSX.Element => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={current === id}
      className="app-menu-item"
      onClick={() => onDevice(id)}
    >
      <span className="app-menu-mark" aria-hidden="true">
        {current === id && <Check size={14} />}
      </span>
      <span className="app-menu-label">{label}</span>
      {size && <span className="app-menu-shortcut">{size}</span>}
    </button>
  )

  return (
    <div
      ref={menu}
      className="app-menu browser-workspace-menu"
      role="menu"
      aria-label={devices ? 'Device size' : 'Browser menu'}
      onKeyDown={onKeyDown}
    >
      {devices ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="app-menu-item browser-workspace-menu-back"
            onClick={() => setDevices(false)}
          >
            <span className="app-menu-mark" aria-hidden="true">
              <ChevronLeft size={15} />
            </span>
            <span className="app-menu-label">Device size</span>
          </button>
          <div className="app-menu-separator" role="separator" />
          {deviceOption(BROWSER_RESPONSIVE_DEVICE, 'Responsive', 'Fits the panel')}
          {device?.id === 'custom' && (
            <button
              type="button"
              role="menuitemradio"
              aria-checked="true"
              className="app-menu-item"
              disabled
            >
              <span className="app-menu-mark" aria-hidden="true">
                <Check size={14} />
              </span>
              <span className="app-menu-label">{device.label}, set by the agent</span>
            </button>
          )}
          {(['Phone', 'Tablet', 'Laptop', 'Desktop'] as const).map((group) => (
            <div key={group} role="group" aria-label={group}>
              <div className="app-menu-heading" role="presentation">
                {group}
              </div>
              {BROWSER_DEVICE_PRESETS.filter((preset) => preset.group === group).map((preset) =>
                deviceOption(preset.id, preset.label, `${preset.width} × ${preset.height}`)
              )}
            </div>
          ))}
        </>
      ) : (
        <>
          {item('find', 'Find in page', <Search size={15} />)}
          {item('print', 'Print…', <Printer size={15} />)}
          <div className="app-menu-separator" role="separator" />
          <div className="browser-workspace-menu-zoom" role="group" aria-label="Zoom">
            <span className="app-menu-label">Zoom</span>
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out (Ctrl −)"
              disabled={zoom <= BROWSER_ZOOM_LEVELS[0]}
              onClick={() => onZoom('out')}
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              className="browser-workspace-menu-zoom-level"
              aria-label={`Zoom ${zoom}%. Reset to 100%`}
              title="Back to 100% (Ctrl 0)"
              disabled={zoom === DEFAULT_BROWSER_ZOOM}
              onClick={() => onZoom('reset')}
            >
              {zoom}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (Ctrl +)"
              disabled={zoom >= BROWSER_ZOOM_LEVELS[BROWSER_ZOOM_LEVELS.length - 1]}
              onClick={() => onZoom('in')}
            >
              <Plus size={14} />
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            className="app-menu-item"
            onClick={() => setDevices(true)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return
              event.preventDefault()
              setDevices(true)
            }}
          >
            <span className="app-menu-mark" aria-hidden="true">
              <MonitorSmartphone size={15} />
            </span>
            <span className="app-menu-label">Device size</span>
            <span className="app-menu-shortcut">{device ? device.label : 'Responsive'}</span>
            <ChevronRight size={13} className="app-menu-chevron" aria-hidden="true" />
          </button>
          <div className="app-menu-separator" role="separator" />
          {item('screenshot', 'Take a screenshot', <Camera size={15} />, !canScreenshot)}
          <div className="app-menu-separator" role="separator" />
          {item('import', 'Import bookmarks and history…', <Import size={15} />)}
          {item('settings', 'Browser settings', <Settings size={15} />)}
        </>
      )}
    </div>
  )
}
