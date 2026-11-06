export interface CapeSurface {
  x: number
  y: number
  tx: number
  ty: number
}

interface Point {
  x: number
  y: number
}

const SIZE = 1.45
const CENTER = 0.58
export const CAPE_EMBLEM_STROKE = 9 * SIZE

function line(from: Point, to: Point, steps = 12): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = i / steps
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  })
}

function curve(from: Point, control: Point, to: Point): Point[] {
  return Array.from({ length: 16 }, (_, i) => {
    const t = i / 16
    const u = 1 - t
    return {
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y
    }
  })
}

const shield = [
  ...line({ x: -45, y: -39 }, { x: 45, y: -39 }),
  ...line({ x: 45, y: -39 }, { x: 40, y: 18 }),
  ...curve({ x: 40, y: 18 }, { x: 31, y: 43 }, { x: 0, y: 61 }),
  ...curve({ x: 0, y: 61 }, { x: -31, y: 43 }, { x: -40, y: 18 }),
  ...line({ x: -40, y: 18 }, { x: -45, y: -39 })
]
const chevron = [
  ...line({ x: -22, y: -15 }, { x: -6, y: 0 }),
  ...line({ x: -6, y: 0 }, { x: -22, y: 15 }),
  { x: -22, y: 15 }
]
const cursor = [...line({ x: 7, y: 17 }, { x: 26, y: 17 }), { x: 26, y: 17 }]

/** One printed emblem for both the generated drawing and the moving cloth. */
export function capeEmblemPaths(surface: (position: number) => CapeSurface): {
  shield: string
  mark: string
} {
  const project = (point: Point): Point => {
    const along = (point.y - 11) * SIZE
    const at = surface(CENTER + along / 470)
    const across = point.x / 54
    const cross = 49 * SIZE * Math.sin(across * 1.12)
    const fold = 11 * Math.sin(across * Math.PI * 0.95 + 0.4)
    return {
      x: at.x + at.ty * cross + at.tx * fold,
      y: at.y - at.tx * cross + at.ty * fold
    }
  }
  const path = (points: Point[]): string =>
    points
      .map((point, index) => {
        const p = project(point)
        return `${index ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`
      })
      .join(' ')
  return { shield: `${path(shield)} Z`, mark: `${path(chevron)} ${path(cursor)}` }
}
