import { execFile } from 'child_process'
import { basename, join } from 'path'

export type ComputerAppAccess =
  | { kind: 'allowed' }
  /** Can be approved, but the dialog says it may move real equipment and defaults to deny. */
  | { kind: 'physical' }
  /** Can be approved, but the dialog says what approving it really hands over. */
  | { kind: 'powerful'; warning: string }
  | { kind: 'blocked'; reason: string }

export interface ComputerApp {
  pid: number
  /** The executable's name without its extension, which is how the model refers to the app. */
  name: string
  path: string
  access: ComputerAppAccess
  /** How to start it when that isn't its path, as for a Store app. */
  startTarget?: string
  /** What people call it, when that isn't its executable's name. */
  title?: string
}

// Your call, per app and per chat, once the dialog has said this plainly.
const POWERFUL: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'This app can run any command on this computer. Commands typed here skip SideKick’s command approvals and any Docker isolation.',
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
    'This app can change how this computer is set up, and reach any file on it.',
    ['explorer', 'regedit', 'mmc', 'taskmgr', 'msconfig', 'control', 'systemsettings']
  ],
  [
    'This browser holds your signed-in accounts. The agent could read and act in any of them, and a web page could try to steer it.',
    ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']
  ]
]

const BLOCKED: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'it holds your passwords',
    ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass']
  ],
  [
    'it is a Windows security prompt, which only you may answer',
    ['consent', 'credentialuibroker', 'lockapp', 'logonui']
  ],
  [
    'the agent may not operate SideKick itself',
    ['sidekick', 'electron', 'cua-driver', 'cua-driver-uia']
  ],
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
  for (const [warning, names] of POWERFUL) {
    if (names.includes(name)) return { kind: 'powerful', warning }
  }
  return PHYSICAL.test(executablePath) ? { kind: 'physical' } : { kind: 'allowed' }
}

/** The window helper's answer: "pid|path" for each app, each ending in a mark no path can hold. */
export function parseComputerApps(answer: string): ComputerApp[] {
  return answer.split('?').flatMap((row) => {
    const found = /^(\d+)\|(.+)$/.exec(row)
    if (!found) return []
    const path = found[2]
    return [
      {
        pid: Number(found[1]),
        name: basename(path.replaceAll('\\', '/')).replace(/\.exe$/i, ''),
        path,
        access: computerAppAccess(path)
      }
    ]
  })
}

const LIST_START_MENU_APPS =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  '$shell=New-Object -ComObject WScript.Shell;' +
  "@([Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Programs')|" +
  'ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -Filter *.lnk -ErrorAction SilentlyContinue }|' +
  'ForEach-Object { $t=$shell.CreateShortcut($_.FullName).TargetPath;' +
  "if ($t -like '*.exe') { [pscustomobject]@{Name=$_.BaseName;Path=$t} } }) | ConvertTo-Json -Compress"

/** The Start Menu entry for a name: its executable's own name first, then the shortcut's. */
export function matchInstalledApp(stdout: string, wanted: string): ComputerApp | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const parsed = JSON.parse(trimmed) as unknown
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    Name?: unknown
    Path?: unknown
  }>
  const name = wanted.toLowerCase()
  const exeName = (path: string): string =>
    basename(path.replaceAll('\\', '/'))
      .replace(/\.exe$/i, '')
      .toLowerCase()
  const shortcuts = rows.flatMap((row) =>
    typeof row?.Name === 'string' && typeof row.Path === 'string'
      ? [{ shortcut: row.Name.toLowerCase(), path: row.Path }]
      : []
  )
  const found =
    shortcuts.find((row) => exeName(row.path) === name) ??
    shortcuts.find((row) => row.shortcut === name)
  if (!found) return null
  return {
    pid: 0,
    name: basename(found.path.replaceAll('\\', '/')).replace(/\.exe$/i, ''),
    path: found.path,
    access: computerAppAccess(found.path)
  }
}

const LIST_STORE_APPS =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  "@(Get-StartApps | Where-Object { $_.AppID -match '^[\\w.-]+![\\w.-]+$' } | Select-Object Name,AppID) | ConvertTo-Json -Compress"

/** A Store app's Start entry for a name, which isn't a shortcut to its executable. */
export function matchStoreApp(
  stdout: string,
  wanted: string
): { appId: string; title: string } | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const parsed = JSON.parse(trimmed) as unknown
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    Name?: unknown
    AppID?: unknown
  }>
  // People say Windows Terminal or Windows Settings for what Start calls Terminal and Settings.
  const names = [wanted.toLowerCase(), wanted.toLowerCase().replace(/^(windows|microsoft) /, '')]
  const found = rows.find(
    (row) =>
      typeof row?.Name === 'string' &&
      typeof row.AppID === 'string' &&
      names.includes(row.Name.toLowerCase())
  )
  return found ? { appId: String(found.AppID), title: String(found.Name) } : null
}

/** Its executable, from the package's manifest, since approvals and limits go by that path. */
async function storeAppExecutable(appId: string, signal?: AbortSignal): Promise<string | null> {
  const [family, application] = appId.split('!')
  const packageName = family.split('_')[0]
  // Windows supplied these, and this pattern keeps them from being anything but names.
  if (!/^[\w.-]+$/.test(packageName) || !/^[\w.-]+$/.test(application)) return null
  const output = await runPowerShell(
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
      `$p=Get-AppxPackage -Name '${packageName}' | Select-Object -First 1;` +
      "$m=[xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml'));" +
      `$a=@($m.Package.Applications.Application) | Where-Object { $_.Id -eq '${application}' } | Select-Object -First 1;` +
      'Join-Path $p.InstallLocation $a.Executable',
    signal
  )
  const path = output.trim()
  return /\.exe$/i.test(path) ? path : null
}

/** An app that isn't running, found by name. Nothing here starts it. */
export async function findInstalledApp(
  name: string,
  signal?: AbortSignal
): Promise<ComputerApp | null> {
  // Side by side, since each takes seconds and a job waits on them before it can begin.
  const [shortcuts, storeApps] = await Promise.all([
    runPowerShell(LIST_START_MENU_APPS, signal),
    runPowerShell(LIST_STORE_APPS, signal)
  ])
  const shortcut = matchInstalledApp(shortcuts, name)
  if (shortcut) return shortcut
  const store = matchStoreApp(storeApps, name)
  const path = store && (await storeAppExecutable(store.appId, signal))
  if (!path) return null
  return {
    pid: 0,
    name: basename(path.replaceAll('\\', '/')).replace(/\.exe$/i, ''),
    path,
    access: computerAppAccess(path),
    startTarget: `shell:AppsFolder\\${store.appId}`,
    title: store.title
  }
}

export function powershellPath(): string {
  return join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { timeout: 20_000, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })
}
