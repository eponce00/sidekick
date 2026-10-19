import type { MenuItemConstructorOptions } from 'electron'
import {
  BROWSER_DEVICE_PRESETS,
  BROWSER_RESPONSIVE_DEVICE,
  type BrowserDeviceState
} from '../../shared/browserDevices'

/**
 * The browser's device-size menu, with a check on the size in use only. Its items are checkboxes,
 * not radio items: Electron makes each run of radio items between separators its own group and
 * checks the first item of any group with none checked, so every size group showed a selection.
 */
export function browserDeviceMenuTemplate(
  device: BrowserDeviceState | null | undefined,
  choose: (deviceId: string) => void
): MenuItemConstructorOptions[] {
  const current = device?.id ?? BROWSER_RESPONSIVE_DEVICE
  const option = (id: string, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'checkbox',
    checked: current === id,
    click: () => choose(id)
  })
  return [
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
