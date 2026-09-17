import assert from 'node:assert/strict'
import { existsSync, promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { app } from 'electron'
import { openAICompatibleHeaders } from '../src/main/providers/openAICompatibleClient'
import { AgentScenarioHarness, copyEvalFixture } from '../src/main/evals/agentScenarioHarness'
import { NativeBrowserSessionService } from '../src/main/services/nativeBrowserSessionService'
import type { AgentRunEvent } from '../src/shared/agentRuntime'
import type { ProviderKind } from '../src/shared/providerRegistry'

const RESULT_PREFIX = 'SIDEKICK_COMPREHENSIVE_EVAL='

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function progress(message: string): void {
  process.stdout.write(`[comprehensive-eval] ${message}\n`)
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function referencePng(): Buffer {
  const width = 720
  const height = 420
  const pixels = Buffer.alloc(width * height * 4, 255)
  const setPixel = (x: number, y: number, color: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = (y * width + x) * 4
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
    pixels[offset + 3] = 255
  }
  const rectangle = (
    left: number,
    top: number,
    right: number,
    bottom: number,
    color: readonly [number, number, number]
  ): void => {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) setPixel(x, y, color)
    }
  }
  const circle = (
    centerX: number,
    centerY: number,
    radius: number,
    color: readonly [number, number, number]
  ): void => {
    for (let y = centerY - radius; y <= centerY + radius; y++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) setPixel(x, y, color)
      }
    }
  }
  rectangle(70, 58, 650, 362, [23, 32, 51])
  rectangle(104, 92, 616, 146, [35, 48, 74])
  circle(158, 119, 10, [34, 199, 169])
  circle(188, 119, 10, [123, 227, 208])
  rectangle(104, 180, 336, 308, [243, 246, 251])
  rectangle(360, 180, 616, 216, [34, 199, 169])
  rectangle(360, 234, 550, 256, [220, 226, 237])
  rectangle(360, 272, 584, 294, [220, 226, 237])

  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0
    pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

async function writeReferencePng(path: string): Promise<void> {
  const png = referencePng()
  assert.ok(png.length > 1_000, 'Reference PNG was unexpectedly small')
  await fs.mkdir(resolve(path, '..'), { recursive: true })
  await fs.writeFile(path, png)
}

function completedToolNames(events: AgentRunEvent[]): string[] {
  return events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => String(event.payload.name || ''))
    .filter(Boolean)
}

function assertOrdered(names: string[], first: string, second: string): void {
  const firstIndex = names.indexOf(first)
  const secondIndex = names.indexOf(second)
  assert.ok(firstIndex >= 0, `Missing required tool: ${first}`)
  assert.ok(secondIndex >= 0, `Missing required tool: ${second}`)
  assert.ok(firstIndex < secondIndex, `${first} must occur before ${second}`)
}

