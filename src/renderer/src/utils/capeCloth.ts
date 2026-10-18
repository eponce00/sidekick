/**
 * The robot's cape as cloth. Seen from the side, a cape bends along its length the way a heavy
 * ribbon does, so it is simulated as a chain of particles from the neck to the hem, integrated
 * with Verlet steps (positions, with velocity implied by the last move) and held together by
 * distance constraints, the way games simulate cloth and rope. Gravity pulls every particle, so in
 * still air it hangs and drapes; wind streams it back, with turbulence running down it as ripples;
 * a pointer brushing through it or a flick moves each part separately. The fabric is drawn around
 * the chain, widening toward a scalloped hem, so it folds wherever the chain bends.
 *
 * Coordinates are the drawing's own (the cape group's), y pointing down.
 */
export interface Point {
  x: number
  y: number
}

// Where the cape fastens, under the back of the head, and the direction it leaves the neck: down
// and back, over the robot's shoulders. Fastened under the chin it would hang like a tie.
const NECK: Point = { x: -112, y: 196 }
const NECK_LEAVES: Point = { x: -0.62, y: 0.78 }
// The head is drawn tilted 8 degrees, so the screen's down is turned in the drawing's axes.
const TILT = (8 * Math.PI) / 180
const DOWN: Point = { x: -Math.sin(TILT), y: Math.cos(TILT) }
// Wind blows back past the robot as it flies in from the right: to the left, rising slightly.
const WIND: Point = { x: -0.985, y: -0.17 }

const SEGMENTS = 14
const LENGTH = 470
const NECK_WIDTH = 84
const HEM_WIDTH = 290
// How far the hem's two soft scallops reach past its line.
const HEM_WAVE = 30
// The creases, as offsets across the cape from its middle: toward the outer edge and the inner.
const FOLDS = [0.3, -0.34]
// Gravity and full-gust wind, in drawing units per second squared. Gravity sets the swing: a
// pendulum the cape's length swings in about a second and a half.
const GRAVITY = 7_200
const GUST_FORCE = 15_500
// A light breeze always moves the air, as it would round a hovering hero: at rest the cape drapes
// back and sways a little rather than hanging dead.
const BREEZE = 0.22
const STEP = 1 / 120
const SOLVER_PASSES = 8
// Air resistance: the share of its velocity a particle keeps each step.
const DRAG = 0.986
// Resistance to bending, from none to rigid: cloth folds in soft curves, not kinks.
const BEND = 0.1
// How much of the next particle's length correction each one gives back as velocity.
const FOLLOW_DAMPING = 0.9

interface Particle {
  x: number
  y: number
  px: number
  py: number
}

export class CapeCloth {
  private readonly chain: Particle[] = []
  private readonly segment = LENGTH / SEGMENTS
  private time = 0
  private carry = 0

  /**
   * Lays the chain out from the neck at `angle` degrees: 0 streams straight back, 90 hangs
   * straight down. The drawn icon has it streaming back as it flies in.
   */
  constructor(angle = 12) {
    const radians = (angle * Math.PI) / 180
    const direction = { x: -Math.cos(radians), y: Math.sin(radians) }
    for (let i = 0; i <= SEGMENTS; i += 1) {
      // The first link leaves the neck the way the cape lies over the shoulders.
      const lead = Math.min(i, 1)
      const x =
        NECK.x +
        NECK_LEAVES.x * this.segment * lead +
        direction.x * this.segment * Math.max(0, i - 1)
      const y =
        NECK.y +
        NECK_LEAVES.y * this.segment * lead +
        direction.y * this.segment * Math.max(0, i - 1)
      this.chain.push({ x, y, px: x, py: y })
    }
  }

  /** Advances by `seconds` of real time, in fixed steps so it behaves alike at any frame rate. */
  step(seconds: number, wind: number): void {
    this.carry = Math.min(this.carry + Math.max(0, seconds), 0.1)
    while (this.carry >= STEP) {
      this.carry -= STEP
      this.time += STEP
      this.integrate(Math.max(BREEZE, wind))
      for (let pass = 0; pass < SOLVER_PASSES; pass += 1) this.solve()
      this.inextensible()
    }
  }

