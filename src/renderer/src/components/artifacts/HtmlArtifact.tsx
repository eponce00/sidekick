import React, { useState, useEffect, useMemo, useRef } from 'react'
import { FileCode, Eye } from 'lucide-react'
import { buildArtifactSrcDoc } from '../../utils/htmlArtifactDocument'
import {
  getArtifactTheme,
  getArtifactThemeCssVariables,
  observeArtifactTheme
} from '../../utils/artifactTheme'

interface HtmlArtifactProps {
  code: string
  title?: string
  onCopy?: () => void
  onResult?: (result: { success: boolean; error?: string; code?: string }) => void
}

function HtmlArtifact({ code, title, onCopy, onResult }: HtmlArtifactProps): React.JSX.Element {
  const [showCode, setShowCode] = useState(false)
  const [iframeHeight, setIframeHeight] = useState(280)
  const hasReportedRef = useRef(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const srcDoc = useMemo(() => buildArtifactSrcDoc(code, getArtifactTheme()), [code])

  // Reset success state and height when new code arrives.
  useEffect(() => {
    hasReportedRef.current = false
  }, [code, title])

  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return

      const data = event.data as { type?: string; height?: number; error?: string }
      if (data?.type === 'html-artifact-height' && typeof data.height === 'number') {
        setIframeHeight(Math.max(120, Math.ceil(data.height) + 4))
      } else if (data?.type === 'html-artifact-error' && !hasReportedRef.current) {
        hasReportedRef.current = true
        const message = data.error || 'Unknown HTML artifact error'
        console.warn(`[HtmlArtifact] Runtime error for "${title}":`, message)
        onResult?.({ success: false, error: message, code })
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [code, onResult, title])

  useEffect(() => {
    return observeArtifactTheme((theme) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'html-artifact-theme',
          theme: { mode: theme.themeMode, variables: getArtifactThemeCssVariables(theme) }
        },
        '*'
      )
    })
  }, [])

  const handleLoad = (): void => {
    if (!onResult || hasReportedRef.current || showCode) return
    hasReportedRef.current = true
    console.log(`[HtmlArtifact] Reporting success for "${title}"`)
    onResult({ success: true })
  }

  return (
    <div className="artifact-container">
      <div className="artifact-header">
        <div className="artifact-header-left">
          <span className="artifact-icon">
            <FileCode size={16} />
          </span>
          {title && <span className="artifact-title">{title}</span>}
          <span className="artifact-type-badge">HTML</span>
        </div>
        <div className="artifact-header-right">
          {onCopy && (
            <button
              className="artifact-header-button copy-icon"
              onClick={onCopy}
              title="Copy code"
            ></button>
          )}
          <button
            className="artifact-toggle-code"
            onClick={() => setShowCode(!showCode)}
            title={showCode ? 'Hide code' : 'Show code'}
          >
            {showCode ? <Eye size={16} /> : '</>'}
          </button>
        </div>
      </div>
      <div className="artifact-content artifact-html-content">
        {showCode ? (
          <pre className="artifact-code-view">{code}</pre>
        ) : (
          <iframe
            ref={iframeRef}
            className="artifact-html-frame"
            srcDoc={srcDoc}
            style={{ width: '100%', height: iframeHeight, border: 'none', display: 'block' }}
            sandbox="allow-scripts"
            title={title || 'HTML artifact preview'}
            onLoad={handleLoad}
          />
        )}
      </div>
    </div>
  )
}

export default HtmlArtifact
