import { AbsoluteFill } from 'remotion'
import { AppWindow, type Shot } from './components/AppWindow'
import { Backdrop } from './components/Backdrop'
import { Caption } from './components/Caption'

export interface FeatureProps {
  /** Seconds into the recording the clip starts. */
  from: number
  rate?: number
  shots?: Shot[]
  kicker: string
  title: string
}

/** One feature: the real app doing it, with a slow camera and a caption. */
export function Feature({ from, rate, shots, kicker, title }: FeatureProps): React.JSX.Element {
  return (
    <AbsoluteFill>
      <Backdrop />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 36 }}>
        <AppWindow from={from} rate={rate} shots={shots} width={1080} />
      </AbsoluteFill>
      <Caption kicker={kicker} title={title} />
    </AbsoluteFill>
  )
}
