import type { DesktopPlatform } from '../../shared/platform'

export interface MainWindowChromeOptions {
  frame: boolean
  titleBarStyle?: 'default' | 'hiddenInset'
  titleBarOverlay?: boolean
  fullscreenable: boolean
  simpleFullscreen?: boolean
}

/**
 * Keep platform window conventions at the native frame boundary. Windows and
 * Linux use SideKick's existing custom controls; macOS owns its traffic lights,
 * native Spaces full-screen transition, zoom behavior, and focus appearance.
 */
export function mainWindowChrome(platform: DesktopPlatform): MainWindowChromeOptions {
  if (platform === 'macos') {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      fullscreenable: true,
      simpleFullscreen: false
    }
  }
  return {
    frame: false,
    fullscreenable: true
  }
}
