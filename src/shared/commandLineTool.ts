/** How the `sidekick` command is made available on this computer. */
export interface CommandLineToolStatus {
  /**
   * `installer`: the Windows installer puts `bin` on PATH. `shell-script`: Settings writes a
   * script to `~/.local/bin`. `development`: run it through npm. `unavailable`: this package
   * cannot add commands, such as the Microsoft Store package.
   */
  mode: 'installer' | 'shell-script' | 'development' | 'unavailable'
  installed: boolean
  /** The command's folder or script; empty when there is none. */
  location: string
  /** Whether that folder is on PATH, when SideKick can tell. */
  onPath: boolean | null
  /** What to type, or what to change, so the command works. */
  hint: string
}

export type CommandLineToolInstallResult =
  | { ok: true; status: CommandLineToolStatus }
  | { ok: false; error: string; status: CommandLineToolStatus }
