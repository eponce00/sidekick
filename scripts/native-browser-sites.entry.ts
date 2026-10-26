// Real-site browser flows for a real model: each opens a public page, asks for a task that
// needs a picker, a typeahead or a date, and checks the page or the answer afterwards. Nothing
// is submitted, bought or signed into. One scenario runs per process, named by
// SIDEKICK_SITE_SCENARIO, so a stuck run can be stopped without losing the others.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, webContents } from 'electron'
import {
  registerArtifactScheme,
  installArtifactProtocol
} from '../src/main/bootstrap/artifactProtocol'
import { NativeBrowserSessionService } from '../src/main/services/nativeBrowserSessionService'
import { AgentScenarioHarness } from '../src/main/evals/agentScenarioHarness'
import { openAICompatibleHeaders } from '../src/main/providers/openAICompatibleClient'
import { getAgentToolDefinitions } from '../src/shared/agentToolCatalog'
import { PromptComposer, capabilitiesFromTools, detectHostPlatform } from '../src/shared/prompts'

app.on('window-all-closed', () => undefined)
registerArtifactScheme()

interface Scenario {
  url: string
  /** The host the flow ends on, when it leaves the one it starts on. */
  host?: string
  task: string
  /** Page code run in the final tab; its result is reported and must be truthy to pass. */
  page?: string
  answer?: RegExp
}

const SCENARIOS: Record<string, Scenario> = {
  wikipedia: {
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    task: "Using Wikipedia's search box and its suggestions, open the article about Ada Lovelace and tell me her date of birth.",
    page: `location.pathname === '/wiki/Ada_Lovelace'`,
    answer: /10 December,? 1815|December 10,? 1815/i
  },
  'react-select': {
    url: 'https://react-select.com/home',
    task: 'In the multi-select example on this page (the one that starts with Purple and Red chosen), make it hold exactly the colours Ocean and Purple, and nothing else.',
    page: `(() => { const box = document.querySelector('.select__multi-value')?.closest('[class*="ValueContainer"], .select__value-container'); const chips = box ? [...box.querySelectorAll('.select__multi-value__label')].map((node) => node.textContent.trim()).sort() : []; return JSON.stringify(chips) === JSON.stringify(['Ocean', 'Purple']) ? chips : false })()`
  },
  mui: {
    url: 'https://mui.com/material-ui/react-autocomplete/',
    task: "In the first demo on this page, the 'Combo box' movie picker, choose The Godfather: Part II.",
    page: `document.querySelector('input[role=combobox]')?.value === 'The Godfather: Part II'`
  },
  timeanddate: {
    url: 'https://www.timeanddate.com/date/duration.html',
    task: 'Use this calculator to find how many days there are from 14 November 2026 to 16 March 2027, not counting the end date. Tell me the number.',
    answer: /\b122\b/
  },
  'google-flights': {
    url: 'https://www.google.com/travel/flights',
    task: 'Search for round-trip flights from Toronto to Tokyo, leaving 14 November 2026 and returning 28 November 2026, for 1 adult in economy. Tell me the price of the cheapest flight listed. Do not book anything.',
    page: `(() => { const text = document.body.innerText + ' ' + [...document.querySelectorAll('input')].map((input) => input.value).join(' '); return /Tokyo/.test(text) && /Nov 14/.test(text) && /Nov 28/.test(text) && /flights\\/search|tfs=/.test(location.href) })()`,
    answer: /\$\s?\d|CA\$|\d+\s?(CAD|USD)/
  },
  weather: {
    url: 'https://www.weather.gov',
    task: "Use this site's location search to get the forecast for Denver, Colorado, and tell me the temperature it forecasts for today or tonight.",
    page: `location.host === 'forecast.weather.gov' && /Denver/i.test(document.body.innerText)`
  },
  select2: {
    url: 'https://select2.org/getting-started/basic-usage',
    task: 'In the first Select2 example on this page, the single-select Select2 box of US states (not the plain select above it), choose Hawaii.',
    page: `document.querySelector('.js-example-basic-single')?.value === 'HI'`
  },
  'github-branch': {
    url: 'https://github.com/microsoft/playwright',
    task: "Use the repository's branch picker to switch to the branch named release-1.40, and tell me the message of the latest commit on it.",
    page: `/\\/(tree|commits?)\\/(release-1\\.40|[0-9a-f]{7,40})/.test(location.pathname) && /release-1\\.40/.test(document.body.innerText + location.href)`
  },
  'wikipedia-language': {
    url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    host: 'wikipedia.org',
    task: "Use the article's language picker to open this article in French, and tell me the French article's title.",
    page: `location.host === 'fr.wikipedia.org'`
  },
  booking: {
    url: 'https://www.booking.com',
    task: 'Search for stays in Lisbon, Portugal, checking in 14 November 2026 and checking out 16 November 2026, for 2 adults. Tell me how many properties the results say were found. Do not book or sign in.',
    page: `/searchresults/.test(location.pathname) && /checkin=2026-11-14/.test(location.search) && /checkout=2026-11-16/.test(location.search) && /lisbon|lisboa/i.test(decodeURIComponent(location.search))`
  },
  flatpickr: {
    url: 'https://flatpickr.js.org/examples/',
    task: 'In the first example on this page (Basic), set the date to 14 November 2026.',
    page: `(() => { const picker = document.querySelector('.flatpickr-input')?._flatpickr; const at = picker?.selectedDates?.[0]; return Boolean(at && at.getFullYear() === 2026 && at.getMonth() === 10 && at.getDate() === 14) })()`
  }
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 240)

