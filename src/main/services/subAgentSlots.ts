interface SlotPool {
  active: number
  waiting: Array<() => void>
}

/**
 * Limits how many sub-agents run at once against one provider. A sub-agent
 * past the limit waits its turn here, not in the server's queue, so it can be
 * shown as queued and stopped while it waits. Slots are handed over in order.
 */
export class SubAgentSlots {
  private readonly pools = new Map<string, SlotPool>()

  /**
   * Resolves with the slot's release once one is free. `onQueued` runs when it
   * has to wait; aborting the signal while waiting rejects and gives up the place.
   */
  async acquire(
    key: string,
    limit: number,
    signal: AbortSignal,
    onQueued?: () => void
  ): Promise<() => void> {
    signal.throwIfAborted()
    let pool = this.pools.get(key)
    if (!pool) {
      pool = { active: 0, waiting: [] }
      this.pools.set(key, pool)
    }
    const slots = pool
    if (slots.active < Math.max(1, limit)) slots.active++
    else {
      onQueued?.()
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal.removeEventListener('abort', abandon)
          resolve()
        }
        const abandon = (): void => {
          slots.waiting = slots.waiting.filter((waiter) => waiter !== wake)
          reject(signal.reason ?? new Error('Sub-agent cancelled while queued'))
        }
        slots.waiting.push(wake)
        signal.addEventListener('abort', abandon, { once: true })
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      // The slot passes straight to the next in line, so its count is unchanged.
      const next = slots.waiting.shift()
      if (next) next()
      else slots.active--
    }
  }
}
