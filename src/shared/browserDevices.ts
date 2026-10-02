/**
 * Standard viewports for the shared browser, after the device list in Chrome's device toolbar.
 * Phones and tablets also switch on mobile layout, touch, and a mobile user agent.
 */
export interface BrowserDevicePreset {
  id: string
  label: string
  group: 'Phone' | 'Tablet' | 'Laptop' | 'Desktop'
  width: number
  height: number
  mobile: boolean
}

export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', group: 'Phone', width: 375, height: 667, mobile: true },
  {
    id: 'iphone-14-pro',
    label: 'iPhone 14 Pro',
    group: 'Phone',
    width: 393,
    height: 852,
    mobile: true
  },
  { id: 'pixel-7', label: 'Pixel 7', group: 'Phone', width: 412, height: 915, mobile: true },
  { id: 'ipad-mini', label: 'iPad Mini', group: 'Tablet', width: 768, height: 1024, mobile: true },
  { id: 'ipad-air', label: 'iPad Air', group: 'Tablet', width: 820, height: 1180, mobile: true },
  {
    id: 'ipad-pro',
    label: 'iPad Pro 12.9"',
    group: 'Tablet',
    width: 1024,
    height: 1366,
    mobile: true
  },
  { id: 'laptop', label: 'Laptop', group: 'Laptop', width: 1280, height: 800, mobile: false },
  { id: 'laptop-l', label: 'Laptop L', group: 'Laptop', width: 1440, height: 900, mobile: false },
  { id: 'desktop', label: 'Desktop', group: 'Desktop', width: 1920, height: 1080, mobile: false }
]

/** The default: the page lays out at the panel's own size, like a normal browser window. */
export const BROWSER_RESPONSIVE_DEVICE = 'responsive'

export function browserDevicePreset(id: string | undefined): BrowserDevicePreset | undefined {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id)
}

/** A fixed viewport in effect, and who chose it; absent while the page is responsive. */
export interface BrowserDeviceState {
  /** A preset id, or `custom` for explicit dimensions. */
  id: string
  label: string
  width: number
  height: number
  source: 'user' | 'agent'
}
