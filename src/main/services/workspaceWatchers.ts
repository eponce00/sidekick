import { watch as fsWatch, type FSWatcher } from 'fs'
import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'

const DEBOUNCE_MS = 400
const RETRY_BASE_DELAY_MS = 2_000
const MAX_RETRIES = 5

interface Subscription {
  folder: string
  target: WebContents
}

interface FolderWatch {
  watcher: FSWatcher | null
  debounce: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retries: number
  subscriptions: Set<string>
}

/**
 * One recursive watch per folder, shared by every panel that shows it. Each
 * panel subscribes to the folder it displays, so a file tree refreshes on its
 * own whichever chat, group, or project happens to be selected.
 */
export class WorkspaceWatchers {
  private readonly folders = new Map<string, FolderWatch>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly trackedTargets = new WeakSet<WebContents>()

  subscribe(folder: string, target: WebContents): string {
    const id = randomUUID()
    this.subscriptions.set(id, { folder, target })
    let watch = this.folders.get(folder)
    if (!watch) {
      watch = {
        watcher: null,
        debounce: null,
        retryTimer: null,
        retries: 0,
        subscriptions: new Set()
      }
      this.folders.set(folder, watch)
      this.attach(folder, watch)
    }
    watch.subscriptions.add(id)
    if (!this.trackedTargets.has(target)) {
      this.trackedTargets.add(target)
      target.once('destroyed', () => this.unsubscribeTarget(target))
    }
    return id
  }

  /** Only the window that subscribed can end its subscription. */
  unsubscribe(id: string, target: WebContents): void {
    const subscription = this.subscriptions.get(id)
    if (!subscription || subscription.target !== target) return
    this.subscriptions.delete(id)
    const watch = this.folders.get(subscription.folder)
    if (!watch) return
    watch.subscriptions.delete(id)
    if (watch.subscriptions.size === 0) this.close(subscription.folder, watch)
  }

  closeAll(): void {
    for (const [folder, watch] of this.folders) this.close(folder, watch)
    this.subscriptions.clear()
  }

  private unsubscribeTarget(target: WebContents): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.target === target) this.unsubscribe(id, target)
    }
  }

  private close(folder: string, watch: FolderWatch): void {
    watch.watcher?.close()
    if (watch.debounce) clearTimeout(watch.debounce)
    if (watch.retryTimer) clearTimeout(watch.retryTimer)
    this.folders.delete(folder)
  }

  private notify(watch: FolderWatch): void {
    for (const id of watch.subscriptions) {
      const target = this.subscriptions.get(id)?.target
      if (target && !target.isDestroyed()) target.send('workspace:filesChanged', id)
    }
  }

  private attach(folder: string, watch: FolderWatch): void {
    try {
      watch.watcher = fsWatch(folder, { recursive: true }, (_eventType, filename) => {
        const name = filename ? filename.toString() : ''
        if (name === '.git' || name.startsWith('.git\\') || name.startsWith('.git/')) return
        if (watch.debounce) clearTimeout(watch.debounce)
        watch.debounce = setTimeout(() => {
          watch.debounce = null
          this.notify(watch)
        }, DEBOUNCE_MS)
      })
      watch.watcher.on('error', (error) => {
        console.warn('[FileWatcher] Error:', error)
        watch.watcher?.close()
        watch.watcher = null
        this.scheduleRetry(folder, watch)
      })
    } catch (error) {
      console.warn('[FileWatcher] Could not start watcher:', error)
      this.scheduleRetry(folder, watch)
    }
  }

  /** A dropped watch is silent, so retry a few times: a network share blipping or a
   * tool replacing the directory should not cost the session its live file tree,
   * while a deleted folder still gives up instead of spinning forever. */
  private scheduleRetry(folder: string, watch: FolderWatch): void {
    if (watch.retryTimer || watch.retries >= MAX_RETRIES) return
    watch.retries += 1
    watch.retryTimer = setTimeout(() => {
      watch.retryTimer = null
      if (this.folders.get(folder) === watch) this.attach(folder, watch)
    }, RETRY_BASE_DELAY_MS * watch.retries)
  }
}

export const workspaceWatchers = new WorkspaceWatchers()
