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
