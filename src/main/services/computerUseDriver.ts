import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

/**
 * The one build of cua-driver (MIT, https://github.com/trycua/cua) SideKick ships and will start.
 * Anything else at its path is refused.
 */
export const COMPUTER_DRIVER_VERSION = '0.38.0'
const PINNED_WINDOWS_X64: Readonly<Record<string, string>> = {
  'cua-driver.exe': 'ffa58d88779ee219304b0c307f4cfa970fe822f830c6ecf9254eda5c29e22bf2',
  'cua-driver-uia.exe': '69aa6ea0049ce59dfd14593be77c0632f12f6eda3d4a2f4bab1a00e3a72a9754'
}

/**
 * Everything SideKick may reach in the driver. Left out on purpose: starting apps, which SideKick
 * does itself, `run_script`, `run_steps`, the clipboard, whole-display capture, process control and
 * the driver's own settings.
 */
export const COMPUTER_DRIVER_TOOLS = [
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'set_value',
  'scroll',
  'drag',
  'bring_to_front',
  'set_agent_cursor_enabled'
] as const

// A cursor belongs to a session, and a look only counts for clicks in the session that took it, so
// every call names the same one.
const SESSION = 'sidekick'

/** The driver's limits for one chat: deny by default, and only the apps the user approved. */
export function computerDriverManifest(approvedExecutables: readonly string[]): string {
  // JSON strings are valid YAML double-quoted scalars, so no path can break out of its value.
  return [
    'version: 3',
    'expires_after: 1h',
    'idle_timeout: 30m',
    'allow:',
    '  tools:',
    ...COMPUTER_DRIVER_TOOLS.map((tool) => `    - ${tool}`),
    'resources:',
    '  apps:',
    ...approvedExecutables.flatMap((path) => [
      `    - executable: ${JSON.stringify(path)}`,
      '      launch: false',
      '      windows: all',
      '      terminate: deny'
    ]),
    '  desktop:',
    '    display: false',
    ''
  ].join('\n')
}

export function computerDriverEnvironment(
  home: string,
  manifestPath: string
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    // Its state stays in SideKick's folder, not the user's profile.
    USERPROFILE: home,
    HOME: home,
    LOCALAPPDATA: join(home, 'local'),
    APPDATA: join(home, 'roaming'),
    // It reports usage and checks for updates unless told not to.
    DO_NOT_TRACK: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_DISABLED: '1',
    CUA_TELEMETRY_FORBID_NETWORK: '1',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_PERMISSION_MODE: 'bounded',
    CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifestPath,
    CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: '1'
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(path))
    .digest('hex')
}

/** Refuses anything but the pinned build, including a sidecar swapped in beside it. */
export async function verifyComputerDriver(driverPath: string): Promise<void> {
  const folder = dirname(driverPath)
  for (const [file, expected] of Object.entries(PINNED_WINDOWS_X64)) {
    const actual = await sha256(join(folder, file)).catch(() => null)
    if (actual !== expected) {
      throw new Error(
        `${file} is not the cua-driver ${COMPUTER_DRIVER_VERSION} build SideKick accepts.`
      )
    }
  }
}

export interface ComputerDriverResult {
  isError: boolean
  text: string
  images: Array<{ mimeType: string; data: string }>
  structured?: unknown
}

/** In physical pixels, as Windows reports them. */
export interface ComputerWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What a field holds, from a look's structured detail. Null for a row that can't be set. */
export function computerRowValues(structured: unknown): Map<number, string> {
  const elements = (structured as { elements?: unknown } | null | undefined)?.elements
  const values = new Map<number, string>()
  if (!Array.isArray(elements)) return values
  for (const element of elements as Array<{
    element_index?: unknown
    value?: unknown
    actions?: unknown
  }>) {
    if (
      typeof element?.element_index === 'number' &&
      Array.isArray(element.actions) &&
      element.actions.includes('set_value')
    ) {
      values.set(element.element_index, typeof element.value === 'string' ? element.value : '')
    }
  }
  return values
}

/** The middle of each numbered row, as a screen point, from a look's structured detail. */
export function computerRowPoints(structured: unknown): Map<number, { x: number; y: number }> {
  const elements = (structured as { elements?: unknown } | null | undefined)?.elements
  const points = new Map<number, { x: number; y: number }>()
  if (!Array.isArray(elements)) return points
  for (const element of elements as Array<{
    element_index?: unknown
    frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  }>) {
    const { x, y, w, h } = element?.frame ?? {}
    if (
      typeof element?.element_index === 'number' &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof w === 'number' &&
      typeof h === 'number'
    ) {
      points.set(element.element_index, { x: Math.round(x + w / 2), y: Math.round(y + h / 2) })
    }
  }
  return points
}

