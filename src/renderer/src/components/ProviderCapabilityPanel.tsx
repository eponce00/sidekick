import { useEffect, useRef, useState } from 'react'
import type { ProviderInstance } from '../../../shared/settings'
import type { ProviderProbeResult } from '../../../shared/providerRuntime'
import { providerKindForInstance } from '../../../shared/providerRegistry'

export function ProviderCapabilityPanel({
  instance
}: {
  instance: ProviderInstance
}): React.JSX.Element {
  const [model, setModel] = useState('')
  const [running, setRunning] = useState(false)
  const [vision, setVision] = useState(false)
  const [result, setResult] = useState<ProviderProbeResult>()
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      void window.api.providers.cancelProbe()
    }
  }, [])
  const run = async (): Promise<void> => {
    setRunning(true)
    setResult(undefined)
    setError('')
    setCopied(false)
    try {
      const report = await window.api.providers.probe(
        {
          providerInstanceId: instance.id,
          providerKind: providerKindForInstance(instance),
          model
        },
        vision
      )
      if (mounted.current) setResult(report)
    } catch {
      if (mounted.current)
        setError(
          'Capability test could not complete. Check saved provider settings and server health.'
        )
    } finally {
      if (mounted.current) setRunning(false)
    }
  }
  return (
    <section className="provider-metadata-guidance" aria-label="Provider capability test">
      <div>
        <h3>Test actual model capabilities</h3>
        <p>
          Uses saved settings. Save changes first. Sends two synthetic requests (up to 1,024 output
          tokens each); may incur provider charges or load the selected model. Tools are never
          executed. Thinking uses your existing defaults.
        </p>
        <select
          aria-label="Model to test"
          value={model}
          disabled={running}
          onChange={(event) => {
            setModel(event.target.value)
            setResult(undefined)
          }}
        >
          <option value="">Choose a model explicitly</option>
          {instance.models
            .filter((item) => item.enabled)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={vision}
            disabled={running}
            onChange={(event) => setVision(event.target.checked)}
          />
          Include vision: one additional synthetic image request
        </label>
        <button
          type="button"
          className="settings-secondary-action"
          disabled={running || !model}
          onClick={() => void run()}
        >
          Test capabilities
        </button>
        {running && (
          <button
            type="button"
            className="settings-secondary-action"
            onClick={() => void window.api.providers.cancelProbe()}
          >
            Cancel test
          </button>
        )}
        <div role="status">{running ? 'Testing—maximum two minutes…' : error}</div>
        {result && (
          <>
            <p>
              Requested model: {result.model}. Server reported:{' '}
              {result.reportedModels?.join(', ') || 'not reported'}. This may still be an alias, not
              a verified checkpoint. “Not observed” does not mean unsupported. These are smoke
              checks, not a quality benchmark. Vision is tested only when selected.
            </p>
            <ul>
              {result.checks.map((check) => (
                <li key={check.capability}>
                  {check.capability}: {check.status} · {check.durationMs} ms total · first streamed
                  content:{' '}
                  {check.firstTokenMs === undefined
                    ? 'not observed'
                    : `${Math.round(check.firstTokenMs)} ms`}{' '}
                  · cached input: {check.cachedTokens ?? 'not reported'}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="settings-secondary-action"
              onClick={() => {
                // Whitelist numerical/status fields; exclude identities, URLs, responses and credentials.
                const summary = { schemaVersion: 1, checks: result.checks }
                void window.api.clipboard
                  .writeText(JSON.stringify(summary, null, 2))
                  .then((response) => setCopied(response.success))
                  .catch(() => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy anonymous test summary'}
            </button>
          </>
        )}
      </div>
    </section>
  )
}
