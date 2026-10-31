import { execFile } from 'child_process'
import { basename, join } from 'path'

export type ComputerAppAccess =
  | { kind: 'allowed' }
  /** Can be approved, but the dialog says it may move real equipment and defaults to deny. */
  | { kind: 'physical' }
  | { kind: 'blocked'; reason: string }

export interface ComputerApp {
  pid: number
  /** The executable's name without its extension, which is how the model refers to the app. */
  name: string
  path: string
  access: ComputerAppAccess
}

const SHELL_REASON = 'it can run any command, which would go around every other limit'
const BLOCKED: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    SHELL_REASON,
    [
      'cmd',
      'powershell',
      'powershell_ise',
      'pwsh',
      'wt',
      'windowsterminal',
      'openconsole',
      'conhost',
      'wsl',
      'wslhost',
      'bash',
      'mintty',
      'alacritty',
      'wezterm-gui',
      'code',
      'cursor',
      'windsurf',
      'devenv'
    ]
  ],
  [
    'it changes how this computer is set up, or reaches any file on it',
    [
      'explorer',
      'regedit',
      'mmc',
      'taskmgr',
      'msconfig',
      'control',
      'systemsettings',
      'consent',
      'lockapp',
      'logonui'
    ]
  ],
  [
    'it holds your passwords',
    ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass']
  ],
  [
    'it holds your signed-in accounts; use SideKick’s own browser for web pages',
    ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']
  ],
  ['the agent may not operate SideKick itself', ['sidekick', 'electron']],
  [
    'it is part of Windows or a background host, not an app to operate',
    [
      'msedgewebview2',
      'textinputhost',
      'applicationframehost',
      'shellexperiencehost',
      'searchhost',
      'startmenuexperiencehost',
      'dwm',
      'sihost'
    ]
  ]
]

// A wrong click in these can move a machine. Matched against the whole path, since engineering
// suites install many executables under one vendor folder.
const PHYSICAL =
  /twincat|tcxae|tchmi|tcsystem|siemens\.automation|tia portal|step ?7|wincc|studio ?5000|rslogix|rsview|factorytalk|codesys|ignition|fanuc|roboguide|wonderware|intouch|kepserver/i

/** What the agent may do with an app, judged only from its real executable path. */
export function computerAppAccess(executablePath: string): ComputerAppAccess {
  const name = basename(executablePath.replaceAll('\\', '/'))
    .replace(/\.exe$/i, '')
    .toLowerCase()
  for (const [reason, names] of BLOCKED) {
    if (names.includes(name)) return { kind: 'blocked', reason }
  }
  return PHYSICAL.test(executablePath) ? { kind: 'physical' } : { kind: 'allowed' }
}

const LIST_WINDOWED_PROCESSES =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  '@(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | Select-Object Id,Path) | ConvertTo-Json -Compress'

export function parseComputerApps(stdout: string): ComputerApp[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    Id?: unknown
    Path?: unknown
  }>
  return rows.flatMap((row) =>
    typeof row?.Id === 'number' && typeof row.Path === 'string'
      ? [
          {
            pid: row.Id,
            name: basename(row.Path.replaceAll('\\', '/')).replace(/\.exe$/i, ''),
            path: row.Path,
            access: computerAppAccess(row.Path)
          }
        ]
      : []
  )
}

/**
 * The apps with a window open. Window titles stay out: one can hold a document's name or an
 * email's subject, and the agent has not been given those apps. An elevated app reports no path,
 * so it is left out; Windows would refuse its input anyway.
 */
export function listComputerApps(signal?: AbortSignal): Promise<ComputerApp[]> {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(LIST_WINDOWED_PROCESSES, 'utf16le').toString('base64')
      ],
      { timeout: 20_000, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(parseComputerApps(stdout))
      }
    )
  })
}
