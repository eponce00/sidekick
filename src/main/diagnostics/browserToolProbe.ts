// Development only: runs the Chrome tools with no model in the way, for scripts/browser-bench/probe.cjs, so what a
// tool does can be measured apart from what a model chose to ask of it.
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { createServer } from 'http'
import { join } from 'path'
import {
  AgentBrowserSessionManager,
  registerBrowserToolHandlers
} from '../services/agentBrowserToolHandlers'
import { AgentToolHandlerRegistry } from '../services/agentToolHandlerRegistry'
import { NativeBrowserSessionService } from '../services/nativeBrowserSessionService'
import { ToolOutputStore } from '../services/toolOutputStore'

const CALL_LIMIT_MS = 120_000

export async function startBrowserToolProbe(port: number): Promise<void> {
  const { chromeBrowser } = await import('../services/chromeUseHost')
  const chrome = chromeBrowser()
  if (!chrome) throw new Error('Chrome use is not available in this build')
  // Every command to Chrome, with how long it took, so a slow step can be taken apart.
  let trace: Array<[number, string, number]> = []
  const bridge = (
    chrome.service as unknown as {
      deps: {
        bridge: { send: (...args: [string, Record<string, unknown>, AbortSignal]) => unknown }
      }
    }
  ).deps.bridge
  // Run unattended: nothing here may wait on a person. Only the bench's own site, on this computer, gets a yes.
  const answers = (
    chrome.service as unknown as {
      deps: Record<string, (...args: never[]) => Promise<boolean>>
    }
  ).deps
  const onBenchSite = (address: unknown): boolean =>
    /^https?:\/\/(127\.0\.0\.1:|the-internet\.herokuapp\.com|uitestingplayground\.com)/.test(
      String(address)
    )
  answers.confirmSite = (async (origin: string) => onBenchSite(origin)) as never
  answers.confirmSharedTab = (async () => false) as never
  answers.confirmPress = (async (_name: string, origin: string) => onBenchSite(origin)) as never
  answers.confirmDownload = (async (url: string) => onBenchSite(url)) as never
  answers.confirmUpload = (async (_files: string[], origin: string) => onBenchSite(origin)) as never
  const send = bridge.send.bind(bridge)
  bridge.send = (op, args, signal) => {
    const at = Date.now()
    const entry: [number, string, number] = [at, String(args.method ?? op), -1]
    trace.push(entry)
    const answer = send(op, args, signal) as Promise<unknown>
    const done = (): void => {
      entry[2] = Date.now() - at
    }
    answer.then(done, done)
    return answer
  }
  const registry = new AgentToolHandlerRegistry()
  const root = join(app.getPath('temp'), 'sidekick-browser-probe')
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  const outputs = new ToolOutputStore(join(root, 'outputs'))
  const builtIn = new AgentBrowserSessionManager(
    new NativeBrowserSessionService({ artifactRoot: join(root, 'artifacts'), maxTotalSessions: 6 })
  )
  registerBrowserToolHandlers(registry, builtIn, outputs, { chrome })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const { name, args, chat } = JSON.parse(Buffer.concat(chunks).toString()) as {
        name: string
        args: Record<string, unknown>
        chat?: string
      }
      const started = Date.now()
      trace = []
      const result = await registry.execute({
        name,
        title: name,
        arguments: args ?? {},
        context: {
          runId: `probe-${chat ?? 'chat'}`,
          conversationId: `probe-${chat ?? 'chat'}`,
          workspaceRoot: files,
          signal: AbortSignal.timeout(CALL_LIMIT_MS)
        }
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ms: Date.now() - started,
          trace: trace.map(([at, what, ms]) => [at - started, what, ms]),
          result
        })
      )
    })
  })
  server.listen(port, '127.0.0.1')
}
