import { Composition } from 'remotion'
import { Feature, type FeatureProps } from './Feature'
import { Hero, HERO_DURATION } from './Hero'
import { FPS, HEIGHT, MARKS, sec, WIDTH } from './theme'

/** The README's feature clips: where each starts in the recording, how fast, and the camera. */
export const FEATURES: Array<{ id: string; seconds: number } & FeatureProps> = [
  {
    id: 'agent',
    seconds: 9.5,
    from: MARKS.agentStart + 1.5,
    rate: 1.7,
    kicker: 'Agent',
    title: 'Finds the bug, fixes it, runs the tests',
    shots: [
      { at: 0, zoom: 1.5, x: 0.56, y: 0.22 },
      { at: 4, zoom: 1.5, x: 0.56, y: 0.42 },
      { at: 8.5, zoom: 1.5, x: 0.56, y: 0.58 }
    ]
  },
  {
    id: 'artifacts',
    seconds: 13,
    from: MARKS.artifactStart + 4.5,
    rate: 2.2,
    kicker: 'Artifacts',
    title: 'Live UI that builds as it streams, changed in place',
    shots: [
      { at: 0, zoom: 1.4, x: 0.56, y: 0.3 },
      { at: 4, zoom: 1.4, x: 0.56, y: 0.5 },
      { at: 7.2, zoom: 1.4, x: 0.56, y: 0.62 },
      { at: 11, zoom: 1.4, x: 0.56, y: 0.62 },
      { at: 12, zoom: 1.4, x: 0.56, y: 0.42 }
    ]
  },
  {
    id: 'team',
    seconds: 7.5,
    from: MARKS.teamStart + 3.5,
    rate: 1.8,
    kicker: 'Teams',
    title: 'Split work across chats that report back',
    shots: [
      { at: 0, zoom: 1.4, x: 0.56, y: 0.55 },
      { at: 3.2, zoom: 1.75, x: 0.2, y: 0.28 },
      { at: 5.6, zoom: 1.75, x: 0.2, y: 0.28 },
      { at: 7.3, zoom: 1.4, x: 0.56, y: 0.62 }
    ]
  },
  {
    id: 'panel',
    seconds: 8,
    from: MARKS.panelStart,
    rate: 1.2,
    kicker: 'Side panel',
    title: 'Your own terminal and apps beside the chat',
    shots: [
      { at: 0, zoom: 1.25, x: 0.6, y: 0.4 },
      { at: 2, zoom: 1.7, x: 0.78, y: 0.28 },
      { at: 6.4, zoom: 1.7, x: 0.78, y: 0.28 },
      { at: 7.8, zoom: 1.4, x: 0.85, y: 0.4 }
    ]
  }
]

export function Root(): React.JSX.Element {
  return (
    <>
      <Composition
        id="hero"
        component={Hero}
        durationInFrames={HERO_DURATION}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {FEATURES.map(({ id, seconds, ...props }) => (
        <Composition
          key={id}
          id={id}
          component={Feature}
          defaultProps={props}
          durationInFrames={sec(seconds)}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
      ))}
    </>
  )
}