/** What it takes to find a row's control again, without the driver. */
export interface ComputerRowControl {
  label: string
  frame: ComputerWindowBounds
  actions: string[]
}

/** The rows that can be found again and pressed, from a look's structured detail. */
export function computerRowControls(structured: unknown): Map<number, ComputerRowControl> {
  const elements = (structured as { elements?: unknown } | null | undefined)?.elements
  const controls = new Map<number, ComputerRowControl>()
  if (!Array.isArray(elements)) return controls
  for (const element of elements as Array<{
    element_index?: unknown
    label?: unknown
    actions?: unknown
    frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  }>) {
    const { x, y, w, h } = element?.frame ?? {}
    if (
      typeof element?.element_index === 'number' &&
      typeof element.label === 'string' &&
      element.label &&
      Array.isArray(element.actions) &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof w === 'number' &&
      typeof h === 'number'
    ) {
      controls.set(element.element_index, {
        label: element.label,
        frame: { x, y, width: w, height: h },
        actions: element.actions.map(String)
      })
    }
  }
  return controls
}

/** A control that can open and close, in physical pixels. */
export interface ComputerExpandState {
  x: number
  y: number
  width: number
  height: number
  expanded: boolean
  label: string
}

/** Whether any row of a look can open and close, which is worth asking Windows about. */
export function computerHasExpandingRows(structured: unknown): boolean {
  const elements = (structured as { elements?: unknown } | null | undefined)?.elements
  return (
    Array.isArray(elements) &&
    (elements as Array<{ actions?: unknown }>).some(
      (element) => Array.isArray(element?.actions) && element.actions.includes('expand')
    )
  )
}

/**
 * A look's list with what each row is set to. The driver keeps whether a box is checked in its detail
 * and leaves it out of the list, so a list read the same either way, and a model with no picture
 * couldn't tell. Being in the list also makes a change of state count as the row changing.
 */
export function computerMarkRowStates(
  text: string,
  structured: unknown,
  expanding: readonly ComputerExpandState[]
): string {
  const elements = (structured as { elements?: unknown } | null | undefined)?.elements
  if (!Array.isArray(elements)) return text
  const states = new Map<number, string>()
  for (const element of elements as Array<{
    element_index?: unknown
    label?: unknown
    selected?: unknown
    actions?: unknown
    frame?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
  }>) {
    if (typeof element?.element_index !== 'number' || !Array.isArray(element.actions)) continue
    const words: string[] = []
    if (element.actions.includes('toggle') && typeof element.selected === 'boolean') {
      words.push(element.selected ? 'checked' : 'not checked')
    } else if (element.selected === true) {
      words.push('selected')
    }
    const frame = element.frame
    if (element.actions.includes('expand') && frame) {
      // By name where there is one: an older app's controls can report a different place to each asker.
      const named = element.label
        ? expanding.filter((control) => control.label === element.label)
        : []
      const found =
        named.length === 1
          ? named[0]
          : (named.length ? named : expanding).find(
              (control) =>
                Math.abs(control.x - Number(frame.x)) <= 3 &&
                Math.abs(control.y - Number(frame.y)) <= 3 &&
                Math.abs(control.width - Number(frame.w)) <= 3 &&
                Math.abs(control.height - Number(frame.h)) <= 3
            )
      if (found) words.push(found.expanded ? 'expanded' : 'collapsed')
    }
    if (words.length) states.set(element.element_index, words.join(', '))
  }
  if (!states.size) return text
  return text
    .split('\n')
    .map((line) => {
      const state = states.get(Number(/^\W*\[(\d+)\] /.exec(line)?.[1]))
      return state ? `${line} (${state})` : line
    })
    .join('\n')
}

// Below this many lines the whole list is short enough to read. What takes it over is a dense app's
// long lists and toolbars, where the first look alone is thousands of tokens.
const SHORT_LIST_ABOVE = 120
const SHORT_LIST_LINES = 70

/**
 * A long list with its deepest parts left out, from the top down, so the shape of the app stays and what
 * is left out can be read by asking. Each one left out joins `parts`, and says which it is. Rows keep
 * their numbers, listed or not. Null if the list is short enough as it is.
 */
