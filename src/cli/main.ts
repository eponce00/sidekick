import { ControlError } from '../shared/controlProtocol'
import { runCli } from './sidekick'
import { updateUserPath } from './windowsPath'

function readStdin(limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= limit) return void chunks.push(chunk)
      process.stdin.destroy()
      reject(new ControlError('invalid-value', 'The key is too long to be an API key.'))
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

const argv = process.argv.slice(2)

// Used only by the Windows installer and uninstaller, never documented as a command.
const run =
  argv[0] === '__windows-path' && process.platform === 'win32'
    ? updateUserPath(argv[1] === 'remove' ? 'remove' : 'add', argv[2] ?? '')
    : runCli(argv, {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        readStdin,
        stdinIsTTY: Boolean(process.stdin.isTTY),
        env: process.env
      })

void run.then((code) => {
  process.exitCode = code
})
