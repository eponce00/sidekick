import { app, type NativeImage } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface ExternalOpener {
  id: string
  label: string
  kind: 'editor' | 'terminal'
  executable: string
  icon?: NativeImage
  args: (target: string, isDirectory: boolean) => string[]
}

interface OpenerCandidate extends Omit<ExternalOpener, 'executable' | 'icon'> {
  commands: string[]
  paths: string[]
}

async function commandPath(commands: readonly string[]): Promise<string | null> {
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [
        command
      ])
      const match = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean)
      if (match) return match
    } catch {
      // Try the next command or known installation path.
    }
  }
  return null
}

async function installedPath(candidate: OpenerCandidate): Promise<string | null> {
  for (const path of candidate.paths) {
    if (!path) continue
    try {
      await fs.access(path)
      return path
    } catch {
      // Try the next known location.
    }
  }
  return commandPath(candidate.commands)
}

function windowsCandidates(): OpenerCandidate[] {
  const local = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.ProgramFiles || ''
  const programFilesX86 = process.env['ProgramFiles(x86)'] || ''
  const windows = process.env.WINDIR || 'C:\\Windows'
  const targetDirectory = (target: string, isDirectory: boolean): string =>
    isDirectory ? target : dirname(target)

  return [
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'editor',
      commands: ['Code.exe'],
      paths: [join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')],
      args: (target) => [target]
    },
    {
      id: 'vscode-insiders',
      label: 'VS Code Insiders',
      kind: 'editor',
      commands: ['Code - Insiders.exe'],
      paths: [join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')],
      args: (target) => [target]
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'editor',
      commands: ['Cursor.exe'],
      paths: [join(local, 'Programs', 'cursor', 'Cursor.exe')],
      args: (target) => [target]
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      kind: 'editor',
      commands: ['Antigravity.exe'],
      paths: [join(local, 'Programs', 'Antigravity', 'Antigravity.exe')],
      args: (target) => [target]
    },
    {
      id: 'terminal',
      label: 'Terminal',
      kind: 'terminal',
      commands: ['wt.exe'],
      paths: [join(local, 'Microsoft', 'WindowsApps', 'wt.exe')],
      args: (target, isDirectory) => ['-d', targetDirectory(target, isDirectory)]
    },
    {
      id: 'git-bash',
      label: 'Git Bash',
      kind: 'terminal',
      commands: ['git-bash.exe'],
      paths: [
        join(programFiles, 'Git', 'git-bash.exe'),
        join(programFilesX86, 'Git', 'git-bash.exe')
      ],
      args: (target, isDirectory) => [`--cd=${targetDirectory(target, isDirectory)}`]
    },
    {
      id: 'powershell',
      label: 'PowerShell',
      kind: 'terminal',
      commands: ['pwsh.exe', 'powershell.exe'],
      paths: [join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      args: (target, isDirectory) => [
        '-NoExit',
        '-Command',
        'Set-Location -LiteralPath $args[0]',
        targetDirectory(target, isDirectory)
      ]
    }
  ]
}

function unixCandidates(): OpenerCandidate[] {
  return [
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'editor',
      commands: ['code'],
      paths: [],
      args: (target) => [target]
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'editor',
      commands: ['cursor'],
      paths: [],
      args: (target) => [target]
    }
  ]
}

export async function discoverExternalOpeners(): Promise<ExternalOpener[]> {
  const candidates = process.platform === 'win32' ? windowsCandidates() : unixCandidates()
  const results = await Promise.all(
    candidates.map(async (candidate): Promise<ExternalOpener | null> => {
      const executable = await installedPath(candidate)
      if (!executable) return null
      const icon = await app.getFileIcon(executable, { size: 'small' }).catch(() => undefined)
      return {
        id: candidate.id,
        label: candidate.label,
        kind: candidate.kind,
        executable,
        icon,
        args: candidate.args
      }
    })
  )
  return results.filter((result): result is ExternalOpener => result !== null)
}
