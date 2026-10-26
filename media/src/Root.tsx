import { Composition } from 'remotion'
import { Feature, type FeatureProps } from './Feature'
import { Hero, HERO_DURATION } from './Hero'
import { FPS, HEIGHT, MARKS, sec, WIDTH } from './theme'

/** The README's feature clips: where each starts in the recording, how fast, and the camera. */
export const FEATURES: Array<{ id: string; seconds: number } & FeatureProps> = [
  {
    id: 'agent',
    seconds: (MARKS.agentEnd + 1 - (MARKS.agentStart + 1.5)) / 1.3,
    from: MARKS.agentStart + 1.5,
    rate: 1.3,
    kicker: 'Agent',
    title: 'Finds the bug, fixes it, runs the tests',
    shots: [{ at: 0, zoom: 1.3, x: 0.56, y: 0.42 }]
  },
  {
    id: 'artifacts',
    seconds: (MARKS.editEnd - (MARKS.artifactStart + 4.5)) / 1.7,
    from: MARKS.artifactStart + 4.5,
    rate: 1.7,
    kicker: 'Artifacts',
    title: 'Live UI that builds as it streams, changed in place',
    shots: [{ at: 0, zoom: 1.3, x: 0.56, y: 0.45 }]
  },
  {
    id: 'team',
    seconds: (MARKS.teamEnd - (MARKS.teamStart + 3)) / 1.4,
    from: MARKS.teamStart + 3,
    rate: 1.4,
    kicker: 'Teams',
    title: 'Split work across chats that report back',
    shots: [{ at: 0, zoom: 1.25, x: 0.42, y: 0.45 }]
  },
  {
    id: 'panel',
    seconds: MARKS.panelEnd - MARKS.panelStart,
    from: MARKS.panelStart,
    rate: 1,
    kicker: 'Side panel',
    title: 'Your own terminal and apps beside the chat',
    shots: [{ at: 0, zoom: 1.25, x: 0.7, y: 0.42 }]
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
