param(
  [string]$Executable = "dist\win-unpacked\SideKick.exe",
  [int]$Seconds = 8
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$profile = Join-Path $tempRoot ('sidekick-smoke-' + [guid]::NewGuid().ToString('N'))
$stdout = Join-Path $profile 'stdout.log'
$stderr = Join-Path $profile 'stderr.log'
$matching = @()

try {
  New-Item -ItemType Directory -Path $profile | Out-Null
  $process = Start-Process `
    -FilePath $resolvedExecutable `
    -ArgumentList @("--user-data-dir=$profile", '--enable-logging=stderr', '--disable-gpu') `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

  Start-Sleep -Seconds $Seconds
  $matching = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$profile*" })
  $logs = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { '' }
  $fatalPattern = '(?i)uncaught|fatal|failed to load|module.*not found|unable to load preload'

  if ($process.HasExited) {
    throw "Packaged app exited during smoke test with code $($process.ExitCode).`n$logs"
  }
  if ($matching.Count -lt 2) {
    throw "Expected Electron child processes, found $($matching.Count).`n$logs"
  }
  if ($logs -match $fatalPattern) {
    throw "Packaged app emitted a fatal startup error.`n$logs"
  }

  Write-Host "Packaged smoke test passed ($($matching.Count) Electron processes)."
}
finally {
  $matching | Sort-Object ProcessId -Descending | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $resolvedProfile = [System.IO.Path]::GetFullPath($profile)
  if ($resolvedProfile.StartsWith($tempRoot) -and (Split-Path $resolvedProfile -Leaf).StartsWith('sidekick-smoke-')) {
    Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
  }
}
