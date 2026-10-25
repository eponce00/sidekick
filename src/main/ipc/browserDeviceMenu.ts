import type { MenuItemConstructorOptions } from 'electron'
import {
  BROWSER_DEVICE_PRESETS,
  BROWSER_RESPONSIVE_DEVICE,
  type BrowserDeviceState
} from '../../shared/browserDevices'
import {
  BROWSER_ZOOM_LEVELS,
  DEFAULT_BROWSER_ZOOM,
  type BrowserZoomStep
} from '../../shared/browserZoom'

/**
 * The browser's device-size menu, with a check on the size in use only. Its items are checkboxes,
 * not radio items: Electron makes each run of radio items between separators its own group and
 * checks the first item of any group with none checked, so every size group showed a selection.
 */
export function browserDeviceMenuTemplate(
  device: BrowserDeviceState | null | undefined,
  choose: (deviceId: string) => void,
  zoom?: { percent: number; step: (step: BrowserZoomStep) => void }
): MenuItemConstructorOptions[] {
  const current = device?.id ?? BROWSER_RESPONSIVE_DEVICE
  const option = (id: string, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'checkbox',
    checked: current === id,
    click: () => choose(id)
  })
  const zoomItems: MenuItemConstructorOptions[] = zoom
    ? [
        { label: `Zoom ${zoom.percent}%`, enabled: false },
        {
          label: 'Zoom in',
          accelerator: 'CommandOrControl+=',
          registerAccelerator: false,
          enabled: zoom.percent < BROWSER_ZOOM_LEVELS[BROWSER_ZOOM_LEVELS.length - 1],
          click: () => zoom.step('in')
        },
        {
          label: 'Zoom out',
          accelerator: 'CommandOrControl+-',
          registerAccelerator: false,
          enabled: zoom.percent > BROWSER_ZOOM_LEVELS[0],
          click: () => zoom.step('out')
        },
        {
          label: 'Actual size',
          accelerator: 'CommandOrControl+0',
          registerAccelerator: false,
          enabled: zoom.percent !== DEFAULT_BROWSER_ZOOM,
          click: () => zoom.step('reset')
        },
        { type: 'separator' }
      ]
    : []
  return [
    ...zoomItems,
    option(BROWSER_RESPONSIVE_DEVICE, 'Responsive (fit the panel)'),
    ...(device?.id === 'custom'
      ? [
          {
            label: `${device.label}, set by the agent`,
            type: 'checkbox' as const,
            checked: true,
            enabled: false
          }
        ]
      : []),
    ...(['Phone', 'Tablet', 'Laptop', 'Desktop'] as const).flatMap((group) => [
      { type: 'separator' as const },
      { label: group, enabled: false },
      ...BROWSER_DEVICE_PRESETS.filter((preset) => preset.group === group).map((preset) =>
        option(preset.id, `${preset.label}    ${preset.width} × ${preset.height}`)
      )
    ])
  ]
}
