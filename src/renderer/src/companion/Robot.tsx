import { memo } from 'react'
import peekSvg from '../assets/sidekick-peek.svg?raw'

// The empty chat's robot leans out from behind the panel, so its drawing is cut straight down its
// right side. Here there is no panel to hide behind: the cut comes off and the frame takes in the
// whole robot, flying with its cape behind it.
const UNCUT_SVG = peekSvg
  .replace(/<clipPath id="sidekick-tile">.*?<\/clipPath>/, '')
  .replace(' clip-path="url(#sidekick-tile)"', '')
const FLYING_SVG = UNCUT_SVG.replace(/viewBox="[^"]*"/, 'viewBox="56 196 964 760"')

/** SideKick's robot, as decoration on the screens before and around the chats. */
export const Robot = memo(function Robot({ className = '' }: { className?: string }) {
  return (
    <span
      className={`cp-robot ${className}`.trim()}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: FLYING_SVG }}
    />
  )
})