async function runEvaluation(): Promise<Record<string, unknown>> {
  const root = resolve(requiredEnvironment('SIDEKICK_COMPREHENSIVE_EVAL_ROOT'))
  const endpoint = requiredEnvironment('SIDEKICK_AGENT_EVAL_URL')
  const model = requiredEnvironment('SIDEKICK_AGENT_EVAL_MODEL')
  const apiKey = requiredEnvironment('SIDEKICK_AGENT_EVAL_API_KEY')
  const providerKind = (process.env.SIDEKICK_AGENT_EVAL_PROVIDER_KIND || 'litellm') as ProviderKind
  const workspaceRoot = join(root, 'project')
  const runtimeRoot = join(root, 'runtime')
  const artifactRoot = join(root, 'browser-artifacts')
  const fixtureRoot = join(
    resolve(process.cwd()),
    'src',
    'main',
    'evals',
    'fixtures',
    'comprehensive-agent'
  )
  const browser = new NativeBrowserSessionService({
    artifactRoot,
    maxTotalSessions: 4,
    maxSessionsPerRun: 2
  })
  const harness = new AgentScenarioHarness(runtimeRoot, {
    endpoint,
    model,
    headers: openAICompatibleHeaders(apiKey),
    providerKind,
    maxOutputTokens: 8_192,
    requestTimeoutMs: 180_000,
    browser
  })
  const threadId = 'comprehensive-agent-loop'
  const observedTools: string[] = []
  const onEvent = (event: AgentRunEvent): void => {
    if (event.type !== 'tool.completed') return
    const name = String(event.payload.name || '')
    if (!name) return
    observedTools.push(name)
    progress(`tool completed: ${name}`)
  }

  try {
    await copyEvalFixture(fixtureRoot, workspaceRoot)
    await writeReferencePng(join(workspaceRoot, 'assets', 'reference.png'))
    await harness.initialize()
    const pageUrl = pathToFileURL(join(workspaceRoot, 'index.html')).href

    progress('starting implementation turn')
    const first = await harness.run({
      workspaceRoot,
      threadId,
      browserEnabled: true,
      maxToolRounds: 80,
      onEvent,
      messages: [
        {
          role: 'system',
          content:
            'This is SideKick’s comprehensive isolated agent-loop evaluation. Every requested tool family and ordering constraint is part of the acceptance contract. Do not activate skills or MCP tools; all required instructions are here. Read before editing, use localized edits for existing files, create new files only with write, verify real results, and keep working through tool output until every requirement passes.'
        },
        {
          role: 'user',
          content: `Your first two tool calls must be read on AGENTS.md and view_image on assets/reference.png; do not substitute read for the image tool. Then read index.html, styles.css, and src/app.js and create a concise manage_todo_list. (1) create src/theme.js with write, exporting and applying an accent derived from the reference; (2) use localized edit calls—not write—to import and apply it in src/app.js, change the initial visible status from Before to Ready, and add a --accent variable to styles.css; (3) delete obsolete.txt with delete_file while preserving the sentinel; (4) run npm run test:base; (5) open ${pageUrl} with browser_open, inspect it with browser_observe, click the mode-toggle with browser_click, capture browser_screenshot, then inspect browser_console and browser_network. Resolve any errors, complete the todo list, and report only after every requirement succeeds.`
        }
      ]
    })
    assert.equal(first.phase, 'completed', first.error)

    progress('starting follow-up responsive/browser turn')
    const second = await harness.run({
      workspaceRoot,
      threadId,
      browserEnabled: true,
      maxToolRounds: 70,
      onEvent,
      messages: [
        ...first.messages,
        {
          role: 'user',
          content:
            'Follow-up turn: re-read the current index.html, styles.css, src/app.js, and src/theme.js. Use localized edit calls to add a console__metrics section with data-metric="latency" and data-metric="throughput", then add an @media (max-width: 600px) compact layout and overflow-x: hidden without removing prior behavior. Run npm test. Reuse or reopen the browser, use browser_resize for 390×844, browser_observe the compact result, click mode-toggle again, take another browser_screenshot, inspect browser_console and browser_network, and close it with browser_close. Fix any test, console, network, overflow, or interaction problem before finishing.'
        }
      ]
    })
    assert.equal(second.phase, 'completed', second.error)

    const allEvents = [...first.events, ...second.events]
    const names = completedToolNames(allEvents)
    const requiredTools = [
      'read',
      'view_image',
      'manage_todo_list',
      'write',
      'edit',
      'delete_file',
      'shell',
      'browser_open',
      'browser_observe',
      'browser_click',
      'browser_screenshot',
      'browser_console',
      'browser_network',
      'browser_resize',
      'browser_close'
    ]
    for (const name of requiredTools) {
      assert.ok(names.includes(name), `Comprehensive loop did not execute ${name}`)
    }
    assertOrdered(names, 'read', 'edit')
    assertOrdered(names, 'view_image', 'write')
    assertOrdered(names, 'edit', 'shell')
    assertOrdered(names, 'shell', 'browser_open')

    const appSource = await fs.readFile(join(workspaceRoot, 'src', 'app.js'), 'utf8')
    assert.match(appSource, /sidekick-comprehensive-eval/)
    assert.match(appSource, /from\s+["']\.\/theme\.js["']/)
    assert.equal(existsSync(join(workspaceRoot, 'src', 'theme.js')), true)
    assert.equal(existsSync(join(workspaceRoot, 'obsolete.txt')), false)

    const nodeExecutable = process.env.npm_node_execpath || 'node'
    const verification = spawnSync(nodeExecutable, ['test/verify.mjs', 'final'], {
      cwd: workspaceRoot,
      encoding: 'utf8'
    })
    assert.equal(
      verification.status,
      0,
      `Independent final verification failed: ${verification.stderr || verification.stdout}`
    )
    const screenshots = existsSync(artifactRoot)
      ? (await fs.readdir(artifactRoot, { recursive: true })).filter((path) =>
          String(path).endsWith('.png')
        )
      : []
    assert.ok(screenshots.length >= 2, 'Expected at least two real browser screenshots')

    return {
      passed: true,
      turns: 2,
      toolRounds: first.toolRounds + second.toolRounds,
      uniqueTools: [...new Set(names)],
      completedToolCalls: names.length,
      screenshots: screenshots.length,
      finalVerification: verification.stdout.trim()
    }
  } finally {
    await harness.close().catch(() => undefined)
    await browser.dispose().catch(() => undefined)
  }
}

app.on('window-all-closed', () => undefined)
const root = resolve(requiredEnvironment('SIDEKICK_COMPREHENSIVE_EVAL_ROOT'))
app.setPath('userData', join(root, 'electron-profile'))

app
  .whenReady()
  .then(runEvaluation)
  .then((result) => {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
    app.quit()
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error)
    app.exit(1)
  })