  /**
   * A last pass from the neck out sets every link to its exact length, as in rope and hair
   * simulation, so however hard it is thrown the cloth never looks rubbery. Moving a particle
   * also moves its implied velocity, which would pump energy in; each particle gives back the
   * share of the next one's correction, as in dynamic follow-the-leader (Müller et al., 2012).
   */
  private inextensible(): void {
    const moved: Point[] = this.chain.map(() => ({ x: 0, y: 0 }))
    for (let i = 2; i <= SEGMENTS; i += 1) {
      const p = this.chain[i - 1]
      const q = this.chain[i]
      const dx = q.x - p.x
      const dy = q.y - p.y
      const distance = Math.hypot(dx, dy) || 1e-6
      const x = p.x + (dx / distance) * this.segment
      const y = p.y + (dy / distance) * this.segment
      moved[i] = { x: x - q.x, y: y - q.y }
      q.x = x
      q.y = y
    }
    for (let i = 2; i < SEGMENTS; i += 1) {
      this.chain[i].px += moved[i + 1].x * FOLLOW_DAMPING
      this.chain[i].py += moved[i + 1].y * FOLLOW_DAMPING
    }
    // The hem has no follower to balance it; it keeps only part of its correction as motion.
    this.chain[SEGMENTS].px += moved[SEGMENTS].x * 0.5
    this.chain[SEGMENTS].py += moved[SEGMENTS].y * 0.5
  }

  private integrate(wind: number): void {
    const t = this.time
    for (let i = 2; i <= SEGMENTS; i += 1) {
      const p = this.chain[i]
      const reach = i / SEGMENTS
      // The wind's push varies in time and along the cloth, so it billows unevenly, and a flutter
      // across the cloth runs down it from the neck as a travelling wave.
      const swirl = 1 + 0.4 * Math.sin(t * 3.7 + i * 0.55) + 0.2 * Math.sin(t * 7.9 - i * 1.3)
      const push = GUST_FORCE * wind * (0.3 + 0.7 * reach) * swirl
      // Flutter grows faster than the wind: a breeze ripples the cloth, a gust snaps it.
      const flutter = GUST_FORCE * wind ** 1.6 * 0.6 * reach * Math.sin(t * 10.5 - i * 0.95)
      const before = this.chain[i - 1]
      const tx = p.x - before.x
      const ty = p.y - before.y
      const tl = Math.hypot(tx, ty) || 1
      const ax = GRAVITY * DOWN.x + push * WIND.x - flutter * (ty / tl)
      const ay = GRAVITY * DOWN.y + push * WIND.y + flutter * (tx / tl)
      const vx = (p.x - p.px) * DRAG
      const vy = (p.y - p.py) * DRAG
      p.px = p.x
      p.py = p.y
      p.x += vx + ax * STEP * STEP
      p.y += vy + ay * STEP * STEP
    }
  }

  private solve(): void {
    // The first two particles are fastened at the neck; every link keeps its length.
    for (let i = 1; i < SEGMENTS; i += 1) this.keep(i, i + 1, this.segment, 1, i === 1)
    // A soft pull across every other particle resists sharp bends.
    for (let i = 0; i < SEGMENTS - 1; i += 1) this.keep(i, i + 2, this.segment * 2, BEND, i <= 1)
  }

  private keep(a: number, b: number, rest: number, stiffness: number, firstFixed: boolean): void {
    const p = this.chain[a]
    const q = this.chain[b]
    const dx = q.x - p.x
    const dy = q.y - p.y
    const distance = Math.hypot(dx, dy) || 1e-6
    const correction = ((distance - rest) / distance) * stiffness
    if (firstFixed || a <= 1) {
      q.x -= dx * correction
      q.y -= dy * correction
      return
    }
    p.x += dx * correction * 0.5
    p.y += dy * correction * 0.5
    q.x -= dx * correction * 0.5
    q.y -= dy * correction * 0.5
  }

  /**
   * Something moving through the cloth at `velocity` (units per second) drags the parts it
   * touches along with it, most at its centre and none beyond `radius`.
   */
  brush(point: Point, velocity: Point, radius = 140): void {
    for (let i = 2; i <= SEGMENTS; i += 1) {
      const p = this.chain[i]
      const distance = Math.hypot(p.x - point.x, p.y - point.y)
      if (distance >= radius) continue
      const falloff = (1 - distance / radius) ** 2 * 0.32
      p.px -= velocity.x * STEP * falloff
      p.py -= velocity.y * STEP * falloff
    }
  }

  /** A flick: the cloth is thrown up and back, the more the further it is from the neck. */
  flick(): void {
    for (let i = 2; i <= SEGMENTS; i += 1) {
      const reach = i / SEGMENTS
      this.chain[i].px += 1_250 * reach * STEP
      this.chain[i].py += 2_100 * reach * STEP
    }
  }

  /** The mean particle speed, in units per second. */
  speed(): number {
    let total = 0
    for (const p of this.chain) total += Math.hypot(p.x - p.px, p.y - p.py)
    return total / this.chain.length / STEP
  }

  /** The free end of the chain, at the middle of the hem. */
  hem(): Point {
    const p = this.chain[SEGMENTS]
    return { x: p.x, y: p.y }
  }

  /** The neck, where the cape is fastened. */
  neck(): Point {
    return { ...NECK }
  }

