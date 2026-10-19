/**
 * Wind made visible, as in a comic panel: when a gust blows, streaks sweep past the robot from
 * behind the side panel and off across the chat, some ending in a curl, so it is plain what moves
 * the cape. Each streak draws itself on as it enters and shortens as it leaves. Coordinates are
 * the cape's own (see capeCloth), y pointing down; streaks travel toward negative x.
 */
import type { Point } from './capeCloth'

export interface StreakPath {
  d: string
  opacity: number
}

interface Streak {
  x: number
  y: number
  length: number
  speed: number
  age: number
  life: number
  wave: number
  curl: boolean
}

// Streaks enter behind the panel's edge and leave past the frame's left side.
const ENTER_X = 240
const LEAVE_X = -700
// The bands they pass through: around the head and along the cape.
const BANDS: Array<[number, number]> = [
  [-250, -80],
  [140, 470]
]
export const MAX_STREAKS = 8
// Wind below this is a breeze, too light to show; above it streaks come faster as it rises.
const SHOWS_FROM = 0.22
const STREAKS_PER_SECOND_AT_FULL = 14
const FADE_SECONDS = 0.18

export class WindStreaks {
  private readonly streaks: Streak[] = []
  private due = 0
  private wind = 0

  constructor(private readonly random: () => number = Math.random) {}

  /** Advances the streaks and starts new ones at a rate that follows the wind. */
  step(seconds: number, wind: number): void {
    this.wind = wind
    for (const streak of this.streaks) {
      streak.age += seconds
      streak.x -= streak.speed * seconds
    }
    for (let i = this.streaks.length - 1; i >= 0; i -= 1) {
      if (this.streaks[i].age >= this.streaks[i].life) this.streaks.splice(i, 1)
    }
    if (wind <= SHOWS_FROM) {
      this.due = 0
      return
    }
    this.due += ((wind - SHOWS_FROM) / (1 - SHOWS_FROM)) * STREAKS_PER_SECOND_AT_FULL * seconds
    while (this.due >= 1 && this.streaks.length < MAX_STREAKS) {
      this.due -= 1
      this.spawn()
    }
    this.due = Math.min(this.due, 1)
  }

  /** A gust arriving: a few streaks at once, so its start is plain to see. */
  burst(count = 3): void {
    for (let i = 0; i < count && this.streaks.length < MAX_STREAKS; i += 1) {
      this.spawn()
      // Spread out, as if the gust had been arriving for a moment already.
      const streak = this.streaks.at(-1)!
      streak.age = (i * 0.06) % streak.life
      streak.x = ENTER_X - streak.speed * streak.age
    }
  }

  private spawn(): void {
    const [top, bottom] = BANDS[this.random() < 0.35 ? 0 : 1]
    const speed = 1_250 + this.random() * 550
    this.streaks.push({
      x: ENTER_X,
      y: top + (bottom - top) * this.random(),
      length: 220 + this.random() * 170,
      speed,
      age: 0,
      life: (ENTER_X - LEAVE_X) / speed,
      wave: this.random() * Math.PI * 2,
      curl: this.random() < 0.4
    })
  }

  /** How many streaks are in the air. */
  count(): number {
    return this.streaks.length
  }

  /** Each streak as a stroke, with how strongly it shows. */
  paths(): StreakPath[] {
    return this.streaks.map((streak) => {
      // The leading end moves at full speed; the trailing end starts at the entry and lags until
      // the streak has its length, and catches up as it leaves.
      const head = streak.x
      const drawn = Math.min(streak.length, streak.speed * streak.age)
      const left = streak.life - streak.age
      const tail = head + Math.min(drawn, streak.speed * Math.max(0, left) * 1.5)
      const points: Point[] = []
      for (let i = 0; i <= 6; i += 1) {
        const x = tail + ((head - tail) * i) / 6
        points.push({ x, y: streak.y + Math.sin(x / 90 + streak.wave) * 9 })
      }
      let d = `M${fmt(points[0])}`
      for (let i = 1; i < points.length; i += 1) d += ` L${fmt(points[i])}`
      if (streak.curl && head - tail > 60) {
        // A small curl at the leading end, turning back over the streak, like a gust's swirl.
        const end = points.at(-1)!
        d += ` C${fmt({ x: end.x - 34, y: end.y })} ${fmt({ x: end.x - 40, y: end.y - 34 })} ${fmt({ x: end.x - 16, y: end.y - 36 })}`
        d += ` C${fmt({ x: end.x + 4, y: end.y - 37 })} ${fmt({ x: end.x + 6, y: end.y - 18 })} ${fmt({ x: end.x - 8, y: end.y - 14 })}`
      }
      const fade = Math.min(1, streak.age / FADE_SECONDS, left / FADE_SECONDS)
      return { d, opacity: Math.max(0, fade) * Math.min(0.85, 0.4 + this.wind * 0.5) }
    })
  }
}

const fmt = (p: Point): string => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`
