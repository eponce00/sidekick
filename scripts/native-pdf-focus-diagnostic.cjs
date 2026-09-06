// Opt-in, synthetic fixtures only. Production sources are bundled read-only.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const { build } = require('esbuild')
const { createHash } = require('node:crypto')

async function main() {
  if (process.env.SIDEKICK_PDF_FOCUS_DIAGNOSTIC !== '1') throw new Error('Explicit opt-in required')
  const root = path.resolve(process.argv[2])
  const count = Number(process.argv[3] ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Run count must be 1–10')
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  let source = fs
    .readFileSync(path.join(root, 'src/main/services/nativeBrowserSessionService.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
  function replaceOnce(from, to) {
    if (source.split(from).length !== 2) throw new Error('Diagnostic source anchor changed')
    source = source.replace(from, to)
  }
  replaceOnce(
    'class ElectronNativeBrowserSurface implements NativeBrowserSurface {',
    `class ElectronNativeBrowserSurface implements NativeBrowserSurface {
    fixtureWindowState() {
      return { attached: this.attached, windowFocused: this.ownerWindow?.isFocused() ?? null,
        windowVisible: this.ownerWindow?.isVisible() ?? null,
        windowFocusable: this.ownerWindow?.isFocusable() ?? null, contentsFocused: this.contents.isFocused() };
    }`
  )
  replaceOnce(
    '`function() {\n              return {\n                connected:',
    `\`function(clickX, clickY) {
              const r = this.getBoundingClientRect();
              const hit = document.elementFromPoint(clickX, clickY);
              return {
                geometry: { rect: { x:r.x, y:r.y, width:r.width, height:r.height },
                  clickpoint: {x:clickX,y:clickY},
                  viewport: {width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio},
                  hitIsTarget:hit===this,hitInsideTarget:hit ? this.contains(hit) : false,
                  hitExists:hit!==null, activeIsBody:document.activeElement===document.body,
                  mainFrame:window===window.top, ownerMatches:this.ownerDocument===document },
                connected:`
  )
  replaceOnce(
    '                [],\n                diagnosticSignal',
    '                [target.x, target.y],\n                diagnosticSignal'
  )
  replaceOnce(
    "console.warn('[NativeBrowser] Text entry failure diagnostics', {",
    `console.warn('[NativeBrowser] Text entry failure diagnostics', {
          fixtureGeometry: (state as any)?.geometry ?? null,
          fixtureWindow: (tab.surface as any).fixtureWindowState?.() ?? null,
          sourceRefEpoch, currentRefEpoch:tab.refEpoch,`
  )
  const sha256 = (value) => createHash('sha256').update(value).digest('hex')
  const sourceHashes = Object.fromEntries(
    [
      'src/main/services/nativeBrowserSessionService.ts',
      'src/main/services/browserTextFocus.ts',
      'scripts/native-browser-reliability.entry.ts'
    ].map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))])
  )
  console.log(
    JSON.stringify({
      gitHeadNotExecutionIdentity: revision,
      sourceHashes,
      instrumentedServiceSha256: sha256(source),
      diagnosticRunnerSha256: sha256(fs.readFileSync(__filename))
    })
  )
  if (process.argv.includes('--inspect-only')) return
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-native-pdf-focus-'))
  const bundle = path.join(temporary, 'fixture.cjs')
  const outcomes = []
  try {
    await build({
      entryPoints: [path.join(root, 'scripts/native-browser-reliability.entry.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      packages: 'external',
      external: ['electron'],
      loader: { '.md': 'text' },
      banner: {
        js: `require = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});`
      },
      logLevel: 'silent',
      plugins: [
        {
          name: 'failure-only-diagnostic',
          setup(builder) {
            builder.onLoad({ filter: /nativeBrowserSessionService\.ts$/ }, () => ({
              contents: source,
              loader: 'ts',
              resolveDir: path.join(root, 'src/main/services')
            }))
          }
        }
      ]
    })
    console.log(
      JSON.stringify({
        revision,
        count,
        instrumentation: 'failure-only read-only geometry; original assertions and input unchanged'
      })
    )
    for (let attempt = 1; attempt <= count; attempt++) {
      const env = {
        ...process.env,
        SIDEKICK_BROWSER_FIXTURE_ONLY: '1',
        SIDEKICK_NATIVE_BROWSER_SMOKE_ROOT: path.join(temporary, `runtime-${attempt}`),
        NODE_PATH: path.join(root, 'node_modules')
      }
      delete env.ELECTRON_RUN_AS_NODE
      const start = Date.now()
      const child = spawn(require(path.join(root, 'node_modules/electron')), [bundle], {
        cwd: root,
        env,
        windowsHide: true
      })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      const timer = setTimeout(() => child.kill(), 120000)
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      }).finally(() => clearTimeout(timer))
      const structured = output
        .split(/\r?\n/)
        .find((line) => line.startsWith('SIDEKICK_NATIVE_BROWSER_SMOKE='))
      const outcome = {
        attempt,
        passed: result.code === 0 && !!structured,
        code: result.code,
        signal: result.signal,
        elapsedMs: Date.now() - start
      }
      outcomes.push(outcome)
      console.log(JSON.stringify(outcome))
      if (!outcome.passed) {
        // Only synthetic value-free diagnostic blocks, never raw page or error output.
        const diagnostic =
          output.match(/\[NativeBrowser\] Text entry failure diagnostics \{[\s\S]*?\n\}/g) ?? []
        diagnostic.forEach((block) => console.log(block))
        console.log(
          JSON.stringify({
            diagnosticBlocks: diagnostic.length,
            directFillAssertion: output.includes(
              'Multi-page fixture controls must support direct native fill'
            )
          })
        )
        break
      }
    }
  } finally {
    if (
      path.dirname(temporary) !== path.resolve(os.tmpdir()) ||
      !path.basename(temporary).startsWith('sidekick-native-pdf-focus-')
    )
      throw new Error('Unexpected temporary cleanup target')
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  console.log(
    JSON.stringify({
      attempts: outcomes.length,
      passed: outcomes.filter((x) => x.passed).length,
      failed: outcomes.filter((x) => !x.passed).length,
      temporaryRemoved: !fs.existsSync(temporary)
    })
  )
  if (outcomes.some((x) => !x.passed)) process.exitCode = 1
}
main().catch(() => {
  console.error('Synthetic focus diagnostic failed')
  process.exitCode = 1
})
