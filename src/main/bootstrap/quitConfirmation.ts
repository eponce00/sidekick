import { dialog, type BrowserWindow } from 'electron'

export function quitConfirmationMessage(count: number): string {
  return count === 1
    ? '1 conversation is still working. Quit anyway?'
    : `${count} conversations are still working. Quit anyway?`
}

export async function confirmQuitWithActiveRuns(
  count: number,
  parent: BrowserWindow | null
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Quit SideKick',
    message: quitConfirmationMessage(count),
    detail: 'Quitting stops their agents. Work saved so far is kept.'
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  return response === 0
}

export interface QuitGuardOptions {
  activeConversationCount: () => number
  confirm: (count: number) => Promise<boolean>
}

/**
 * Asks once before a quit would stop working agents. Quits that must not be
 * questioned (the updater's restart, the operating system shutting down) call
 * `allow()` first.
 */
export class QuitGuard {
  private allowed = false
  private prompt: Promise<void> | null = null

  constructor(private readonly options: QuitGuardOptions) {}

  allow(): void {
    this.allowed = true
  }

  /**
   * True when the quit (or last-window close) must wait for the user; the
   * caller then prevents it. If the user chooses Quit, `proceed` retries it.
   */
  intercept(proceed: () => void): boolean {
    if (this.allowed) return false
    if (this.prompt) return true
    const count = this.options.activeConversationCount()
    if (count === 0) return false
    this.prompt = this.options
      .confirm(count)
      .catch((error: unknown) => {
        console.error('[Quit] Could not ask before quitting:', error)
        return false
      })
      .then((confirmed) => {
        this.prompt = null
        if (!confirmed) return
        this.allowed = true
        proceed()
      })
    return true
  }
}
