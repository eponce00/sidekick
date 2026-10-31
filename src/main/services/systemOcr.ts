import { execFile } from 'child_process'
import { join } from 'path'

export type SystemOcrResult =
  | { ok: true; texts: string[] }
  | { ok: false; reason: 'unavailable' | 'failed' | 'cancelled' }

// Windows.Media.Ocr ships with Windows 10 and later and runs offline. Windows PowerShell 5.1 can
// reach WinRT; PowerShell 7 cannot.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $task.Wait(-1)
  $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
  if ($null -ne $language) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language) }
}
if ($null -eq $engine) { [Console]::Out.Write('{"unavailable":true}'); exit 0 }
$texts = foreach ($path in ($env:SIDEKICK_OCR_IMAGES -split "${'`'}n")) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    ,(($result.Lines | ForEach-Object { $_.Text }) -join "${'`'}n")
  } finally { $stream.Dispose() }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @{ texts = @($texts) } -Compress))
`

// Apple's Vision framework, reached from JavaScript for Automation; both ship with macOS.
const MAC_SCRIPT = `
ObjC.import('Foundation')
ObjC.import('Vision')
function run(argv) {
  const texts = []
  for (const path of argv) {
    const request = $.VNRecognizeTextRequest.alloc.init
    request.setRecognitionLevel(0)
    request.setUsesLanguageCorrection(true)
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(
      $.NSURL.fileURLWithPath(path),
      $.NSDictionary.dictionary
    )
    if (!handler.performRequestsError($.NSArray.arrayWithObject(request), null)) {
      throw new Error('Text recognition failed')
    }
    const results = request.results
    const lines = []
    for (let index = 0; index < results.count; index++) {
      lines.push(results.objectAtIndex(index).topCandidates(1).objectAtIndex(0).string.js)
    }
    texts.push(lines.join('\\n'))
  }
  return JSON.stringify({ texts })
}
`

function run(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        signal: options.signal,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

function parsed(stdout: string, count: number): SystemOcrResult {
  const value = JSON.parse(stdout.trim()) as { texts?: unknown; unavailable?: boolean }
  if (value.unavailable) return { ok: false, reason: 'unavailable' }
  const texts = Array.isArray(value.texts) ? value.texts.map((text) => String(text ?? '')) : []
  return texts.length === count ? { ok: true, texts } : { ok: false, reason: 'failed' }
}

/**
 * Recognize the text in images with the operating system's own OCR: nothing to download, and the
 * images never leave the computer. Linux has none built in, so Tesseract is used when installed.
 */
export async function recognizeTextInImages(
  imagePaths: readonly string[],
  signal?: AbortSignal
): Promise<SystemOcrResult> {
  if (!imagePaths.length) return { ok: true, texts: [] }
  const timeoutMs = 30_000 + imagePaths.length * 10_000
  try {
    if (process.platform === 'win32') {
      const powershell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const stdout = await run(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
        ],
        {
          env: { ...process.env, SIDEKICK_OCR_IMAGES: imagePaths.join('\n') },
          timeoutMs,
          signal
        }
      )
      return parsed(stdout, imagePaths.length)
    }
    if (process.platform === 'darwin') {
      const stdout = await run(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', MAC_SCRIPT, ...imagePaths],
        { timeoutMs, signal }
      )
      return parsed(stdout, imagePaths.length)
    }
    const texts: string[] = []
    for (const path of imagePaths) {
      texts.push((await run('tesseract', [path, 'stdout'], { timeoutMs, signal })).trim())
    }
    return { ok: true, texts }
  } catch (error) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'failed'
    }
  }
}
