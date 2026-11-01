import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import {
  completeOpenAICompatibleChat,
  openAICompatibleHeaders
} from '../providers/openAICompatibleClient'
import { toOpenAICompatibleMessages } from '../providers/providerRuntime'
import { AgentContextManager } from '../services/agentContextManager'
import { getAgentToolDefinitions } from '../../shared/agentToolCatalog'
import { PromptComposer } from '../../shared/prompts/PromptComposer'
import { capabilitiesFromTools } from '../../shared/prompts/promptCapabilities'
import { createPromptModelProfile } from '../../shared/prompts/modelProfiles'
import type { AgentRunEvent } from '../../shared/agentRuntime'
import { AgentScenarioHarness, type AgentKernelScenarioResult } from './agentScenarioHarness'

/**
 * Project-sized tasks through the production kernel, tools, terminal and system prompt, graded by
 * what ends up on disk and in the reply. Run with SIDEKICK_REALWORLD_RUN=1, an OpenRouter key in
 * SIDEKICK_OPENROUTER_EVAL_API_KEY and free models in SIDEKICK_REALWORLD_MODELS (comma separated).
 */
const apiKey = process.env.SIDEKICK_OPENROUTER_EVAL_API_KEY?.trim()
const models = (process.env.SIDEKICK_REALWORLD_MODELS ?? '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)
const enabled = process.env.SIDEKICK_REALWORLD_RUN === '1' && Boolean(apiKey) && models.length > 0
const only = process.env.SIDEKICK_REALWORLD_ONLY?.split(',').map((name) => name.trim())
const endpoint = 'https://openrouter.ai/api/v1'
const headers = {
  ...openAICompatibleHeaders(apiKey),
  'HTTP-Referer': 'https://github.com/eponce00/sidekick',
  'X-Title': 'SideKick development evaluation'
}
const windows = process.platform === 'win32'

interface Outcome {
  model: string
  scenario: string
  pass: boolean
  checks: Record<string, boolean>
  phase: string
  error?: string
  toolRounds: number
  tools: string[]
  toolErrors: string[]
  retries: string[]
  seconds: number
  reply: string
  /** What the model says got in its way: a lead to check against the transcript, not a finding. */
  debrief: unknown
  compactions?: number
}
const outcomes: Outcome[] = []

interface Scenario {
  name: string
  files: Record<string, string>
  prompt: string
  maxToolRounds?: number
  /** Searches the real engines, so its answer depends on the internet. */
  webSearch?: boolean
  /** A second message from the user after the first reply, graded after both. */
  followUp?: string
  /** Earlier turns of the chat, before the prompt. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** A small context window, so the run compacts as a small local model's would. */
  contextLength?: number
  setup?(root: string): void
  grade(root: string, result: AgentKernelScenarioResult): Promise<Record<string, boolean>>
}

function node(root: string, ...args: string[]): { ok: boolean; out: string } {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 60_000
  })
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}` }
}

function shellCommands(result: AgentKernelScenarioResult): string[] {
  return result.events
    .filter((event) => event.type === 'tool.running' && event.payload.name === 'shell')
    .map((event) => String((event.payload.arguments as { command?: string })?.command ?? ''))
}

const SCENARIOS: Scenario[] = [
  {
    name: 'fix-failing-test',
    files: {
      'package.json': '{ "name": "stats", "scripts": { "test": "node --test" } }\n',
      'src/stats.js':
        'function mean(values) {\n  if (values.length === 0) return 0\n  let total = 0\n  for (const value of values) total += value\n  return total / (values.length - 1)\n}\n\nfunction median(values) {\n  const sorted = [...values].sort()\n  const middle = Math.floor(sorted.length / 2)\n  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2\n}\n\nmodule.exports = { mean, median }\n',
      'test/stats.test.js':
        "const test = require('node:test')\nconst assert = require('node:assert')\nconst { mean, median } = require('../src/stats')\n\ntest('mean', () => assert.strictEqual(mean([2, 4, 6]), 4))\ntest('median of numbers above nine', () => assert.strictEqual(median([10, 9, 2]), 9))\n"
    },
    prompt:
      'The tests in this project fail. Find the bugs in src/stats.js, fix them, and run the tests to show they pass. Do not change the tests.',
    async grade(root, result) {
      const test = await fs.readFile(join(root, 'test/stats.test.js'), 'utf8')
      return {
        testsPass: node(root, '--test').ok,
        testsUntouched: test.includes('median([10, 9, 2]), 9'),
        ranTests: shellCommands(result).some((command) => /test/.test(command))
      }
    }
  },
  {
    name: 'long-job',
    files: {
      'bench.js':
        "let step = 0\nconst timer = setInterval(() => {\n  step++\n  console.log(`round ${step}/6`)\n  if (step === 6) {\n    clearInterval(timer)\n    console.log('score: 7781 ops/s')\n  }\n}, 7000)\n"
    },
    prompt:
      'Run `node bench.js`. It takes about 45 seconds. Tell me the final score when it finishes.',
    async grade(_root, result) {
      const commands = shellCommands(result)
      return {
        reportsScore: /7[,.]?781/.test(result.finalResponse ?? result.content),
        noSleepPolling: !commands.some((command) =>
          /Start-Sleep|\bsleep\b|timeout \/t/i.test(command)
        ),
        ranOnce: commands.filter((command) => /bench\.js/.test(command)).length === 1
      }
    }
  },
  {
    name: 'launcher-script',
    files: {
      'job.js':
        "const { writeFileSync } = require('fs')\nconsole.log('job started')\nsetTimeout(() => {\n  writeFileSync('result.txt', 'checksum 4f9a1c\\n')\n  console.log('job finished')\n}, 15000)\n",
      ...(windows
        ? {
            'start-job.ps1':
              '# Starts the job in the background and returns at once.\nStart-Process -NoNewWindow -FilePath node -ArgumentList job.js\nWrite-Output "job launched"\n'
          }
        : {
            'start-job.sh':
              '#!/bin/sh\n# Starts the job in the background and returns at once.\nnohup node job.js > job.log 2>&1 &\necho "job launched"\n'
          })
    },
    prompt: windows
      ? 'Run ./start-job.ps1 and tell me what result.txt contains once the job is done.'
      : 'Run sh start-job.sh and tell me what result.txt contains once the job is done.',
    async grade(_root, result) {
      return {
        reportsChecksum: /4f9a1c/.test(result.finalResponse ?? result.content)
      }
    }
  },
  {
    name: 'rename-across-files',
    files: {
      'src/users.js':
        'function fetchUser(id) {\n  return { id, name: `user-${id}` }\n}\n\nmodule.exports = { fetchUser }\n',
      'src/profile.js':
        "const { fetchUser } = require('./users')\n\nfunction profileTitle(id) {\n  return fetchUser(id).name.toUpperCase()\n}\n\nmodule.exports = { profileTitle }\n",
      'src/index.js':
        "const { fetchUser } = require('./users')\nconst { profileTitle } = require('./profile')\n\nconsole.log(fetchUser(7).name, profileTitle(7))\n",
      'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- Added fetchUser.\n'
    },
    prompt:
      'Rename the function fetchUser to loadUser everywhere in the code under src. Leave CHANGELOG.md as it is: it records history. Then run src/index.js to check it still works.',
    async grade(root) {
      const sources = await Promise.all(
        ['users', 'profile', 'index'].map((name) =>
          fs.readFile(join(root, `src/${name}.js`), 'utf8')
        )
      )
      const run = node(root, 'src/index.js')
      return {
        noOldName: sources.every((source) => !source.includes('fetchUser')),
        usesNewName: sources.every((source) => source.includes('loadUser')),
        stillRuns: run.ok && run.out.includes('user-7 USER-7'),
        changelogUntouched: (await fs.readFile(join(root, 'CHANGELOG.md'), 'utf8')).includes(
          'fetchUser'
        )
      }
    }
  },
  {
    name: 'csv-summary',
    files: {
      'sales.csv': (() => {
        const regions = ['north', 'south', 'east', 'west']
        const products = ['lamp', 'desk', 'chair']
        const rows = ['region,product,units,unit_price']
        for (let index = 0; index < 120; index++) {
          rows.push(
            `${regions[index % 4]},${products[(index * 7) % 3]},${(index % 9) + 1},${[12.5, 80, 45][(index * 7) % 3]}`
          )
        }
        return `${rows.join('\n')}\n`
      })()
    },
    prompt:
      'From sales.csv, write summary.json with two keys: "revenueByRegion", an object of total revenue (units times unit_price) per region rounded to two decimals, and "topProduct", the product with the most units sold. Compute it with a script rather than by hand.',
    async grade(root) {
      const csv = (await fs.readFile(join(root, 'sales.csv'), 'utf8')).trim().split('\n').slice(1)
      const revenue: Record<string, number> = {}
      const units: Record<string, number> = {}
      for (const line of csv) {
        const [region, product, count, price] = line.split(',')
        revenue[region] = (revenue[region] ?? 0) + Number(count) * Number(price)
        units[product] = (units[product] ?? 0) + Number(count)
      }
      const top = Object.entries(units).sort((a, b) => b[1] - a[1])[0][0]
      let summary: { revenueByRegion?: Record<string, number>; topProduct?: string } = {}
      try {
        summary = JSON.parse(await fs.readFile(join(root, 'summary.json'), 'utf8'))
      } catch {
        // Graded as missing below.
      }
      return {
        wroteSummary: Boolean(summary.revenueByRegion),
        revenueRight: Object.entries(revenue).every(
          ([region, total]) => Math.abs((summary.revenueByRegion?.[region] ?? -1) - total) < 0.01
        ),
        topProductRight: summary.topProduct === top
      }
    }
  },
  {
    name: 'server-lifecycle',
    files: {
      'server.js':
        "const http = require('http')\nconst port = Number(process.env.PORT || 4317)\nconsole.log('compiling routes...')\nsetTimeout(() => {\n  http\n    .createServer((request, response) => {\n      response.setHeader('content-type', 'application/json')\n      response.end(JSON.stringify(request.url === '/health' ? { status: 'ok', build: 'b-58213' } : { error: 'not found' }))\n    })\n    .listen(port, '127.0.0.1', () => console.log(`listening on http://127.0.0.1:${port}`))\n}, 6000)\n"
    },
    prompt:
      'Start the dev server with `node server.js` (it takes a few seconds to be ready), call its /health endpoint, tell me the build it reports, and stop the server when you are done.',
    async grade(_root, result) {
      const stillListening = await fetch('http://127.0.0.1:4317/health', {
        signal: AbortSignal.timeout(2_000)
      })
        .then(() => true)
        .catch(() => false)
      return {
        reportsBuild: /b-58213/.test(result.finalResponse ?? result.content),
        serverStopped: !stillListening
      }
    }
  },
  {
    name: 'interactive-prompt',
    files: {
      'migrate.js':
        "const readline = require('readline')\nconst { writeFileSync } = require('fs')\nconst rl = readline.createInterface({ input: process.stdin, output: process.stdout })\nconsole.log('3 migrations pending: add_users, add_orders, index_orders')\nrl.question('Apply all 3 migrations? [y/N] ', (answer) => {\n  if (answer.trim().toLowerCase() === 'y') {\n    writeFileSync('migrated.txt', 'add_users,add_orders,index_orders\\n')\n    console.log('applied 3 migrations')\n  } else console.log('aborted')\n  rl.close()\n})\n"
    },
    prompt:
      'Run `node migrate.js` and apply the migrations. Yes, I want all of them applied. Tell me which ones ran.',
    async grade(root, result) {
      const migrated = await fs.readFile(join(root, 'migrated.txt'), 'utf8').catch(() => '')
      return {
        applied: migrated.includes('index_orders'),
        reportsThem: /index_orders/.test(result.finalResponse ?? result.content)
      }
    }
  },
  {
    name: 'large-log',
    files: {
      'build.log': (() => {
        const lines: string[] = []
        for (let index = 1; index <= 40_000; index++) {
          lines.push(
            index === 31_337
              ? `[${index}] ERROR linker: undefined symbol 'gpu_fence_wait' (code E7731) in module render/vk_sync.o`
              : `[${index}] info  compiled unit ${index % 997} in ${(index * 13) % 400}ms`
          )
        }
        return `${lines.join('\n')}\n`
      })()
    },
    prompt:
      'build.log is a long build log with one error in it. What is the error code, which symbol is undefined, and in which module?',
    async grade(_root, result) {
      const reply = result.finalResponse ?? result.content
      return {
        code: /E7731/.test(reply),
        symbol: /gpu_fence_wait/.test(reply),
        module: /vk_sync/.test(reply)
      }
    }
  },
  {
    name: 'git-branch-commit',
    files: {
      'README.md': '# Widget\n\nA small widget.\n',
      'src/widget.js': "module.exports = function widget() {\n  return 'v1'\n}\n"
    },
    prompt:
      'This folder is a git repository. On a new branch named feature/v2, change src/widget.js to return v2 instead of v1 and commit it with the message "Return v2 from widget". Leave main as it is. Then tell me the short hash of the new commit.',
    setup(root) {
      const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      git('init', '--quiet', '--initial-branch=main')
      git('-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', 'add', '-A')
      git(
        '-c',
        'user.name=Eval',
        '-c',
        'user.email=eval@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Initial'
      )
      git('config', 'user.name', 'Eval')
      git('config', 'user.email', 'eval@example.invalid')
    },
    async grade(root, result) {
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim()
      const hash = git('rev-parse', '--short', 'feature/v2')
      return {
        branchExists: Boolean(hash) && !hash.includes('fatal'),
        committed: git('log', '-1', '--format=%s', 'feature/v2') === 'Return v2 from widget',
        mainUntouched: git('show', 'main:src/widget.js').includes("'v1'"),
        reportsHash:
          Boolean(hash) && (result.finalResponse ?? result.content).includes(hash.slice(0, 7))
      }
    }
  },
  {
    name: 'web-research',
    webSearch: true,
    files: {},
    prompt:
      'Look up on the web the latest published version of the npm package "semver" and the year its repository was created on GitHub. Cite where you found each.',
    async grade(_root, result) {
      const latest = await fetch('https://registry.npmjs.org/semver/latest', {
        signal: AbortSignal.timeout(15_000)
      })
        .then((response) => response.json() as Promise<{ version?: string }>)
        .then((body) => body.version ?? '')
        .catch(() => '')
      const reply = result.finalResponse ?? result.content
      return {
        latestVersion: Boolean(latest) && reply.includes(latest),
        citesSource: /https?:\/\//.test(reply)
      }
    }
  },
  {
    name: 'multi-turn-revision',
    files: {
      'package.json': '{ "name": "temps", "scripts": { "test": "node --test" } }\n'
    },
    prompt:
      'Create src/convert.js exporting celsiusToFahrenheit(c), and a test in test/convert.test.js with node:test. Run the tests.',
    followUp:
      'Thanks. Rename it to toFahrenheit, make it round to one decimal place, and add fahrenheitToCelsius with the same rounding. Update the tests to cover both and run them again.',
    async grade(root) {
      const source = await fs.readFile(join(root, 'src/convert.js'), 'utf8').catch(() => '')
      const probe = node(
        root,
        '-e',
        "const m = require('./src/convert.js'); console.log(m.toFahrenheit(21.3), m.fahrenheitToCelsius(70.1), typeof m.celsiusToFahrenheit)"
      )
      return {
        renamed: source.includes('toFahrenheit') && !source.includes('celsiusToFahrenheit'),
        rounds: probe.ok && probe.out.trim().startsWith('70.3 21.2'),
        oldNameGone: probe.out.includes('undefined'),
        testsPass: node(root, '--test').ok
      }
    }
  },
  {
    name: 'large-file-edit',
    files: {
      'src/generated.js': (() => {
        const lines: string[] = []
        for (let index = 0; index < 1_500; index++) {
          lines.push(`function helper${index}(value) {`, `  return value + ${index}`, '}', '')
        }
        lines[3_000] = 'function helper750(value) {'
        lines[3_001] = '  return value + 750'
        lines.push('module.exports = { helper750, helper1499 }')
        return `${lines.join('\n')}\n`
      })()
    },
    prompt:
      'In src/generated.js, change helper750 so it returns value * 750 instead of value + 750. Change nothing else, then check it with node.',
    async grade(root) {
      const source = await fs.readFile(join(root, 'src/generated.js'), 'utf8')
      const run = node(
        root,
        '-e',
        "const m = require('./src/generated.js'); console.log(m.helper750(2), m.helper1499(1))"
      )
      return {
        changed: run.ok && run.out.trim() === '1500 1500',
        restIntact:
          source.split('\n').length === 6_002 &&
          source.includes('return value + 749') &&
          source.includes('return value + 751')
      }
    }
  },
  {
    name: 'crlf-accents',
    files: {
      'notas.md':
        '# Notas de la reunión\r\n\r\n- Presupuesto: aprobado ✅\r\n- Próxima reunión: martes\r\n- Responsable: José Muñoz\r\n'
    },
    prompt:
      'In notas.md, change the next meeting from martes to jueves and add a line "- Lugar: sala Ñandú" at the end. Keep everything else as it is.',
    async grade(root) {
      const raw = await fs.readFile(join(root, 'notas.md'))
      const text = raw.toString('utf8')
      return {
        edited: text.includes('jueves') && !text.includes('martes') && text.includes('sala Ñandú'),
        accentsKept: text.includes('reunión') && text.includes('José Muñoz') && text.includes('✅'),
        crlfKept: !/[^\r]\n/.test(text.replace(/\n$/, '')) && text.includes('\r\n'),
        noBom: raw[0] !== 0xef
      }
    }
  },
  {
    name: 'compaction-small-window',
    contextLength: 24_576,
    maxToolRounds: 40,
    files: (() => {
      const files: Record<string, string> = {
        'README.md': '# Ledger tools\n\nInternal helpers. Do not edit this file.\n'
      }
      for (const [index, name] of [
        'parse',
        'format',
        'merge',
        'audit',
        'export',
        'hash'
      ].entries()) {
        const body: string[] = [`// ${name} module: helpers for ledger ${name} work.`]
        for (let line = 0; line < 90; line++) {
          body.push(
            `function ${name}Step${line}(entry) {`,
            `  // Normalizes field ${line} of a ledger entry for the ${name} stage.`,
            `  return { ...entry, f${line}: String(entry.f${line} ?? '').trim() }`,
            '}'
          )
        }
        if (name === 'hash') {
          body.push(
            '/** */',
            'function computeChecksum(text) {',
            '  let value = 0x811c9dc5',
            '  for (const char of text) {',
            '    value ^= char.charCodeAt(0)',
            '    value = Math.imul(value, 0x01000193) >>> 0',
            '  }',
            "  return value.toString(16).padStart(8, '0')",
            '}',
            'module.exports = { computeChecksum }'
          )
        }
        files[`src/${index}-${name}.js`] = `${body.join('\n')}\n`
      }
      return files
    })(),
    history: [
      {
        role: 'user',
        content: 'Which file in src handles parsing? Never edit README.md, by the way.'
      },
      {
        role: 'assistant',
        content: 'src/0-parse.js holds the parse helpers. Understood: I will not edit README.md.'
      }
    ],
    prompt:
      'For every module in src, read it and tell me the name of the last function it defines. One of them also exports computeChecksum: tell me which hash algorithm that implements and how many characters its output has, and replace the empty /** */ above it with a short JSDoc comment saying that.',
    async grade(root, result) {
      const hash = await fs.readFile(join(root, 'src/5-hash.js'), 'utf8')
      const readme = await fs.readFile(join(root, 'README.md'), 'utf8')
      const reply = result.finalResponse ?? result.content
      const doc = /\/\*\*[\s\S]*?\*\/\s*function computeChecksum/.exec(hash)?.[0] ?? ''
      const lastFunctions = ['parse', 'format', 'merge', 'audit', 'export'].map(
        (name) => `${name}Step89`
      )
      return {
        listsEveryModule: lastFunctions.every((name) => reply.includes(name)),
        answersCurrentQuestion: /fnv/i.test(reply) && /\b8\b/.test(reply),
        documented: /fnv/i.test(doc),
        readmeUntouched:
          readme.includes('Do not edit this file.') && readme.split('\n').length === 4,
        stillRuns:
          node(
            root,
            '-e',
            "console.log(require('./src/5-hash.js').computeChecksum('a'))"
          ).out.trim() === 'e40c292c'
      }
    }
  }
]

