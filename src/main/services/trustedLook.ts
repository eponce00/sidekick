import { nativeTheme, type BrowserWindow } from 'electron'
import { accentPalette, DARK_ON_ACCENT } from '../../shared/accentPalettes'
import { appState } from '../ipc/state'

/** Text as text: what goes into a trusted window's page is never markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The colours SideKick's own trusted windows (approval dialogs and notices) are drawn in. */
export interface TrustedLook {
  theme: 'light' | 'dark'
  accent: string
  onAccent: string
}

function systemTheme(): 'light' | 'dark' {
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

async function windowTheme(window: BrowserWindow | null): Promise<'light' | 'dark'> {
  // Only the colours depend on this; anything unexpected falls back to the system theme.
  const fallback = systemTheme()
  if (!window || window.isDestroyed()) return fallback
  try {
    const theme = await Promise.race([
      // The app marks its theme on the page's body.
      window.webContents.executeJavaScript('document.body?.dataset.theme || ""', false),
      new Promise((resolve) => setTimeout(() => resolve(''), 150))
    ])
    return theme === 'light' || theme === 'dark' ? theme : fallback
  } catch {
    return fallback
  }
}

function savedPaletteId(): string | undefined {
  try {
    const settings = appState.store?.get('settings', {}) as { accentPalette?: unknown } | undefined
    return typeof settings?.accentPalette === 'string' ? settings.accentPalette : undefined
  } catch {
    return undefined
  }
}

/**
 * The app's theme and chosen accent. The theme is asked of the app's window, and only "light" or
 * "dark" is believed; the accent comes from settings the main process saved, never from the
 * window, so a page cannot restyle a security prompt.
 */
export async function trustedLook(window: BrowserWindow | null): Promise<TrustedLook> {
  const theme = await windowTheme(window)
  return {
    theme,
    accent: accentPalette(savedPaletteId())[theme].accent,
    onAccent: theme === 'light' ? '#ffffff' : DARK_ON_ACCENT
  }
}

/** The colour tokens and base type the trusted windows share, matching the app's own. */
export function trustedLookCss(look: TrustedLook): string {
  const dark = look.theme === 'dark'
  return `:root {
  --surface: ${dark ? '#171717' : '#ffffff'};
  --surface-2: ${dark ? '#1d1d1d' : '#eeeeee'};
  --surface-3: ${dark ? '#252525' : '#e3e3e3'};
  --border: ${dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.12)'};
  --text: ${dark ? '#ececec' : '#161616'};
  --text-2: ${dark ? '#a9a9a9' : '#4c4c4c'};
  --accent: ${look.accent};
  --on-accent: ${look.onAccent};
  --warning: ${dark ? '#e9a05f' : '#a23d0e'};
  --shadow: rgba(0, 0, 0, ${dark ? '0.45' : '0.18'});
  color-scheme: ${look.theme};
}
* { box-sizing: border-box; }
html, body { margin: 0; overflow: hidden; background: transparent; }
body {
  padding: 10px;
  color: var(--text);
  font: 14px/1.5 Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-user-select: none;
  user-select: none;
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`
}
