import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ParsedArtifact } from '../../utils/artifactParser'
import ReactArtifact from './ReactArtifact'
import HtmlArtifact from './HtmlArtifact'
import SvgArtifact from './SvgArtifact'
import './Artifact.css'

interface ArtifactProps {
  artifact: ParsedArtifact
  onResult?: (result: { title: string; success: boolean; error?: string; code?: string }) => void
}

function ArtifactInstance({ artifact, onResult }: ArtifactProps): React.JSX.Element {
  const [forceRender, setForceRender] = useState(false)
  const hasStartedStreaming = React.useRef(false)

  // Track when streaming starts (only once per artifact)
  useEffect(() => {
    if (artifact.isStreaming && artifact.code.length > 100 && !hasStartedStreaming.current) {
      console.log(`[Artifact] Streaming artifact detected, waiting for completion...`)
      hasStartedStreaming.current = true

      const timeout = setTimeout(() => {
        console.warn('[Artifact] Streaming artifact timeout - forcing render after 10 seconds')
        setForceRender(true)

        // Report timeout error
        onResult?.({
          title: artifact.title,
          success: false,
          error:
            'Artifact took too long to complete streaming. The closing </artifact> tag may be missing.',
          code: artifact.code
        })
      }, 10000) // 10 second timeout

      return () => clearTimeout(timeout)
    }
    return undefined
  }, [artifact.isStreaming, artifact.code.length, artifact.code, artifact.title, onResult])

  // Show loading state while streaming (unless timeout forces render)
  if (artifact.isStreaming && !forceRender) {
    return (
      <div className="artifact-container artifact-streaming">
        <div className="artifact-header">
          <div className="artifact-header-left">
            <span className="artifact-icon artifact-icon-spinning">
              <Loader2 size={16} className="icon-spin" />
            </span>
            <span className="artifact-title">{artifact.title}</span>
            <span className="artifact-type-badge">{artifact.type}</span>
          </div>
        </div>
        <div className="artifact-loading-content">
          <div className="artifact-loading-bar">
            <div className="artifact-loading-progress"></div>
          </div>
          <span className="artifact-loading-text">Creating {artifact.type} component...</span>
        </div>
      </div>
    )
  }

  // Generate a simple hash of the code to use as key - forces remount when code changes
  // This ensures Chart.js and other stateful libraries get a fresh canvas/DOM on code changes
  const codeKey =
    artifact.code.length.toString(36) +
    '-' +
    artifact.code.slice(0, 50).replace(/\W/g, '').slice(0, 20)

  // Copy artifact code to clipboard
  const handleCopy = async () => {
    try {
      const result = await window.api.clipboard.writeText(artifact.code)
      if (!result.success) throw new Error(result.error || 'Could not copy artifact code')
      console.log('[Artifact] Code copied to clipboard')
    } catch (err) {
      console.error('[Artifact] Failed to copy:', err)
    }
  }

  // Render complete artifact (only when not streaming or force render is triggered)
  switch (artifact.type) {
    case 'react':
      return (
        <ReactArtifact
          key={codeKey}
          code={artifact.code}
          title={artifact.title}
          isStreaming={artifact.isStreaming || false}
          onResult={(result) => onResult?.({ title: artifact.title, ...result })}
          onCopy={handleCopy}
        />
      )
    case 'html':
      return (
        <HtmlArtifact
          key={codeKey}
          code={artifact.code}
          title={artifact.title}
          onCopy={handleCopy}
          onResult={(result) => onResult?.({ title: artifact.title, ...result })}
        />
      )
    case 'svg':
      return (
        <SvgArtifact
          key={codeKey}
          code={artifact.code}
          title={artifact.title}
          onCopy={handleCopy}
          onResult={(result) => onResult?.({ title: artifact.title, ...result })}
        />
      )
    default:
      return (
        <div className="artifact-container">
          <div className="artifact-error">Unknown artifact type: {artifact.type}</div>
        </div>
      )
  }
}

function Artifact(props: ArtifactProps): React.JSX.Element {
  return <ArtifactInstance key={props.artifact.title} {...props} />
}

export default Artifact
