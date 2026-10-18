/**
 * The robot's cape as a damped spring. Gravity holds it at a sag below the pose it is drawn in;
 * wind lifts it back toward that billow; the spring is underdamped, so it overshoots and swings
 * a little before it settles, as cloth does. Wind dies away on its own, and while it blows the
 * cape flutters. Angles are degrees, in SVG's sense: positive rotates clockwise, which lifts a
 * cape that trails to the left.
 */
export interface CapeState {
  angle: number
  velocity: number
  /** 0 is still air; 1 is a strong gust. */
  wind: number
  /** Seconds since the cape started moving, for the flutter's phase. */
  time: number
}

export interface CapePose {
  angle: number
  /** How far the cloth stretches out along its length, as a scale. */
  stretch: number
  /** A ripple running along the cloth, as a skew in degrees. */
  skew: number
}

/** Where gravity leaves it: hanging below the drawn billow. */
export const CAPE_REST_ANGLE = -11
// How far above rest a full wind lifts it, and the spring that pulls it toward its target.
const WIND_LIFT = 16
const STIFFNESS = 40
const DAMPING = 5.2
// Wind falls by half in about half a second.
const WIND_DECAY_PER_SECOND = 1.4
// A flick: the speed, in degrees per second, a click throws the cape upward with.
const WHIP_VELOCITY = 260

/** The cape as the robot arrives: still lifted from flying in, about to drop and swing. */
export function arrivingCape(): CapeState {
  return { angle: CAPE_REST_ANGLE + WIND_LIFT * 0.9, velocity: 0, wind: 0, time: 0 }
}

/** A gust of the given strength; a weaker one does not calm a stronger one already blowing. */
export function gust(state: CapeState, strength: number): CapeState {
  return { ...state, wind: Math.max(state.wind, Math.min(1, Math.max(0, strength))) }
}

/** A click flicks the cape up, with a gust behind it. */
export function whip(state: CapeState): CapeState {
  return { ...gust(state, 0.85), velocity: state.velocity + WHIP_VELOCITY }
}

export function stepCape(state: CapeState, seconds: number): CapeState {
  const target = CAPE_REST_ANGLE + WIND_LIFT * state.wind
  const acceleration = STIFFNESS * (target - state.angle) - DAMPING * state.velocity
  const velocity = state.velocity + acceleration * seconds
  return {
    angle: state.angle + velocity * seconds,
    velocity,
    wind: state.wind * Math.exp(-WIND_DECAY_PER_SECOND * seconds),
    time: state.time + seconds
  }
}

/** The pose to draw: the spring's angle, with a flutter that only wind makes. */
export function capePose(state: CapeState): CapePose {
  const { wind, time } = state
  return {
    angle: state.angle + wind * 3 * Math.sin(time * 13),
    stretch: 1 + wind * (0.05 + 0.015 * Math.sin(time * 9)),
    skew: wind * 4 * Math.sin(time * 10 + 1.3)
  }
}

/** Still enough to stop animating until the next gust. */
export function capeSettled(state: CapeState): boolean {
  return (
    state.wind < 0.01 &&
    Math.abs(state.velocity) < 0.5 &&
    Math.abs(state.angle - CAPE_REST_ANGLE) < 0.2
  )
}

/** Pointer speed, in pixels per millisecond, as wind: a quick sweep past the robot is a gust. */
export function pointerWind(speed: number): number {
  return Math.min(1, Math.max(0, (speed - 0.4) * 0.45))
}
