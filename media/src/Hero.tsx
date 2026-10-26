import { linearTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import {
  AbsoluteFill,
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

const TRANSITION = 14

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

export const HERO_CUTS = [
  {
    frames: sec(3.6),
    from: MARKS.agentStart + 3.5,
    rate: 1.7,
    kicker: 'Agent',
    title: 'Reads, runs, fixes and verifies',
    shots: [
      { at: 0, zoom: 1.55, x: 0.56, y: 0.3 },
      { at: 3.4, zoom: 1.55, x: 0.56, y: 0.48 }
    ]
  },
  {
    frames: sec(3.8),
    from: MARKS.artifactStart + 5,
    rate: 2,
    kicker: 'Artifacts',
    title: 'Live UI that builds as it streams',
    shots: [
      { at: 0, zoom: 1.45, x: 0.56, y: 0.32 },
      { at: 3.6, zoom: 1.45, x: 0.56, y: 0.5 }
    ]
  },
  {
    frames: sec(3.4),
    from: MARKS.teamStart + 8.5,
    rate: 1.8,
    kicker: 'Teams',
    title: 'Split work across chats that report back',
    shots: [
      { at: 0, zoom: 1.35, x: 0.5, y: 0.5 },
      { at: 1.2, zoom: 1.8, x: 0.2, y: 0.28 }
    ]
  },
  {
    frames: sec(3),
    from: MARKS.lightStart + 0.2,
    rate: 1,
    kicker: 'Themes',
    title: 'Light and dark, with a reveal',
    shots: [{ at: 0, zoom: 1.2, x: 0.6, y: 0.4 }]
  }
]

export const HERO_TITLE = sec(3.4)
export const HERO_END = sec(2.6)
export const HERO_DURATION =
  HERO_TITLE +
  HERO_CUTS.reduce((sum, cut) => sum + cut.frames, 0) +
  HERO_END -
  TRANSITION * (HERO_CUTS.length + 1)

/** The README's opening: the name, then the real app in quick cuts, then where it runs. */
export function Hero(): React.JSX.Element {
  return (
    <AbsoluteFill>
      <Backdrop />
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={HERO_TITLE}>
          <TitleCard />
        </TransitionSeries.Sequence>
        {HERO_CUTS.flatMap((cut, index) => [
          <TransitionSeries.Transition
            key={`t${index}`}
            presentation={index === 0 ? fade() : slide({ direction: 'from-right' })}
            timing={linearTiming({ durationInFrames: TRANSITION })}
          />,
          <TransitionSeries.Sequence key={`s${index}`} durationInFrames={cut.frames}>
            <Cut {...cut} />
          </TransitionSeries.Sequence>
        ])}
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: TRANSITION })}
        />
        <TransitionSeries.Sequence durationInFrames={HERO_END}>
          <EndCard />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  )
}
