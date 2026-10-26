import { AbsoluteFill } from 'remotion'
import { COLORS } from '../theme'

/**
 * Soft light in the app's accent colours behind everything, with a faint grid. It holds still: a
 * backdrop that moves changes every pixel of every frame, which the README's animations pay for in
 * sharpness.
 */
export function Backdrop(): React.JSX.Element {
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
      <div style={glow(COLORS.accent, 24, 26, 620)} />
      <div style={glow(COLORS.violet, 78, 22, 520)} />
      <div style={glow(COLORS.teal, 70, 90, 560)} />
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
