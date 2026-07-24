import { tmpdir } from 'os'
import { basename, isAbsolute, relative, resolve } from 'path'

const E2E_ARGUMENT = '--sidekick-e2e'
const E2E_DIRECTORY_PREFIX = 'sidekick-e2e-'

/**
 * Test runs may redirect application data only when both an explicit process argument and a
 * temporary, conventionally named directory are present. A partial or broad configuration fails
 * closed before Electron opens a database.
 */
export function isolatedE2EUserDataPath(
  argv: readonly string[],
  configuredPath: string | undefined,
  temporaryRoot: string = tmpdir()
): string | null {
  const enabled = argv.includes(E2E_ARGUMENT)
  if (!enabled && !configuredPath) return null
  if (!enabled || !configuredPath) {
    throw new Error('Electron E2E isolation requires both the test argument and data directory.')
  }

  const root = resolve(temporaryRoot)
  const candidate = resolve(configuredPath)
  const relativePath = relative(root, candidate)
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath) ||
    !basename(candidate).startsWith(E2E_DIRECTORY_PREFIX)
  ) {
    throw new Error('Electron E2E data must use a dedicated sidekick-e2e-* temporary directory.')
  }
  return candidate
}
