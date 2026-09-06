import type { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserPanelBounds } from '../../shared/browserWorkspace'

interface HostedView {
  view: WebContentsView
  parking: BrowserWindow
  host?: BrowserWindow
  allowInput?: () => boolean
  agentInput: number
}

// Only main-process-created isolated tabs can be embedded; renderer IDs are never accepted.
const views = new Map<number, HostedView>()
const watchedHosts = new WeakSet<BrowserWindow>()

export function registerBrowserView(view: WebContentsView, parking: BrowserWindow): void {
  const entry: HostedView = { view, parking, agentInput: 0 }
  const id = view.webContents.id
  views.set(id, entry)
  view.webContents.on('before-input-event', (event) => {
    if (!entry.agentInput && entry.host && entry.allowInput && !entry.allowInput())
      event.preventDefault()
  })
  view.webContents.on('context-menu', async (_event, params) => {
    const host = entry.host
    const contents = view.webContents
    const canUseMenu = (): boolean =>
      Boolean(
        host &&
        views.get(id) === entry &&
        entry.host === host &&
        !host.isDestroyed() &&
        !contents.isDestroyed() &&
        entry.allowInput?.()
      )
    if (!canUseMenu()) return
    const { Menu } = await import('electron')
    if (!canUseMenu()) return
    const guarded =
      (action: () => void): (() => void) =>
      () => {
        if (canUseMenu()) action()
      }
    Menu.buildFromTemplate([
      { label: 'Cut', enabled: params.editFlags.canCut, click: guarded(() => contents.cut()) },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: guarded(() => contents.copy()) },
      {
        label: 'Paste',
        enabled: params.editFlags.canPaste,
        click: guarded(() => contents.paste())
      },
      { type: 'separator' },
      {
        label: 'Select all',
        enabled: params.editFlags.canSelectAll,
        click: guarded(() => contents.selectAll())
      }
    ]).popup({ window: host })
  })
  view.webContents.on('before-mouse-event', (event, input) => {
    if (
      !entry.agentInput &&
      input.type !== 'mouseMove' &&
      entry.host &&
      entry.allowInput &&
      !entry.allowInput()
    ) {
      event.preventDefault()
    }
  })
  view.webContents.once('destroyed', () => views.delete(id))
}

export function mountBrowserView(
  id: number,
  host: BrowserWindow,
  bounds: BrowserPanelBounds,
  allowInput: () => boolean
): void {
  const entry = views.get(id)
  if (!entry || host.isDestroyed()) throw new Error('Browser page is no longer available')
  for (const [otherId, other] of views) {
    if (otherId !== id && other.host === host) parkBrowserView(otherId)
  }
  if (entry.host !== host) {
    ;(entry.host ?? entry.parking).contentView.removeChildView(entry.view)
    host.contentView.addChildView(entry.view)
    entry.parking.hide()
    entry.host = host
    if (!watchedHosts.has(host)) {
      watchedHosts.add(host)
      host.once('closed', () => unmountBrowserHost(host))
    }
  }
  entry.allowInput = allowInput
  entry.view.setBounds(bounds)
  entry.view.setVisible(true)
}

export function parkBrowserView(id: number): void {
  const entry = views.get(id)
  if (!entry?.host) return
  if (!entry.host.isDestroyed()) entry.host.contentView.removeChildView(entry.view)
  entry.host = undefined
  entry.allowInput = undefined
  if (!entry.parking.isDestroyed() && !entry.view.webContents.isDestroyed()) {
    entry.parking.contentView.addChildView(entry.view)
    const [width, height] = entry.parking.getContentSize()
    entry.view.setBounds({ x: 0, y: 0, width, height })
    entry.parking.setOpacity(process.platform === 'darwin' ? 0.01 : 1)
    entry.parking.showInactive()
  }
}

export function unmountBrowserHost(host: BrowserWindow): void {
  for (const [id, entry] of views) if (entry.host === host) parkBrowserView(id)
}

export function browserViewHost(id: number): BrowserWindow | undefined {
  return views.get(id)?.host
}

export function browserNavigationState(id: number): { canGoBack: boolean; canGoForward: boolean } {
  const contents = views.get(id)?.view.webContents
  return {
    canGoBack: Boolean(
      contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()
    ),
    canGoForward: Boolean(
      contents && !contents.isDestroyed() && contents.navigationHistory.canGoForward()
    )
  }
}

/** Marks a main-process tool gesture so its synthetic input is not treated as user takeover. */
export async function browserAgentInput<T>(
  id: number,
  operation: () => T | Promise<T>
): Promise<T> {
  const entry = views.get(id)
  if (entry) entry.agentInput++
  try {
    return await operation()
  } finally {
    if (entry) entry.agentInput--
  }
}

/** Only CDP input injection owns an input exemption. Read-only debugger requests
 * can be slow and must not mask real user input while their promises are pending. */
export function browserDebuggerCommand<T>(
  id: number,
  method: string,
  operation: () => Promise<T>
): Promise<T> {
  return method.startsWith('Input.') ? browserAgentInput(id, operation) : operation()
}