function systemPrompt(workspaceRoot: string, model: string, webSearch = false): string {
  const tools = getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot,
    webSearchEnabled: webSearch,
    browserEnabled: false
  })
  return new PromptComposer().compose({
    platform: windows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    capabilities: capabilitiesFromTools(tools),
    permissionMode: 'full-access',
    model: createPromptModelProfile({
      id: `openrouter:${model}`,
      name: model,
      provider: 'openrouter',
      providerKind: 'openrouter',
      providerModelId: model
    }),
    project: { workspaceRoot, instructions: '', instructionSources: [], memory: '' },
    currentDate: new Intl.DateTimeFormat('en-US', { dateStyle: 'full' }).format(new Date()),
    toolRoundLimit: 40,
    activeSkillIds: [],
    skillAssetsPath: null
  }).content
}

function summarize(events: AgentRunEvent[]): Pick<Outcome, 'toolErrors' | 'retries'> {
  return {
    toolErrors: events
      .filter(
        (event) =>
          event.type === 'tool.completed' &&
          (event.payload.result as { status?: string } | undefined)?.status !== 'success'
      )
      .map((event) => {
        const result = event.payload.result as
          | { status?: string; error?: { code?: string; message?: string } }
          | undefined
        return `${String(event.payload.name)}: ${result?.error?.code ?? result?.status} ${String(result?.error?.message ?? '').slice(0, 200)}`
      }),
    retries: events
      .filter((event) => event.type === 'run.retrying')
      .map((event) => String(event.payload.reason ?? ''))
  }
}

