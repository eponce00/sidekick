import React, { useState, useEffect, useRef } from 'react'
import { Eye } from 'lucide-react'

interface SvgArtifactProps {
  code: string
  title?: string
  onCopy?: () => void
  onResult?: (result: { success: boolean; error?: string; code?: string }) => void
}

function SvgArtifact({ code, title, onCopy, onResult }: SvgArtifactProps): React.JSX.Element {
  const [showCode, setShowCode] = useState(false)
  const hasReportedRef = useRef(false)

  // Report success on mount (SVG doesn't have transpilation, just renders)
  useEffect(() => {
    if (!onResult || hasReportedRef.current) return
    hasReportedRef.current = true
    console.log(`[SvgArtifact] Reporting success for "${title}"`)
    onResult({ success: true })
  }, [onResult, title])

  return (
    <div className="artifact-container">
      <div className="artifact-header">
        <div className="artifact-header-left">
          <span className="artifact-icon">🎨</span>
          {title && <span className="artifact-title">{title}</span>}
          <span className="artifact-type-badge">SVG</span>
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
            {showCode ? <Eye size={14} /> : '</>'}
          </button>
        </div>
      </div>
      <div className="artifact-content artifact-svg-content">
        {showCode ? (
          <pre className="artifact-code-view">{code}</pre>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: code }} />
        )}
      </div>
    </div>
  )
}

export default SvgArtifact
