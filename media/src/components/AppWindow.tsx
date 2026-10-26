import {
  interpolate,
  OffthreadVideo,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing
} from 'remotion'
import { COLORS, sec } from '../theme'

/** A point the camera moves to: at `at` seconds into the clip it frames `x`,`y` (0–1) at `zoom`. */
export interface Shot {
  at: number
  zoom: number
  x: number
  y: number
}

/**
 * The real app's recording in a floating window, played from `from` seconds at `rate`, with a
 * camera that glides between shots and a tilt that settles flat as the window arrives.
 */
export function AppWindow({
  from,
  rate = 1,
  shots = [{ at: 0, zoom: 1, x: 0.5, y: 0.5 }],
  width = 1120,
  tilt = true
}: {
  from: number
  rate?: number
  shots?: Shot[]
  width?: number
  tilt?: boolean
}): React.JSX.Element {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const height = (width * 800) / 1280
  const arrive = spring({ frame, fps, config: { damping: 18, mass: 0.9 } })
  const t = frame / fps
  const times = shots.map((shot) => shot.at)
  const ease = {
    easing: Easing.bezier(0.45, 0, 0.2, 1),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  } as const
  const camera = (key: 'zoom' | 'x' | 'y'): number =>
    shots.length > 1
      ? interpolate(
          t,
          times,
          shots.map((shot) => shot[key]),
          ease
        )
      : shots[0][key]
  const zoom = camera('zoom')
  // Keeps the framed point in view without showing past the recording's edges.
  const offset = (centre: number): number => {
    const half = 0.5 / zoom
    return (0.5 - Math.min(Math.max(centre, half), 1 - half)) * 100
  }
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        overflow: 'hidden',
        border: `1px solid ${COLORS.border}`,
        background: COLORS.surface,
        boxShadow: '0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(134,174,232,0.08)',
        transform: tilt
          ? `perspective(1800px) rotateX(${interpolate(arrive, [0, 1], [18, 0])}deg) translateY(${interpolate(arrive, [0, 1], [80, 0])}px) scale(${interpolate(arrive, [0, 1], [0.92, 1])})`
          : undefined,
        opacity: interpolate(arrive, [0, 0.4], [0, 1], { extrapolateRight: 'clamp' })
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transform: `scale(${zoom}) translate(${offset(camera('x'))}%, ${offset(camera('y'))}%)`,
          transformOrigin: 'center center'
        }}
      >
        <OffthreadVideo
          src={staticFile('clips/session.mp4')}
          trimBefore={sec(from)}
          playbackRate={rate}
          muted
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
      </div>
    </div>
  )
}
