import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { COLORS, fontFamily } from '../theme'

/** A glass pill that rises in with a feature's name and one line about it. */
export function Caption({
  kicker,
  title,
  delay = 6,
  out
}: {
  kicker: string
  title: string
  delay?: number
  /** Frame it leaves at, if before the end. */
  out?: number
}): React.JSX.Element {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const enter = spring({ frame: frame - delay, fps, config: { damping: 16 } })
  const leaveAt = out ?? durationInFrames - 10
  const leave = interpolate(frame, [leaveAt, leaveAt + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  })
  return (
    <div
      style={{
        position: 'absolute',
        left: 56,
        bottom: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 22px 14px 16px',
        borderRadius: 999,
        background: 'rgba(19, 19, 19, 0.78)',
        border: `1px solid ${COLORS.border}`,
        backdropFilter: 'blur(14px)',
        boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
        fontFamily,
        transform: `translateY(${interpolate(enter, [0, 1], [40, 0]) + leave * 20}px)`,
        opacity: enter * (1 - leave)
      }}
    >
      <span
        style={{
          padding: '5px 11px',
          borderRadius: 999,
          background: 'rgba(134, 174, 232, 0.16)',
          color: COLORS.accent,
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase'
        }}
      >
        {kicker}
      </span>
      <span style={{ color: COLORS.text, fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>
        {title}
      </span>
    </div>
  )
}
