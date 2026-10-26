import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS } from '../theme'

/** Slow drifting light in the app's accent colours behind everything, with a faint grid. */
export function Backdrop(): React.JSX.Element {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  const drift = (from: number, to: number): number =>
    interpolate(frame, [0, durationInFrames], [from, to])
  const glow = (color: string, x: number, y: number, size: number): React.CSSProperties => ({
    position: 'absolute',
    left: `${x}%`,
    top: `${y}%`,
    width: size,
    height: size,
    marginLeft: -size / 2,
    marginTop: -size / 2,
    borderRadius: '50%',
    background: color,
    filter: 'blur(120px)',
    opacity: 0.32
  })
  return (
    <AbsoluteFill style={{ background: COLORS.background, overflow: 'hidden' }}>
      <div style={glow(COLORS.accent, drift(18, 30), drift(20, 34), 620)} />
      <div style={glow(COLORS.violet, drift(84, 70), drift(16, 30), 520)} />
      <div style={glow(COLORS.teal, drift(62, 78), drift(96, 80), 560)} />
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)'
        }}
      />
    </AbsoluteFill>
  )
}
