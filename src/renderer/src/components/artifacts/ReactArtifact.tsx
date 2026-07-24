import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Component as LucideComponent,
  Copy,
  Play
} from 'lucide-react'
import {
  boundedArtifactFrameHeight,
  DEFAULT_ARTIFACT_FRAME_HEIGHT
} from '../../utils/artifactFrameSize'
import { getArtifactTheme, observeArtifactTheme } from '../../utils/artifactTheme'

// Resolve the sandbox page URL. In dev, Vite serves it at /sandbox.html.
// In production, the built file is next to index.html in the output directory.
const SANDBOX_URL = 'sidekick-artifact://app/sandbox.html'

interface ReactArtifactProps {
  code: string
  title?: string
  isStreaming?: boolean
  onResult?: (result: { success: boolean; error?: string; code?: string }) => void
  onCopy?: () => void
}

function ReactArtifact({
  code,
  title,
  isStreaming,
  onResult,
  onCopy
}: ReactArtifactProps): React.JSX.Element {
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [iframeHeight, setIframeHeight] = useState(DEFAULT_ARTIFACT_FRAME_HEIGHT)
  const [isErrorExpanded, setIsErrorExpanded] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const hasReportedRef = useRef(false)
  const sandboxStatusRef = useRef<'idle' | 'success' | 'error'>('idle')
  const lastErrorRef = useRef<string | null>(null)
  const sandboxReadyRef = useRef(false)
  const pendingCodeRef = useRef<string | null>(null)

  // Reset state when code changes
  useEffect(() => {
    setError(null)
    hasReportedRef.current = false
    sandboxStatusRef.current = 'idle'
    lastErrorRef.current = null
    setIsErrorExpanded(false)
  }, [code])

  const sendCodeToSandbox = useCallback((codeToSend: string) => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    if (!sandboxReadyRef.current) {
      pendingCodeRef.current = codeToSend
      return
    }
    const theme = getArtifactTheme()
    iframe.contentWindow.postMessage({ type: 'render', code: codeToSend, theme }, '*')
  }, [])

  // Listen for messages from the sandbox iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return

      const data = event.data
      if (!data || typeof data !== 'object' || !data.type) return

      switch (data.type) {
        case 'ready':
          sandboxReadyRef.current = true
          // If we had code waiting to be sent, send it now
          if (pendingCodeRef.current) {
            sendCodeToSandbox(pendingCodeRef.current)
            pendingCodeRef.current = null
          }
          break

        case 'success':
          sandboxStatusRef.current = 'success'
          lastErrorRef.current = null
          setError(null)
          setIsErrorExpanded(false)
          if (!hasReportedRef.current) {
            console.log(`[ReactArtifact] Sandbox reports success for "${title}"`)
            hasReportedRef.current = true
            onResult?.({ success: true })
          }
          break

        case 'error':
          {
            const errMsg = data.error || 'Unknown sandbox error'
            if (sandboxStatusRef.current === 'error' && lastErrorRef.current === errMsg) {
              break
            }

            console.log(`[ReactArtifact] Sandbox reports error for "${title}":`, errMsg)
            sandboxStatusRef.current = 'error'
            lastErrorRef.current = errMsg
            hasReportedRef.current = true
            setError(errMsg)
            setIsErrorExpanded(true)
            onResult?.({ success: false, error: errMsg, code })
          }
          break

        case 'resize':
          if (typeof data.height === 'number' && data.height > 0) {
            setIframeHeight(boundedArtifactFrameHeight(data.height))
          }
          break
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [code, title, onResult, sendCodeToSandbox])

  // Send code to sandbox when it changes and streaming is done.
  // The iframe's src is already set in JSX — don't set it again or it double-loads.
  // When the component mounts (fresh iframe), the sandbox will post 'ready' and we
  // send the pending code. If the sandbox is already ready (no remount), send directly.
  useEffect(() => {
    if (isStreaming || !code) return

    hasReportedRef.current = false
    sandboxStatusRef.current = 'idle'
    lastErrorRef.current = null
    setError(null)
    setIsErrorExpanded(false)

    if (sandboxReadyRef.current) {
      sendCodeToSandbox(code)
    } else {
      pendingCodeRef.current = code
    }
  }, [code, isStreaming, sendCodeToSandbox])

  // When the user toggles back from code view to preview, the iframe remounts
  // as a brand-new instance. Reset sandbox state so the 'ready' message will
  // trigger a fresh code send instead of finding pendingCodeRef empty.
  useEffect(() => {
    if (showCode) return
    sandboxReadyRef.current = false
    pendingCodeRef.current = code
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCode])

  // Keep the sandbox theme contract synchronized with the host app.
  useEffect(() => {
    return observeArtifactTheme((theme) => {
      const iframe = iframeRef.current
      if (!iframe?.contentWindow || !sandboxReadyRef.current) return
      iframe.contentWindow.postMessage({ type: 'theme-update', theme }, '*')
    })
  }, [])

  // Timeout: if no result after 8 seconds, report failure
  useEffect(() => {
    if (isStreaming || !code) return undefined
    const timer = setTimeout(() => {
      if (!hasReportedRef.current) {
        const errMsg = 'Artifact timed out — no response from sandbox after 15 seconds'
        console.warn(`[ReactArtifact] Timeout for "${title}"`)
        hasReportedRef.current = true
        setError(errMsg)
        onResult?.({ success: false, error: errMsg, code })
      }
    }, 15000)
    return () => clearTimeout(timer)
  }, [code, isStreaming, title, onResult])

  const handleRetryRender = (): void => {
    setError(null)
    hasReportedRef.current = false
    sandboxStatusRef.current = 'idle'
    lastErrorRef.current = null
    setIsErrorExpanded(false)
    // Force iframe reload for a clean slate
    sandboxReadyRef.current = false
    pendingCodeRef.current = code
    const iframe = iframeRef.current
    if (iframe) {
      // Use a cache-busting query to force full reload
      iframe.src = SANDBOX_URL + '?retry=' + Date.now()
    }
  }

  // Error state
  if (error) {
    return (
      <div className="artifact-container">
        {title && (
          <div className="artifact-header">
            <div className="artifact-header-left">
              <span className="artifact-icon">
                <AlertTriangle size={16} />
              </span>
              <span className="artifact-title">{title}</span>
              <span className="artifact-type-badge artifact-error-badge">Error</span>
            </div>
            <div className="artifact-header-right">
              <button
                className="artifact-toggle-code"
                onClick={() => setIsErrorExpanded(!isErrorExpanded)}
                title={isErrorExpanded ? 'Collapse error details' : 'Expand error details'}
              >
                {isErrorExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>
          </div>
        )}
        {isErrorExpanded && (
          <>
            <div className="artifact-error">
              <strong>Error:</strong> {error}
            </div>
            <div className="artifact-error-actions">
              <button type="button" className="artifact-error-button" onClick={handleRetryRender}>
                Retry render
              </button>
            </div>
            <div className="artifact-content">
              <pre className="artifact-code">{code}</pre>
            </div>
          </>
        )}
        {/* Keep the iframe mounted so it can be reused on retry */}
        <iframe
          ref={iframeRef}
          src={SANDBOX_URL}
          style={{ display: 'none' }}
          sandbox="allow-scripts allow-same-origin"
          title="Artifact sandbox"
        />
      </div>
    )
  }

  // Success / normal state
  return (
    <div className="artifact-container">
      <div className="artifact-header">
        <div className="artifact-header-left">
          <span className="artifact-icon">
            <LucideComponent size={16} />
          </span>
          {title && <span className="artifact-title">{title}</span>}
          <span className="artifact-type-badge">React</span>
        </div>
        <div className="artifact-header-right">
          {onCopy && (
            <button className="artifact-header-button copy-icon" onClick={onCopy} title="Copy code">
              <Copy size={13} />
            </button>
          )}
          <button
            className="artifact-toggle-code"
            onClick={() => setShowCode(!showCode)}
            title={showCode ? 'Show component' : 'Show code'}
          >
            {showCode ? (
              <>
                <Play size={12} /> Run
              </>
            ) : (
              <>
                <Code2 size={12} /> Code
              </>
            )}
          </button>
        </div>
      </div>
      <div className="artifact-content artifact-react-content">
        {showCode ? (
          <pre className="artifact-code-view">{code}</pre>
        ) : (
          <iframe
            ref={iframeRef}
            className="artifact-preview-frame artifact-react-frame"
            src={SANDBOX_URL}
            style={{
              width: '100%',
              height: iframeHeight,
              border: 'none',
              display: 'block',
              background: 'var(--panel-bg, #111111)',
              borderRadius: '0 0 8px 8px'
            }}
            sandbox="allow-scripts allow-same-origin"
            title="Artifact sandbox"
          />
        )}
      </div>
    </div>
  )
}

export default ReactArtifact