async function main(): Promise<void> {
  const root = process.env.SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT!
  const name = process.env.SIDEKICK_SITE_SCENARIO!
  const scenario = SCENARIOS[name]
  assert.ok(root && scenario, `unknown scenario ${name}`)
  app.setPath('userData', join(root, 'profile'))
  await app.whenReady()
  await installArtifactProtocol()
  const browser = new NativeBrowserSessionService({ artifactRoot: join(root, 'browser') })
  const workspaceRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  const model = process.env.SIDEKICK_AGENT_EVAL_MODEL || 'local-loaded-model'
  const tools = getAgentToolDefinitions({
    surface: 'conversation',
    workspaceRoot,
    capabilities: ['browser']
  })
  const system = new PromptComposer().compose({
    platform: detectHostPlatform(process.platform),
    capabilities: capabilitiesFromTools(tools),
    permissionMode: 'full-access',
    model: {
      family: 'qwen',
      provider: 'litellm',
      providerKind: 'litellm',
      modelId: model,
      displayName: model,
      instructionStyle: 'compact-structured'
    },
    project: { workspaceRoot, instructions: '', instructionSources: [], memory: '' },
    currentDate: new Date().toISOString().slice(0, 10),
    toolRoundLimit: 40,
    activeSkillIds: [],
    skillAssetsPath: join(root, 'skills')
  }).content
  const harness = new AgentScenarioHarness(join(root, 'runtime'), {
    endpoint: process.env.SIDEKICK_AGENT_EVAL_URL!,
    model,
    headers: openAICompatibleHeaders(process.env.SIDEKICK_AGENT_EVAL_API_KEY!),
    browser,
    maxOutputTokens: 4096
  })
  const started = performance.now()
  const report: Record<string, unknown> = { scenario: name }
  try {
    await harness.initialize()
    const result = await harness.run({
      workspaceRoot,
      threadId: name,
      capabilities: ['browser'],
      maxToolRounds: 40,
      // Each tool as it starts and ends, so a run stopped for time shows where it was.
      onEvent: (event) => {
        if (event.type !== 'tool.running' && event.type !== 'tool.completed') return
        const payload = event.payload as { name?: string; arguments?: unknown }
        console.log(
          'SIDEKICK_SITE_EVENT=' +
            JSON.stringify({
              at: Math.round(performance.now() - started),
              type: event.type,
              name: payload.name,
              ...(event.type === 'tool.running'
                ? { arguments: JSON.stringify(payload.arguments ?? '').slice(0, 200) }
                : {})
            })
        )
      },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `Open ${scenario.url}. ${scenario.task} Leave the browser open when you are done.`
        }
      ]
    })
    const answer = result.finalResponse ?? result.content ?? ''
    // Read straight from the page, not through the tool under test, so two builds are scored
    // alike even where one of them cannot evaluate script on the page.
    const host = scenario.host ?? new URL(scenario.url).host.replace(/^www\./, '')
    const tab = webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.getURL().includes(host))
      .at(-1)
    const page: unknown =
      scenario.page && tab
        ? await tab.executeJavaScript(scenario.page).catch((error) => `error: ${message(error)}`)
        : null
    const passed =
      (!scenario.page || (Boolean(page) && !String(page).startsWith('error:'))) &&
      (!scenario.answer || scenario.answer.test(answer))
    Object.assign(report, {
      passed,
      phase: result.phase,
      page,
      answer: answer.replace(/\s+/g, ' ').slice(0, 300),
      toolCalls: result.toolNames.length,
      // Each tool call that failed, with what it said, to see where the agent had to recover.
      failures: result.events
        .filter((event) => event.type === 'tool.completed')
        .map(
          (event) =>
            event.payload as {
              name?: string
              result?: { ok?: boolean; status?: string; error?: { message?: string } }
            }
        )
        .filter(
          (payload) =>
            payload.result?.ok === false ||
            payload.result?.status === 'error' ||
            payload.result?.error
        )
        .map(
          (payload) =>
            `${payload.name}: ${String(payload.result?.error?.message ?? '').slice(0, 160)}`
        ),
      tools: Object.entries(
        result.toolNames.reduce<Record<string, number>>(
          (count, tool) => ({ ...count, [tool]: (count[tool] ?? 0) + 1 }),
          {}
        )
      )
        .map(([tool, count]) => `${tool}×${count}`)
        .join(' ')
    })
  } catch (error) {
    Object.assign(report, { passed: false, phase: 'error', error: message(error) })
  } finally {
    report.elapsedMs = Math.round(performance.now() - started)
    await harness.close().catch(() => undefined)
    await browser.dispose().catch(() => undefined)
  }
  console.log('SIDEKICK_SITE_RESULT=' + JSON.stringify(report))
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(message(error))
    app.exit(1)
  })
