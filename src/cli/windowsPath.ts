/**
 * Adds or removes the installed `bin` directory on the current user's PATH. The Windows installer
 * runs this through the app's own runtime; it edits only HKCU, keeps the value's registry type so
 * `%VARIABLES%` still expand, and never writes after a read it could not understand.
 */
import { execFile } from 'node:child_process'

export type RegistryRunner = (args: string[]) => Promise<{ code: number; stdout: string }>

interface UserPath {
  type: 'REG_SZ' | 'REG_EXPAND_SZ'
  value: string
}

const USER_ENVIRONMENT = 'HKCU\\Environment'
// Windows refuses environment blocks past 32,767 characters; stay well inside it.
const MAX_PATH_LENGTH = 30_000

export const runRegistry: RegistryRunner = (args) =>
  new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout) })
    })
  })

function normalize(entry: string): string {
  return entry
    .trim()
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

export function pathIncludes(value: string, directory: string): boolean {
  const wanted = normalize(directory)
  return value.split(';').some((entry) => normalize(entry) === wanted)
}

export function withPathEntry(value: string, directory: string): string {
  if (pathIncludes(value, directory)) return value
  const trimmed = value.replace(/;+$/, '')
  return trimmed ? `${trimmed};${directory}` : directory
}

export function withoutPathEntry(value: string, directory: string): string {
  const wanted = normalize(directory)
  return value
    .split(';')
    .filter((entry) => normalize(entry) !== wanted)
    .join(';')
}

/** Parses `reg query` output; null when it cannot be read with certainty. */
export function parseRegistryPath(stdout: string): UserPath | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+Path\s+(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/i.exec(line)
    if (match) return { type: match[1].toUpperCase() as UserPath['type'], value: match[2] }
    const empty = /^\s+Path\s+(REG_SZ|REG_EXPAND_SZ)\s*$/i.exec(line)
    if (empty) return { type: empty[1].toUpperCase() as UserPath['type'], value: '' }
  }
  return null
}

async function readUserPath(run: RegistryRunner, key: string): Promise<UserPath | null | 'absent'> {
  const result = await run(['query', key, '/v', 'Path'])
  if (result.code !== 0) {
    // `reg query` exits 1 when the value does not exist; anything else is not understood.
    const keyExists = await run(['query', key])
    return keyExists.code === 0 ? 'absent' : null
  }
  return parseRegistryPath(result.stdout)
}

export async function userPathIncludes(
  directory: string,
  run: RegistryRunner = runRegistry,
  key = USER_ENVIRONMENT
): Promise<boolean> {
  const current = await readUserPath(run, key)
  return current !== null && current !== 'absent' && pathIncludes(current.value, directory)
}

/**
 * Returns a process exit code: 0 when PATH was changed as requested, 2 when it already was, and 1
 * when it was left untouched. The installer tells other programs about a change only on 0.
 */
export async function updateUserPath(
  action: 'add' | 'remove',
  directory: string,
  run: RegistryRunner = runRegistry,
  key = USER_ENVIRONMENT
): Promise<number> {
  if (!directory || directory.includes(';') || directory.includes('"')) return 1
  const current = await readUserPath(run, key)
  if (current === null) return 1
  const before = current === 'absent' ? { type: 'REG_EXPAND_SZ' as const, value: '' } : current
  const value =
    action === 'add'
      ? withPathEntry(before.value, directory)
      : withoutPathEntry(before.value, directory)
  if (value === before.value) return 2
  if (value.length > MAX_PATH_LENGTH) return 1
  const written = await run(['add', key, '/v', 'Path', '/t', before.type, '/d', value, '/f'])
  return written.code === 0 ? 0 : 1
}
