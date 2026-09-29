import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AgentRunClientModel, type AgentRunClientSnapshot } from '../models/AgentRunClientModel'

// A sub-agent can stream hundreds of events a second; its card redraws at most
// this often.
const REFRESH_MS = 300

/**
 * Follows a sub-agent's own run: loads its journal, then takes its new events
 * as they are published. `live` false loads it once and stops listening.
 */
export function useSubAgentRun(
  runId: string | null,
  live: boolean
): { snapshot: AgentRunClientSnapshot; error: string; loaded: boolean } {
  // A fresh journal for each run followed, so one sub-agent's events never mix into another's.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model = useMemo(() => new AgentRunClientModel(), [runId])
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!runId) return undefined
    let active = true
    const unsubscribe = live
      ? window.api.agentRuns.onEvent(({ event }) => {
          if (event.runId === runId) model.ingest(event, { deferProjection: true })
        })
      : undefined
    const load = async (): Promise<void> => {
      let after = 0
      for (;;) {
        const page = await window.api.agentRuns.events(runId, after)
        if (!active) return
        model.merge(page.run, page.events, { deferProjection: true })
        const next = page.events.at(-1)?.sequence
        if (!page.journal?.hasMore || next === undefined || next <= after) break
        after = next
      }
      model.refresh()
      setLoaded(true)
    }
    load().catch((reason: unknown) => {
      if (active)
        setError(reason instanceof Error ? reason.message : 'Could not load the sub-agent')
    })
    const timer = live ? window.setInterval(() => model.refresh(), REFRESH_MS) : undefined
    return () => {
      active = false
      unsubscribe?.()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [live, model, runId])

  return { snapshot, error, loaded }
}
