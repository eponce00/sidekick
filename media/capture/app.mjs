// Launches the built SideKick app in a throwaway profile, connected to the fake model, with a small
// demo project to work in. Nothing touches the user's own SideKick data.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(ROOT, 'package.json'))
const { _electron: electron } = require('playwright')

export const MODEL = 'sidekick-demo'
const PROVIDER = 'demo-provider'
const MODEL_REF = `lmstudio:${PROVIDER}/${MODEL}`
export const WINDOW = { width: 1280, height: 800 }
// Marks the demo project, so a later run only ever replaces its own folder.
const DEMO_MARKER = '.sidekick-media-demo'
// Drawn at twice the size, so the recording stays sharp when the compositions zoom in.
export const SCALE = 2

/** A small project with one real bug, so the agent's work in the recording is believable. */
function createDemoProject(folder) {
  mkdirSync(join(folder, 'src'), { recursive: true })
  const files = {
    'package.json':
      JSON.stringify(
        {
          name: 'weather-station',
          version: '1.2.0',
          type: 'module',
          scripts: { test: 'node test.js' }
        },
        null,
        2
      ) + '\n',
    'README.md': '# Weather Station\n\nA small dashboard for the backyard weather station.\n',
    'src/forecast.js': [
      '// Formats a temperature reading for the forecast card.',
      'export function formatTemperature(celsius, unit) {',
      '  const fahrenheit = (celsius * 9) / 5 + 32',
      '  return `${Math.round(fahrenheit)}°F`',
      '}',
      '',
      'export function describe(reading, unit) {',
      '  return `${reading.label}: ${formatTemperature(reading.celsius, unit)}`',
      '}',
      ''
    ].join('\n'),
    'src/units.js': "export const UNITS = ['C', 'F']\nexport const DEFAULT_UNIT = 'C'\n",
    'test.js': [
      "import { formatTemperature } from './src/forecast.js'",
      '',
      'const cases = [',
      "  ['21 °C in Celsius', formatTemperature(21, 'C'), '21°C'],",
      "  ['21 °C in Fahrenheit', formatTemperature(21, 'F'), '70°F'],",
      "  ['-4 °C in Celsius', formatTemperature(-4, 'C'), '-4°C']",
      ']',
      'let failed = 0',
      'for (const [name, actual, expected] of cases) {',
      '  const ok = actual === expected',
      '  if (!ok) failed += 1',
      "  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — expected ${expected}, got ${actual}`}`)",
      '}',
      "console.log(failed ? `\\n${failed} failing` : '\\nAll 3 passing')",
      'process.exit(failed ? 1 : 0)',
      ''
    ].join('\n')
  }
  for (const [path, content] of Object.entries(files)) writeFileSync(join(folder, path), content)
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'user.name=SideKick',
    '-c',
    'user.email=demo@example.invalid',
    'commit',
    '-qm',
    'Weather station'
  )
}

/** Starts the app; returns the window, the Electron app, and the demo project's id. */
export async function launchApp({ modelUrl, videoDir }) {
  const profile = mkdtempSync(join(tmpdir(), 'sidekick-e2e-media-'))
  // Its path shows in the recordings, so it is one with no one's name in it.
  const project =
    process.platform === 'win32'
      ? 'C:\\Users\\Public\\weather-station'
      : join(tmpdir(), 'weather-station')
  if (existsSync(join(project, '.git', DEMO_MARKER)))
    rmSync(project, { recursive: true, force: true })
  if (existsSync(project)) throw new Error(`${project} exists and is not the demo project`)
  mkdirSync(project)
  createDemoProject(project)
  writeFileSync(join(project, '.git', DEMO_MARKER), '')
  const app = await electron.launch({
    args: [ROOT, '--disable-gpu', '--sidekick-e2e', `--force-device-scale-factor=${SCALE}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SIDEKICK_E2E_USER_DATA_DIR: profile,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    ...(videoDir ? { recordVideo: { dir: videoDir, size: WINDOW } } : {}),
    timeout: 60_000
  })
  app.process().stderr?.on('data', (d) => process.env.MEDIA_DEBUG && process.stderr.write(d))
  app.process().stdout?.on('data', (d) => process.env.MEDIA_DEBUG && process.stdout.write(d))
  const page = await app.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean(window.api?.settings))
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setContentSize(size.width, size.height)
    window?.center()
  }, WINDOW)
  const projectId = await page.evaluate(
    async ({ baseUrl, model, provider, ref, project }) => {
      const limits = { contextLength: 131072, maxOutputTokens: 16384 }
      await window.api.settings.save({
        providerInstances: [
          {
            id: provider,
            name: 'Local model',
            type: 'openai-compatible',
            preset: 'generic',
            enabled: true,
            baseUrl,
            modelSource: 'manual',
            models: [
              {
                id: model,
                enabled: true,
                supportsTools: true,
                supportsVision: false,
                ...limits,
                metadataOverrides: limits
              }
            ]
          }
        ],
        selectedModel: ref,
        commandPermissionMode: 'full-access',
        notificationsEnabled: false
      })
      return (await window.api.projects.create(project, 'weather-station')).id
    },
    { baseUrl: modelUrl, model: MODEL, provider: PROVIDER, ref: MODEL_REF, project }
  )
  await page.reload()
  await page.waitForFunction(() => Boolean(window.api?.settings))
  return { app, page, projectId, profile, project }
}