export function computerShortList(tree: string, parts: string[]): string | null {
  const lines = tree.split('\n')
  interface Row {
    at: number
    indent: number
    children: Row[]
    /** The first line past it and everything under it. */
    end: number
  }
  const rows: Row[] = []
  const roots: Row[] = []
  const open: Row[] = []
  lines.forEach((line, at) => {
    if (!/^\s*- /.test(line)) return
    const row: Row = { at, indent: line.search(/\S/), children: [], end: lines.length }
    while (open.length && open[open.length - 1].indent >= row.indent) {
      open.pop()!.end = at
    }
    ;(open[open.length - 1]?.children ?? roots).push(row)
    open.push(row)
    rows.push(row)
  })
  if (rows.length <= SHORT_LIST_ABOVE) return null
  const shown = new Set<Row>(roots)
  const queue = [...roots]
  const leftOut = new Set<Row>()
  for (const row of queue) {
    if (!row.children.length) continue
    if (shown.size + row.children.length > SHORT_LIST_LINES) {
      leftOut.add(row)
      continue
    }
    for (const child of row.children) shown.add(child)
    queue.push(...row.children)
  }
  const kept: string[] = lines.slice(0, roots[0]?.at ?? 0)
  rows.forEach((row, index) => {
    if (!shown.has(row)) return
    if (leftOut.has(row)) {
      const inside = lines.slice(row.at + 1, row.end)
      parts.push(inside.join('\n'))
      const more = inside.filter((line) => /^\s*- /.test(line)).length
      kept.push(`${lines[row.at]} (${more} more inside: part ${parts.length})`)
    } else {
      // Whatever belongs to a row and isn't a row of its own, up to the next one.
      kept.push(...lines.slice(row.at, rows[index + 1]?.at ?? lines.length))
    }
  })
  return kept.join('\n')
}

/** Where an action landed, from what the driver reports. Typing has no such place. */
export function computerActionPoint(text: string): { x: number; y: number } | null {
  const points = [...text.matchAll(/(?:screen |\bat )\((\d+),\s*(\d+)\)|→ \((\d+),\s*(\d+)\)/g)]
  const last = points.at(-1)
  if (!last) return null
  return { x: Number(last[1] ?? last[3]), y: Number(last[2] ?? last[4]) }
}

export type ComputerDriverCall = (
  tool: (typeof COMPUTER_DRIVER_TOOLS)[number],
  args: Record<string, unknown>,
  signal: AbortSignal
) => Promise<ComputerDriverResult>

export interface ComputerDriver {
  call: ComputerDriverCall
  close: () => Promise<void>
}

/** Starts the driver as a child process; it stops when its input closes. */
export async function startComputerDriver(
  driverPath: string,
  dataFolder: string,
  approvedExecutables: readonly string[]
): Promise<ComputerDriver> {
  await verifyComputerDriver(driverPath)
  const home = join(dataFolder, 'home')
  await fs.mkdir(join(home, 'local'), { recursive: true })
  await fs.mkdir(join(home, 'roaming'), { recursive: true })
  const manifestPath = join(dataFolder, 'manifest.yaml')
  await fs.writeFile(manifestPath, computerDriverManifest(approvedExecutables), 'utf8')
  const transport = new StdioClientTransport({
    command: driverPath,
    args: ['mcp'],
    env: computerDriverEnvironment(home, manifestPath),
    stderr: 'ignore'
  })
  const client = new Client({ name: 'sidekick-computer-use', version: COMPUTER_DRIVER_VERSION })
  await client.connect(transport, { timeout: 20_000 })
  // SideKick draws the agent's pointer itself. With the driver's on top, two moved at different rates.
  await client.callTool(
    { name: 'set_agent_cursor_enabled', arguments: { session: SESSION, enabled: false } },
    undefined,
    { timeout: 20_000 }
  )
  return {
    call: async (tool, args, signal) => {
      const result = await client.callTool(
        { name: tool, arguments: { ...args, session: SESSION } },
        undefined,
        { signal, timeout: 45_000 }
      )
      const content = (Array.isArray(result.content) ? result.content : []) as Array<{
        type: string
        text?: string
        data?: string
        mimeType?: string
      }>
      return {
        isError: result.isError === true,
        text: content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('\n'),
        images: content.flatMap((part) =>
          part.type === 'image' && part.data
            ? [{ mimeType: part.mimeType ?? 'image/png', data: part.data }]
            : []
        ),
        structured: result.structuredContent
      }
    },
    close: () => client.close()
  }
}
