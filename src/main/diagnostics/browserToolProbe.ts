// Development only: runs the Chrome tools with no model in the way, for scripts/browser-bench/probe.cjs, so what a
// tool does can be measured apart from what a model chose to ask of it.
import { app } from 'electron'
import { createServer } from 'http'
import { join } from 'path'
import { AgentToolHandlerRegistry } from '../services/agentToolHandlerRegistry'
import { registerBrowserToolHandlers } from '../services/agentBrowserToolHandlers'
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
  const outputs = new ToolOutputStore(join(app.getPath('temp'), 'sidekick-browser-probe'))
  // Only Chrome is under test here: every call opens with browser "chrome".
  registerBrowserToolHandlers(registry, chrome.manager, outputs, { chrome })
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
