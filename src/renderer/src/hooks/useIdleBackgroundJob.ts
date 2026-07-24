import { useEffect, useRef } from 'react'

export interface IdleBackgroundJobResult {
  didWork: boolean
  countTowardLimit?: boolean
  nextDelayMs?: number
}

interface IdleBackgroundJobOptions {
  enabled: boolean
  jobKey: string
  foregroundBusy: boolean
  initialDelayMs: number
  requiredUserIdleMs?: number
  busyRecheckMs?: number
  hiddenRecheckMs?: number
  betweenWorkMs: number
  emptyRecheckMs: number
  maxWorkPerSession: number
  label: string
  runOne: () => Promise<IdleBackgroundJobResult>
}

/** Shared single-flight scheduler for optional provider-backed maintenance work. */
export function useIdleBackgroundJob(options: IdleBackgroundJobOptions): void {
  const latestOptionsRef = useRef(options)
  useEffect(() => {
    latestOptionsRef.current = options
  }, [options])

  useEffect(() => {
    if (!options.enabled) return

    let cancelled = false
    let timerId: number | undefined
    let idleCallbackId: number | undefined
    let processing = false
    let processedWork = 0
    let lastUserActivity = Date.now()

    const requiredUserIdleMs = options.requiredUserIdleMs ?? 4_000
    const busyRecheckMs = options.busyRecheckMs ?? 10_000
    const hiddenRecheckMs = options.hiddenRecheckMs ?? 60_000

    const recordUserActivity = (): void => {
      lastUserActivity = Date.now()
    }

    const schedule = (delay: number): void => {
      if (cancelled || processedWork >= options.maxWorkPerSession) return
      if (timerId !== undefined) window.clearTimeout(timerId)
      if (idleCallbackId !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleCallbackId)
        idleCallbackId = undefined
      }
      timerId = window.setTimeout(() => {
        timerId = undefined
        const run = (): void => {
          idleCallbackId = undefined
          void processOne()
        }
        if (typeof window.requestIdleCallback === 'function') {
          idleCallbackId = window.requestIdleCallback(run, { timeout: 2_000 })
        } else {
          run()
        }
      }, delay)
    }

    const processOne = async (): Promise<void> => {
      if (cancelled || processing) return
      processing = true
      try {
        const current = latestOptionsRef.current
        if (document.visibilityState !== 'visible') {
          schedule(hiddenRecheckMs)
          return
        }
        if (
          !current.enabled ||
          current.foregroundBusy ||
          Date.now() - lastUserActivity < requiredUserIdleMs
        ) {
          schedule(busyRecheckMs)
          return
        }

        const result = await current.runOne()
        if (cancelled) return
        if (result.didWork) {
          if (result.countTowardLimit !== false) processedWork += 1
          schedule(result.nextDelayMs ?? current.betweenWorkMs)
        } else {
          schedule(result.nextDelayMs ?? current.emptyRecheckMs)
        }
      } catch (error) {
        console.warn(`[${latestOptionsRef.current.label}] Background work paused:`, error)
        schedule(latestOptionsRef.current.emptyRecheckMs)
      } finally {
        processing = false
      }
    }

    window.addEventListener('pointerdown', recordUserActivity, { passive: true })
    window.addEventListener('keydown', recordUserActivity)
    window.addEventListener('wheel', recordUserActivity, { passive: true })
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      recordUserActivity()
      schedule(requiredUserIdleMs)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    schedule(options.initialDelayMs)

    return () => {
      cancelled = true
      if (timerId !== undefined) window.clearTimeout(timerId)
      if (idleCallbackId !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleCallbackId)
      }
      window.removeEventListener('pointerdown', recordUserActivity)
      window.removeEventListener('keydown', recordUserActivity)
      window.removeEventListener('wheel', recordUserActivity)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    options.busyRecheckMs,
    options.enabled,
    options.hiddenRecheckMs,
    options.initialDelayMs,
    options.jobKey,
    options.maxWorkPerSession,
    options.requiredUserIdleMs
  ])
}
