export const DESKTOP_PLATFORMS = ['macos', 'windows', 'linux'] as const

export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number]

export function desktopPlatform(value: string): DesktopPlatform {
  if (value === 'darwin') return 'macos'
  if (value === 'win32') return 'windows'
  return 'linux'
}