const DEBRIEF =
  'The task is over; do not continue it. This conversation was a test of SideKick, the app that ran your tools. ' +
  'Looking back at this run only, list anything in the tooling that got in your way: a tool result that was wrong, ' +
  'confusing, cut short or contradicted another; an error you could not act on; a tool description that misled you; ' +
  'a tool you needed and did not have; anything SideKick said that you did not understand. Quote the tool result ' +
  'you mean. Do not report mistakes that were only yours, and do not guess. Answer with JSON only: ' +
  '{"issues": [{"tool": "...", "what": "...", "quote": "..."}]}, with an empty list if nothing got in your way.'

/** Asks the model, with tools off, what in the tooling got in its way during the run. */
async function debrief(model: string, result: AgentKernelScenarioResult): Promise<unknown> {
  const reply = await completeOpenAICompatibleChat(
    endpoint,
    {
      model,
      messages: [
        ...toOpenAICompatibleMessages(result.messages),
        { role: 'user', content: DEBRIEF }
      ],
      tools: getAgentToolDefinitions({ surface: 'conversation', workspaceRoot: 'project' }),
      tool_choice: 'none',
      max_tokens: 2_048
    },
    headers,
    fetch,
    AbortSignal.timeout(180_000)
  )
  if (!reply.ok) return { error: reply.error }
  const text = reply.data?.message.content ?? ''
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  try {
    return json ? JSON.parse(json) : { text }
  } catch {
    return { text: text.slice(0, 2_000) }
  }
}

