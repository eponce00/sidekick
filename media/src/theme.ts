import { loadFont } from '@remotion/google-fonts/Inter'
import marks from '../public/clips/session.json'

export const { fontFamily } = loadFont('normal', {
  weights: ['500', '600', '700'],
  subsets: ['latin']
})

export const FPS = 30
export const WIDTH = 1280
export const HEIGHT = 720

// SideKick's own dark theme, so the frame around the app reads as part of it.
export const COLORS = {
  background: '#08090c',
  surface: '#131313',
  border: 'rgba(255, 255, 255, 0.09)',
  text: '#ececec',
  muted: '#a9a9a9',
  accent: '#86aee8',
  teal: '#5fc7b8',
  amber: '#e3b16a',
  violet: '#b19be9'
}

/** Seconds into the recording where each scene starts and ends. */
export const MARKS = marks as Record<string, number>

/** Frames for `seconds`. */
export const sec = (seconds: number): number => Math.round(seconds * FPS)
