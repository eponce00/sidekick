export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface StoredWindowState extends WindowBounds {
  maximized: boolean
}

const MIN_WIDTH = 720
const MIN_HEIGHT = 520

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseStoredWindowState(value: unknown): StoredWindowState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StoredWindowState>
  if (
    !isFiniteNumber(candidate.x) ||
    !isFiniteNumber(candidate.y) ||
    !isFiniteNumber(candidate.width) ||
    !isFiniteNumber(candidate.height)
  ) {
    return null
  }
  if (candidate.width < MIN_WIDTH || candidate.height < MIN_HEIGHT) return null
  return {
    x: Math.round(candidate.x),
    y: Math.round(candidate.y),
    width: Math.round(candidate.width),
    height: Math.round(candidate.height),
    maximized: candidate.maximized === true
  }
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  )
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  )
  return width * height
}

export function visibleWindowBounds(
  state: StoredWindowState | null,
  workAreas: readonly WindowBounds[]
): WindowBounds | null {
  if (!state || workAreas.length === 0) return null
  const target = workAreas
    .map((workArea) => ({ workArea, overlap: intersectionArea(state, workArea) }))
    .sort((left, right) => right.overlap - left.overlap)[0]
  if (!target || target.overlap < 42 * 42) return null

  const width = Math.min(state.width, target.workArea.width)
  const height = Math.min(state.height, target.workArea.height)
  return {
    x: Math.min(
      Math.max(state.x, target.workArea.x),
      target.workArea.x + target.workArea.width - width
    ),
    y: Math.min(
      Math.max(state.y, target.workArea.y),
      target.workArea.y + target.workArea.height - height
    ),
    width,
    height
  }
}
