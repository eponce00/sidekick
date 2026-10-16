import { app } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type {
  CommandLineToolInstallResult,
  CommandLineToolStatus
} from '../../shared/commandLineTool'
import { userPathIncludes } from '../../cli/windowsPath'
import { controlDirectory } from './controlEndpoint'

const SCRIPT_MARKER = '# Installed by SideKick.'
const RUNTIME_FILE = 'cli-runtime'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The script `~/.local/bin/sidekick` runs. It reads where the running app's runtime is, so it keeps
 * working when an AppImage mounts somewhere new or the app bundle moves.
 */
export function shellScript(userData: string): string {
  return `#!/bin/sh
${SCRIPT_MARKER} Runs the sidekick CLI with the running app's own runtime.
runtime=${shellQuote(join(controlDirectory(userData), RUNTIME_FILE))}
not_running() {
  case " $* " in
    *" --json "*) printf '%s\n' '{"ok":false,"error":{"code":"not-running","message":"SideKick is not running. Start SideKick, then run the command again."}}' ;;
    *) echo "sidekick: SideKick is not running. Start SideKick, then run the command again." >&2 ;;
  esac
  exit 3
}
[ -r "$runtime" ] && [ -O "$runtime" ] || not_running "$@"
{ IFS= read -r exe; IFS= read -r script; IFS= read -r libdir; } < "$runtime"
[ -x "$exe" ] || not_running "$@"
if [ -n "$libdir" ]; then
  LD_LIBRARY_PATH="$libdir\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LD_LIBRARY_PATH
fi
ELECTRON_RUN_AS_NODE=1 exec "$exe" "$script" "$@"
`
}

/** Records this launch's runtime for the shell script; macOS and Linux only. */
export function writeCliRuntime(userData: string): (() => void) | null {
  if (process.platform === 'win32') return null
  const path = join(controlDirectory(userData), RUNTIME_FILE)
  // An AppImage's bundled libraries sit beside its executable in the mounted image.
  const libraryDirectory = process.env['APPDIR'] ? join(process.env['APPDIR'], 'usr', 'lib') : ''
  const contents = [
    process.execPath,
    join(app.getAppPath(), 'out', 'main', 'cli.js'),
    libraryDirectory
  ].join('\n')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${contents}\n`, { mode: 0o600 })
  renameSync(temporary, path)
  return () => {
    try {
      if (readFileSync(path, 'utf8') === `${contents}\n`) rmSync(path, { force: true })
    } catch {
      // Already removed or replaced by a newer launch.
    }
  }
}

function shellScriptPath(): string {
  return join(homedir(), '.local', 'bin', 'sidekick')
}

function onProcessPath(directory: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((entry) => entry === directory)
}

export async function commandLineToolStatus(): Promise<CommandLineToolStatus> {
  if (!app.isPackaged) {
    return {
      mode: 'development',
      installed: true,
      location: '',
      onPath: null,
      hint: 'Development builds: run `npm run sidekick -- <command>` from the repository.'
    }
  }
  if (process.platform === 'win32') {
    const location = join(dirname(process.execPath), 'bin')
    if (process.windowsStore) {
      return {
        mode: 'unavailable',
        installed: false,
        location: '',
        onPath: false,
        hint: 'The Microsoft Store package cannot add the sidekick command yet. Use the installer from GitHub Releases for command-line access.'
      }
    }
    const installed = existsSync(join(location, 'sidekick.cmd'))
    const onPath = installed ? await userPathIncludes(location) : false
    return {
      mode: 'installer',
      installed,
      location,
      onPath,
      hint: onPath
        ? 'Open a new terminal and run `sidekick --help`.'
        : 'Reinstall SideKick to put the sidekick command on PATH.'
    }
  }
  const location = shellScriptPath()
  const installed = existsSync(location) && readFileSync(location, 'utf8').includes(SCRIPT_MARKER)
  const directory = dirname(location)
  // Apps started from the Dock or a launcher do not inherit the login shell's PATH.
  const onPath = process.platform === 'darwin' ? null : onProcessPath(directory)
  return {
    mode: 'shell-script',
    installed,
    location,
    onPath,
    hint:
      onPath === true
        ? 'Open a new terminal and run `sidekick --help`.'
        : `If \`sidekick\` is not found, add ${directory} to PATH in your shell profile.`
  }
}

export async function installCommandLineTool(): Promise<CommandLineToolInstallResult> {
  const status = await commandLineToolStatus()
  if (status.mode !== 'shell-script') {
    return { ok: false, error: 'This build does not install the command from Settings.', status }
  }
  const target = shellScriptPath()
  if (existsSync(target) && !readFileSync(target, 'utf8').includes(SCRIPT_MARKER)) {
    return {
      ok: false,
      error: `${target} already exists and was not installed by SideKick. Remove it, then try again.`,
      status
    }
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, shellScript(app.getPath('userData')), { mode: 0o755 })
    renameSync(temporary, target)
  } catch {
    return { ok: false, error: `Could not write ${target}.`, status }
  }
  return { ok: true, status: await commandLineToolStatus() }
}
