import { describe, expect, it } from 'vitest'
import { nestedPowerShellHint } from './shellCommandHints'

describe('nestedPowerShellHint', () => {
  it('names the nested PowerShell wrapper on Windows', () => {
    for (const command of [
      `powershell -Command "Get-PnPDevice | Where-Object { $_.FriendlyName -like '*Logi*' }"`,
      `powershell.exe -NoProfile -c 'Get-Service logi*'`,
      `pwsh -NoLogo -Command "Get-Process"`,
      String.raw`Set-Location C:\x; & "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "dir"`
    ]) {
      expect(nestedPowerShellHint(command, 'win32'), command).toContain(
        'Run the PowerShell directly'
      )
    }
  })

  it('leaves direct PowerShell, script files, and other platforms alone', () => {
    for (const command of [
      `Get-PnPDevice | Where-Object { $_.FriendlyName -like '*Logi*' }`,
      String.raw`powershell -File .\scripts\build.ps1`,
      'npm run build -- --config powershell-compatible.json',
      'Write-Output "use pwsh -Command for PowerShell 7"'
    ]) {
      expect(nestedPowerShellHint(command, 'win32'), command).toBeNull()
    }
    expect(nestedPowerShellHint('powershell -Command "dir"', 'linux')).toBeNull()
  })
})
