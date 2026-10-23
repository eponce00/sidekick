import { useCallback, useEffect, useState } from 'react'
import type { CompanionAPI, CompanionStatus } from '../../../shared/companion'
import { companionErrorMessage } from '../utils/phoneCompanion'

export interface PhoneCompanion {
  status: CompanionStatus | null
  /** Why the last change failed; the next change clears it. */
  actionError: string | null
  busy: boolean
  refresh: () => void
  setEnabled: (enabled: boolean) => void
  newCode: () => void
  removeDevice: (deviceId: string) => void
}

/**
 * Phone access as the main process reports it, kept current from its change events. Null when
 * this window has no phone access API, as in tests that render the sidebar alone.
 */
export function usePhoneCompanionStatus(): PhoneCompanion | null {
  const api: CompanionAPI | undefined = window.api?.companion
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!api) return
    void api
      .status()
      .then(setStatus)
      .catch((error) => console.error('[Phone] Could not load phone access', error))
  }, [api])

  useEffect(() => {
    if (!api) return
    refresh()
    return api.onChanged(setStatus)
  }, [api, refresh])

  const run = useCallback(
    (action: (companion: CompanionAPI) => Promise<CompanionStatus>) => {
      if (!api) return
      setBusy(true)
      setActionError(null)
      void action(api)
        .then(setStatus)
        .catch((error) => setActionError(companionErrorMessage(error)))
        .finally(() => setBusy(false))
    },
    [api]
  )

  const setEnabled = useCallback(
    (enabled: boolean) => run((companion) => companion.setEnabled(enabled)),
    [run]
  )
  const newCode = useCallback(() => run((companion) => companion.newCode()), [run])
  const removeDevice = useCallback(
    (deviceId: string) => run((companion) => companion.removeDevice(deviceId)),
    [run]
  )

  if (!api) return null
  return { status, actionError, busy, refresh, setEnabled, newCode, removeDevice }
}
