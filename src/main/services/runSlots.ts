import type { QueuedRun } from '../../shared/runSlots'

export interface RunSlotRequest {
  runId: string
  conversationId?: string | null
  /** The provider instance the run samples, or provider and model when it has none. */
  providerKey: string
  providerLimit: number
  signal: AbortSignal
  /** Called once when the request has to wait. */
  onQueued?: () => void
}

/**
 * A run's hold on one global slot and one slot of its provider. A run gives both back while it
 * waits for the user, for `wait`, or for its own sub-agents, and takes them again before its next
 * model step, so a waiting run never keeps another from working.
 */
export interface RunLease {
  readonly held: boolean
  /** Gives the slots back until `resume`. */
  suspend(): void
  /** Takes the slots again, waiting in line if they are in use. Calls `onQueued` when it waits. */
  resume(signal: AbortSignal, onQueued?: () => void): Promise<void>
  /** Ends the lease for good. Safe to call more than once. */
  release(): void
}

interface Waiter {
  runId: string
  conversationId: string | null
  providerKey: string
  providerLimit: number
  queuedAt: number
  resuming: boolean
  grant: () => void
}

/**
 * Global and per-provider run slots shared by chats, scheduled runs, chats other chats started,
 * and sub-agents. A run gets both of its slots at once or keeps waiting holding neither, so no run
 * holds one slot while it waits for another: the queue cannot deadlock. A waiting run whose
 * provider is full does not hold back a run for another provider. Otherwise slots go in order.
 */
export class RunSlots {
  private active = 0
  private readonly providers = new Map<string, number>()
  private queue: Waiter[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly globalLimit: () => number,
    private readonly now: () => number = Date.now
  ) {}

  /** Slots in use, for status and tests. */
  inUse(): { global: number; providers: Record<string, number> } {
    return { global: this.active, providers: Object.fromEntries(this.providers) }
  }

  queued(): QueuedRun[] {
    return this.queue.map(({ runId, conversationId, providerKey, queuedAt, resuming }) => ({
      runId,
      conversationId,
      providerKey,
      queuedAt,
      resuming
    }))
  }

  /** Called whenever the queue changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async acquire(request: RunSlotRequest): Promise<RunLease> {
    await this.take(request, false)
    let held = true
    let ended = false
    const giveBack = (): void => {
      if (!held) return
      held = false
      this.free(request.providerKey)
    }
    return {
      get held() {
        return held
      },
      suspend: giveBack,
      resume: async (signal, onQueued) => {
        if (held || ended) return
        await this.take({ ...request, signal, onQueued }, true)
        if (ended) this.free(request.providerKey)
        else held = true
      },
      release: () => {
        ended = true
        giveBack()
      }
    }
  }

  private fits(providerKey: string, providerLimit: number): boolean {
    return (
      this.active < Math.max(1, this.globalLimit()) &&
      (this.providers.get(providerKey) ?? 0) < Math.max(1, providerLimit)
    )
  }

  private hold(providerKey: string): void {
    this.active++
    this.providers.set(providerKey, (this.providers.get(providerKey) ?? 0) + 1)
  }

  private take(request: RunSlotRequest, resuming: boolean): Promise<void> {
    request.signal.throwIfAborted()
    // Every waiter that fits is granted at once, so whoever still waits needs a slot that is not
    // free. A free slot is this run's unless someone earlier waits for the same provider.
    const aheadForProvider = this.queue.some(
      ({ providerKey }) => providerKey === request.providerKey
    )
    if (!aheadForProvider && this.fits(request.providerKey, request.providerLimit)) {
      this.hold(request.providerKey)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        runId: request.runId,
        conversationId: request.conversationId ?? null,
        providerKey: request.providerKey,
        providerLimit: request.providerLimit,
        queuedAt: this.now(),
        resuming,
        grant: () => {
          request.signal.removeEventListener('abort', abandon)
          resolve()
        }
      }
      const abandon = (): void => {
        this.queue = this.queue.filter((candidate) => candidate !== waiter)
        this.notify()
        // Leaving the line can let someone behind it through.
        this.drain()
        reject(request.signal.reason ?? new Error('The run was stopped while it waited for a slot'))
      }
      this.queue.push(waiter)
      request.signal.addEventListener('abort', abandon, { once: true })
      request.onQueued?.()
      this.notify()
      // A slot may be free for this provider even though others wait for theirs.
      this.drain()
    })
  }

  private free(providerKey: string): void {
    this.active = Math.max(0, this.active - 1)
    const count = (this.providers.get(providerKey) ?? 1) - 1
    if (count > 0) this.providers.set(providerKey, count)
    else this.providers.delete(providerKey)
    this.drain()
  }

  /** Grants waiting runs in order, skipping those whose provider is still full. */
  private drain(): void {
    let granted = false
    for (const waiter of [...this.queue]) {
      if (!this.fits(waiter.providerKey, waiter.providerLimit)) continue
      // Within one provider, order is strict: an earlier waiter that does not fit blocks later ones.
      const earlier = this.queue.indexOf(waiter)
      if (
        this.queue.slice(0, earlier).some(({ providerKey }) => providerKey === waiter.providerKey)
      )
        continue
      this.queue = this.queue.filter((candidate) => candidate !== waiter)
      this.hold(waiter.providerKey)
      granted = true
      waiter.grant()
    }
    if (granted) this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.warn('[RunSlots] A queue listener failed:', error)
      }
    }
  }
}