  /** How far the most stretched link is from its length, as a share of it. */
  maxStretch(): number {
    let worst = 0
    for (let i = 1; i < SEGMENTS; i += 1) {
      const p = this.chain[i]
      const q = this.chain[i + 1]
      worst = Math.max(
        worst,
        Math.abs(Math.hypot(q.x - p.x, q.y - p.y) - this.segment) / this.segment
      )
    }
    return worst
  }

  /**
   * The cape as one piece of fabric, as SVG paths: its outline with a softly waving hem, and the
   * creases where it folds. The fabric is laid around the chain, each particle's edges across the
   * chain's direction there, so wherever the chain bends the cloth bends with it; the creases
   * deepen with the bend. `shade` runs from the neck to the hem, for shading that darkens toward
   * the head.
   */
  paths(): { cape: string; folds: string; shade: { from: Point; to: Point } } {
    const upper: Point[] = []
    const lower: Point[] = []
    const across: Point[] = []
    const halves: number[] = []
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const p = this.chain[i]
      const before = this.chain[Math.max(0, i - 1)]
      const after = this.chain[Math.min(SEGMENTS, i + 1)]
      const tx = after.x - before.x
      const ty = after.y - before.y
      const tl = Math.hypot(tx, ty) || 1
      // Across the chain, toward the side the wind lifts: the cape's outer edge.
      const normal = { x: ty / tl, y: -tx / tl }
      const half = (NECK_WIDTH + (HEM_WIDTH - NECK_WIDTH) * (i / SEGMENTS) ** 0.85) / 2
      across.push(normal)
      halves.push(half)
      upper.push({ x: p.x + normal.x * half, y: p.y + normal.y * half })
      lower.push({ x: p.x - normal.x * half, y: p.y - normal.y * half })
    }
    // The hem waves gently in two soft scallops rather than cutting into points.
    const end = this.chain[SEGMENTS]
    const last = this.chain[SEGMENTS - 1]
    const outLength = Math.hypot(end.x - last.x, end.y - last.y) || 1
    const out = { x: (end.x - last.x) / outLength, y: (end.y - last.y) / outLength }
    const hem = [0, 0.25, 0.5, 0.75, 1].map((t, index) => {
      const base = mix(upper[SEGMENTS], lower[SEGMENTS], t)
      const reach = [0, HEM_WAVE, HEM_WAVE * 0.15, HEM_WAVE, 0][index]
      return { x: base.x + out.x * reach, y: base.y + out.y * reach }
    })
    const cape =
      `M${fmt(upper[0])}` + smooth(upper) + smooth(hem) + smooth([...lower].reverse()) + ' Z'

    // How sharply the chain turns at each particle, smoothed along it.
    const bend = this.chain.map((p, i) => {
      if (i === 0 || i === SEGMENTS) return 0
      const a = this.chain[i - 1]
      const c = this.chain[i + 1]
      const cross = (p.x - a.x) * (c.y - p.y) - (p.y - a.y) * (c.x - p.x)
      return cross / (this.segment * this.segment)
    })
    const soft = bend.map(
      (value, i) => (value + (bend[i - 1] ?? value) + (bend[i + 1] ?? value)) / 3
    )
    const folds = FOLDS.map((offset) => {
      const left: Point[] = []
      const right: Point[] = []
      for (let i = 2; i <= SEGMENTS; i += 1) {
        const p = this.chain[i]
        const n = across[i]
        const half = halves[i]
        // A crease starts thin under the neck, deepens where the cloth bends on its side, and
        // fades out before the hem.
        const grow = Math.min(1, (i - 2) / 3) * (i === SEGMENTS ? 0.4 : 1)
        const deepen = Math.max(0, Math.sign(offset) * soft[i]) * 0.7 + Math.abs(soft[i]) * 0.25
        const width = half * Math.min(0.16, 0.03 + deepen) * grow
        const centre = { x: p.x + n.x * half * offset, y: p.y + n.y * half * offset }
        left.push({ x: centre.x + n.x * width, y: centre.y + n.y * width })
        right.push({ x: centre.x - n.x * width, y: centre.y - n.y * width })
      }
      return (
        `M${fmt(left[0])}` +
        smooth(left) +
        ` L${fmt(right.at(-1)!)}` +
        smooth([...right].reverse()) +
        ' Z'
      )
    }).join(' ')
    return {
      cape,
      folds,
      shade: { from: { x: this.chain[0].x, y: this.chain[0].y }, to: { x: end.x, y: end.y } }
    }
  }
}

const fmt = (p: Point): string => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`
const mix = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
})

/** Catmull-Rom through the points as cubic Béziers, starting from the first (already drawn). */
function smooth(points: Point[]): string {
  let d = ''
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    d += ` C${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`
  }
  return d
}
