import {
  AbsoluteFill,
  Series,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from 'remotion'
import { AppWindow } from './components/AppWindow'
import { Backdrop } from './components/Backdrop'
import { Caption } from './components/Caption'
import { COLORS, fontFamily, MARKS, sec } from './theme'

// Each scene fades out to the backdrop and the next fades in, so two never show at once.
const FADE = 12

function Faded({
  frames,
  children
}: {
  frames: number
  children: React.ReactNode
}): React.JSX.Element {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, FADE, frames - FADE, frames], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  })
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
}

function Wordmark({ size = 1 }: { size?: number }): React.JSX.Element {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const pop = spring({ frame, fps, config: { damping: 11, mass: 0.8 } })
  const letters = 'SideKick'.split('')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 26 * size }}>
      <Img
        src={staticFile('icon.svg')}
        style={{
          width: 120 * size,
          height: 120 * size,
          transform: `scale(${pop}) rotate(${interpolate(pop, [0, 1], [-25, 0])}deg)`,
          filter: 'drop-shadow(0 18px 40px rgba(134,174,232,0.35))'
        }}
      />
      <div
        style={{
          display: 'flex',
          fontFamily,
          fontWeight: 700,
          fontSize: 104 * size,
          letterSpacing: '-0.035em'
        }}
      >
        {letters.map((letter, index) => {
          const rise = spring({ frame: frame - 6 - index * 2, fps, config: { damping: 14 } })
          return (
            <span
              key={index}
              style={{
                color: COLORS.text,
                display: 'inline-block',
                transform: `translateY(${interpolate(rise, [0, 1], [50, 0])}px)`,
                opacity: rise
              }}
            >
              {letter}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function Pills({ items, delay }: { items: string[]; delay: number }): React.JSX.Element {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
      {items.map((item, index) => {
        const enter = spring({ frame: frame - delay - index * 4, fps, config: { damping: 15 } })
        return (
          <span
            key={item}
            style={{
              fontFamily,
              fontSize: 22,
              fontWeight: 500,
              color: COLORS.text,
              padding: '10px 18px',
              borderRadius: 999,
              border: `1px solid ${COLORS.border}`,
              background: 'rgba(255,255,255,0.04)',
              transform: `translateY(${interpolate(enter, [0, 1], [24, 0])}px)`,
              opacity: enter
            }}
          >
            {item}
          </span>
        )
      })}
    </div>
  )
}

function TitleCard(): React.JSX.Element {
  const frame = useCurrentFrame()
  const tagline = interpolate(frame, [20, 36], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  })
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 34 }}>
      <Wordmark />
      <div
        style={{
          fontFamily,
          fontSize: 34,
          fontWeight: 500,
          color: COLORS.muted,
          opacity: tagline,
          transform: `translateY(${(1 - tagline) * 16}px)`
        }}
      >
        A local-first desktop agent for <span style={{ color: COLORS.text }}>real work</span> on
        your computer
      </div>
      <Pills items={['Bring your own model', 'Your files stay local', 'Free forever']} delay={34} />
    </AbsoluteFill>
  )
}

function EndCard(): React.JSX.Element {
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 36 }}>
      <Wordmark size={0.8} />
      <Pills items={['macOS', 'Windows', 'Linux', 'GPL-3.0']} delay={10} />
    </AbsoluteFill>
  )
}

function Cut({
  from,
  rate,
  kicker,
  title,
  shots
}: {
  from: number
  rate: number
  kicker: string
  title: string
  shots?: { at: number; zoom: number; x: number; y: number }[]
}): React.JSX.Element {
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 40 }}>
        <AppWindow from={from} rate={rate} width={1060} shots={shots} />
      </AbsoluteFill>
      <Caption kicker={kicker} title={title} delay={8} />
    </AbsoluteFill>
  )
}

// Few cuts, each long enough to follow, framed once and held.
export const HERO_CUTS = [
  {
    frames: sec(6.5),
    from: MARKS.artifactStart + 6,
    rate: 1.6,
    kicker: 'Artifacts',
    title: 'Live UI that builds as the model writes it',
    shots: [{ at: 0, zoom: 1.3, x: 0.56, y: 0.42 }]
  },
  {
    frames: sec(5.5),
    from: MARKS.agentStart + 4.5,
    rate: 1.5,
    kicker: 'Agent',
    title: 'Reads the code, runs the tests, fixes the bug',
    shots: [{ at: 0, zoom: 1.3, x: 0.56, y: 0.4 }]
  },
  {
    frames: sec(5),
    from: MARKS.teamStart + 8,
    rate: 1.3,
    kicker: 'Teams',
    title: 'Chats that split the work and report back',
    shots: [{ at: 0, zoom: 1.3, x: 0.4, y: 0.4 }]
  }
]

export const HERO_TITLE = sec(3.2)
export const HERO_END = sec(2.6)
export const HERO_DURATION =
  HERO_TITLE + HERO_CUTS.reduce((sum, cut) => sum + cut.frames, 0) + HERO_END

/** The README's opening: the name, then the real app in quick cuts, then where it runs. */
export function Hero(): React.JSX.Element {
  return (
    <AbsoluteFill>
      <Backdrop />
      <Series>
        <Series.Sequence durationInFrames={HERO_TITLE}>
          <Faded frames={HERO_TITLE}>
            <TitleCard />
          </Faded>
        </Series.Sequence>
        {HERO_CUTS.map((cut, index) => (
          <Series.Sequence key={index} durationInFrames={cut.frames}>
            <Faded frames={cut.frames}>
              <Cut {...cut} />
            </Faded>
          </Series.Sequence>
        ))}
        <Series.Sequence durationInFrames={HERO_END}>
          <Faded frames={HERO_END}>
            <EndCard />
          </Faded>
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  )
}
