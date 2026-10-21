import { existsSync } from 'fs'
import { delimiter, join } from 'path'

/**
 * Agent commands already run inside Windows PowerShell. Wrapping a script in another
 * `powershell -Command "..."` makes the outer shell expand `$_` and variables inside double
 * quotes, and Windows PowerShell 5.1 drops embedded quotes when it passes arguments to a
 * program, so a valid script arrives broken. Models retry such commands with new arguments
 * until the loop guard stops them; naming the cause on the first failure ends that.
 */
const NESTED_POWERSHELL =
  /(?:^|[;|&({])\s*(?:&\s*)?["']?(?:[\w:\\/. -]*[\\/])?(?:powershell|pwsh)(?:\.exe)?["']?\s+(?:-\w+\s+)*?-c(?:ommand)?\b/i

export function nestedPowerShellHint(command: string, platform = process.platform): string | null {
  if (platform !== 'win32' || !NESTED_POWERSHELL.test(command)) return null
  return 'This command nests powershell/pwsh -Command inside the shell, which already is Windows PowerShell. The outer shell expands $_ and variables inside double quotes and drops embedded quotes, so the inner script arrives broken. Run the PowerShell directly, without the wrapper. If you need PowerShell 7, pipe a single-quoted here-string to `pwsh -NoProfile -Command -`.'
}

const grep = (ripgrep: boolean): string =>
  ripgrep
    ? '`rg <regex> <path>` (ripgrep is installed and takes grep-like flags), or `Select-String -Pattern <regex> -Path <files>`'
    : '`Select-String -Pattern <regex> -Path <files>`, or `Get-ChildItem -Recurse -File | Select-String -Pattern <regex>` for a folder'

/** PowerShell for the Unix commands models reach for first, given whether ripgrep is installed. */
const UNIX_EQUIVALENTS: Record<string, (ripgrep: boolean) => string> = {
  grep,
  egrep: grep,
  fgrep: grep,
  cat: () =>
    '`Get-Content <file>`, which has no -n; the read tool shows a project file with line numbers',
  head: () => '`Get-Content <file> -TotalCount <n>`, or `<command> | Select-Object -First <n>`',
  tail: () =>
    '`Get-Content <file> -Tail <n>` (add -Wait to follow), or `<command> | Select-Object -Last <n>`',
  which: () => '`(Get-Command <name>).Source`',
  wc: () => '`(Get-Content <file> | Measure-Object -Line).Lines`',
  ls: () => '`Get-ChildItem -Force`; ls is its alias here and takes no Unix flags such as -la'
}

/** Unix commands PowerShell has as aliases of a cmdlet, which fail on a Unix flag instead. */
const ALIAS_CMDLETS: Record<string, string> = {
  cat: 'GetContentCommand',
  ls: 'GetChildItemCommand'
}

/** Whether `rg` is on the PATH the shell inherits. */
export function ripgrepOnPath(path = process.env.PATH ?? '', platform = process.platform): boolean {
  const name = platform === 'win32' ? 'rg.exe' : 'rg'
  return path
    .split(delimiter)
    .some((directory) => directory.trim() !== '' && existsSync(join(directory, name)))
}

/**
 * Names the PowerShell equivalent when a command failed because it used a Unix command Windows
 * PowerShell does not have, or a Unix flag on one it has as an alias (`cat -n`, `ls -la`). The
 * error ids PowerShell prints under the message are the same in every display language.
 */
export function unixCommandHint(
  command: string,
  output: string,
  platform = process.platform,
  ripgrep: () => boolean = ripgrepOnPath
): string | null {
  if (platform !== 'win32') return null
  const missing = [
    ...output.matchAll(/The term '([^'\r\n]+)' is not recognized/g),
    ...output.matchAll(/ObjectNotFound: \(([^:()\r\n]+):String\) \[\], CommandNotFoundException/g)
  ].map((match) =>
    match[1]
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, '')
  )
  const flagged = Object.entries(ALIAS_CMDLETS)
    .filter(
      ([name, cmdlet]) =>
        output.includes(`NamedParameterNotFound,Microsoft.PowerShell.Commands.${cmdlet}`) &&
        new RegExp(`(?:^|[;|&({])\\s*${name}\\s+(?:[^;|&\\r\\n]*\\s)?-[a-z]`, 'im').test(command)
    )
    .map(([name]) => name)
  const commands = [...new Set([...missing, ...flagged])].filter((name) =>
    Object.hasOwn(UNIX_EQUIVALENTS, name)
  )
  if (!commands.length) return null
  const hasRipgrep = commands.some((name) => name.endsWith('grep')) && ripgrep()
  return (
    'The shell is Windows PowerShell, not Bash, so Unix commands and flags do not work here. ' +
    commands
      .map((name) => `Instead of \`${name}\`, use ${UNIX_EQUIVALENTS[name](hasRipgrep)}.`)
      .join(' ')
  )
}

/** A hint about the command itself for a failed command, or null when there is none. */
export function shellCommandHint(
  command: string,
  output: string,
  platform = process.platform
): string | null {
  return nestedPowerShellHint(command, platform) ?? unixCommandHint(command, output, platform)
}
