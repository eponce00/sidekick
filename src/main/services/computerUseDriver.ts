import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

/**
 * The one build of cua-driver (MIT, https://github.com/trycua/cua) SideKick will start. A path in
 * settings says where it is, never what it is: anything else at that path is refused.
 */
export const COMPUTER_DRIVER_VERSION = '0.38.0'
const PINNED_WINDOWS_X64: Readonly<Record<string, string>> = {
  'cua-driver.exe': 'ffa58d88779ee219304b0c307f4cfa970fe822f830c6ecf9254eda5c29e22bf2',
  'cua-driver-uia.exe': '69aa6ea0049ce59dfd14593be77c0632f12f6eda3d4a2f4bab1a00e3a72a9754'
}

/**
 * Everything the agent may reach in the driver. Left out on purpose: starting apps, `run_script`,
 * `run_steps`, the clipboard, whole-display capture, process control and the driver's own settings.
 */
export const COMPUTER_DRIVER_TOOLS = [
  'list_windows',
  'get_window_state',
  'click',
  'double_click',
  'right_click',
  'type_text',
  'press_key',
  'set_value',
  'scroll'
] as const

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
  return {
    call: async (tool, args, signal) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        signal,
        timeout: 45_000
      })
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
        )
      }
    },
    close: () => client.close()
  }
}