afterAll(async () => {
  if (!enabled) return
  const reportPath = process.env.SIDEKICK_REALWORLD_REPORT?.trim()
  if (reportPath) {
    await fs.mkdir(dirname(resolve(reportPath)), { recursive: true })
    await fs.writeFile(resolve(reportPath), `${JSON.stringify(outcomes, null, 2)}\n`)
  }
  for (const outcome of outcomes) {
    console.info(
      `[realworld] ${outcome.pass ? 'PASS' : 'FAIL'} ${outcome.model} ${outcome.scenario} ${JSON.stringify(outcome.checks)} rounds=${outcome.toolRounds} ${outcome.seconds}s`
    )
  }
})

const liveDescribe = enabled ? describe.sequential : describe.skip

liveDescribe('real-world agent scenarios', () => {
  for (const model of models) {
    for (const scenario of SCENARIOS.filter(
      (candidate) => !only || only.includes(candidate.name)
    )) {
      it(`${model} ${scenario.name}`, async () => {
        const scenarioRoot = await fs.mkdtemp(
          join(tmpdir(), `sidekick-realworld-${scenario.name}-`)
        )
        const workspaceRoot = join(scenarioRoot, 'project')
        const harness = new AgentScenarioHarness(join(scenarioRoot, 'runtime'), {
          endpoint,
          model,
          headers,
          providerKind: 'openrouter',
          maxOutputTokens: 8_192,
          requestTimeoutMs: 180_000,
          temperature: null,
          terminal: true
        })
        const started = Date.now()
        try {
          for (const [path, content] of Object.entries(scenario.files)) {
            await fs.mkdir(dirname(join(workspaceRoot, path)), { recursive: true })
            await fs.writeFile(join(workspaceRoot, path), content)
          }
          scenario.setup?.(workspaceRoot)
          await harness.initialize()
          let compactions = 0
          const contextManager = scenario.contextLength
            ? new AgentContextManager({
                target: { providerKind: 'openrouter', model },
                contextLength: scenario.contextLength,
                maxOutputTokens: 4_096,
                threshold: 0.65,
                enabled: true,
                complete: (request, signal) =>
                  completeOpenAICompatibleChat(
                    endpoint,
                    {
                      model,
                      messages: toOpenAICompatibleMessages(request.messages),
                      max_tokens: request.maxOutputTokens
                    },
                    headers,
                    fetch,
                    signal
                  ),
                onCompacted: () => compactions++
              })
            : undefined
          const threadId = `thread-${scenario.name}`
          const first = await harness.run({
            threadId,
            workspaceRoot,
            maxToolRounds: scenario.maxToolRounds ?? 30,
            webSearchEnabled: scenario.webSearch === true,
            contextManager,
            messages: [
              {
                role: 'system',
                content: systemPrompt(workspaceRoot, model, scenario.webSearch === true)
              },
              ...(scenario.history ?? []),
              { role: 'user', content: scenario.prompt }
            ]
          })
          const result =
            scenario.followUp && first.phase === 'completed'
              ? await harness.run({
                  threadId,
                  workspaceRoot,
                  maxToolRounds: scenario.maxToolRounds ?? 30,
                  webSearchEnabled: scenario.webSearch === true,
                  messages: [...first.messages, { role: 'user', content: scenario.followUp }]
                })
              : first
          const checks = await scenario.grade(workspaceRoot, result)
          const pass = result.phase === 'completed' && Object.values(checks).every(Boolean)
          outcomes.push({
            model,
            scenario: scenario.name,
            pass,
            checks,
            phase: result.phase,
            ...(result.error ? { error: result.error } : {}),
            toolRounds: result.toolRounds,
            tools: result.toolNames,
            ...summarize(result.events),
            seconds: Math.round((Date.now() - started) / 1000),
            reply: (result.finalResponse ?? result.content).slice(0, 600),
            debrief: await debrief(model, result),
            ...(scenario.contextLength ? { compactions } : {})
          })
          // The whole exchange, to check what the debrief claims against what happened.
          const transcripts = process.env.SIDEKICK_REALWORLD_TRANSCRIPTS?.trim()
          if (transcripts) {
            await fs.mkdir(resolve(transcripts), { recursive: true })
            await fs.writeFile(
              join(
                resolve(transcripts),
                `${scenario.name}--${model.replace(/[^\w.-]+/g, '_')}.json`
              ),
              JSON.stringify(result.messages, null, 1)
            )
          }
          expect.soft(pass, JSON.stringify(checks)).toBe(true)
        } finally {
          await harness.close()
          await fs.rm(scenarioRoot, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200
          })
        }
      }, 900_000)
    }
  }
})
